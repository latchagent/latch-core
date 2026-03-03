# Budgets, SLOs & Leak Detection — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-session spend limits with kill/extend enforcement, daily project budgets, SLO tracking, and real-time credential leak detection that surfaces alerts through the existing LiveEvent/Feed/Radar channels.

**Architecture:** Two new main-process modules — `budget-enforcer.ts` (subscribes to usage events, maintains running cost maps, emits warnings at 80% and confirm dialogs at 100%) and `leak-scanner.ts` (pure computation, scans strings for 8 credential patterns including Shannon entropy). Budget config lives in Settings (global defaults) with per-session overrides. Leak scanner hooks into the live-tailer's JSONL parsing.

**Tech Stack:** TypeScript, existing usage-event pipeline, settings-store, live-tailer, feed-store, radar, pty-manager.

---

### Task 1: Add Types

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Add BudgetAlert and LeakMatch interfaces**

Add after the `LiveSessionStats` interface (around line 584):

```typescript
// ── Budget Enforcement ─────────────────────────────────────────────────────

export interface BudgetAlert {
  id: string
  sessionId: string
  kind: 'warning' | 'exceeded'
  currentCostUsd: number
  limitUsd: number
  timestamp: string
}

// ── Leak Detection ─────────────────────────────────────────────────────────

export interface LeakMatch {
  kind: string        // 'aws-key', 'github-token', 'private-key', 'high-entropy', etc.
  preview: string     // redacted preview: "AKIA****XXXX"
  filePath?: string
  line?: number
}
```

**Step 2: Add onBudgetAlert to LatchAPI**

In the `LatchAPI` interface, add alongside the existing `onLiveEvent`:

```typescript
  onBudgetAlert(callback: (alert: BudgetAlert) => void): () => void;
  respondBudgetAlert(payload: { alertId: string; action: 'kill' | 'extend' }): Promise<{ ok: boolean }>;
```

**Step 3: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS (new types are additive-only)

**Step 4: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add BudgetAlert and LeakMatch types for spend controls and leak detection"
```

---

### Task 2: Create Leak Scanner Module

**Files:**
- Create: `src/main/lib/leak-scanner.ts`

Pure computation module (no I/O), same pattern as `src/main/lib/loop-detector.ts`.

**Step 1: Write the leak scanner**

```typescript
// src/main/lib/leak-scanner.ts

/**
 * @module leak-scanner
 * @description Pure computation module that scans strings for credential
 * patterns. No I/O — takes a string, returns an array of LeakMatch objects.
 * Modeled after loop-detector.ts.
 */

import type { LeakMatch } from '../../types'

// ── Pattern Definitions ────────────────────────────────────────────────────

interface PatternDef {
  kind: string
  regex: RegExp
  redact: (match: string) => string
}

const PATTERNS: PatternDef[] = [
  {
    kind: 'aws-access-key',
    regex: /AKIA[0-9A-Z]{16}/g,
    redact: (m) => m.slice(0, 4) + '****' + m.slice(-4),
  },
  {
    kind: 'aws-secret-key',
    regex: /(?:aws_secret_access_key|AWS_SECRET)["\s:=]+([A-Za-z0-9/+=]{40})/gi,
    redact: () => '****[AWS Secret Key]****',
  },
  {
    kind: 'github-token',
    regex: /\b(ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})\b/g,
    redact: (m) => m.slice(0, 4) + '****' + m.slice(-4),
  },
  {
    kind: 'openai-anthropic-key',
    regex: /\bsk-[a-zA-Z0-9]{20,}\b/g,
    redact: (m) => 'sk-****' + m.slice(-4),
  },
  {
    kind: 'stripe-key',
    regex: /\b(sk_live_[A-Za-z0-9]{24,}|pk_live_[A-Za-z0-9]{24,}|rk_live_[A-Za-z0-9]{24,})\b/g,
    redact: (m) => m.slice(0, 8) + '****' + m.slice(-4),
  },
  {
    kind: 'private-key',
    regex: /-----BEGIN[A-Z ]*PRIVATE KEY-----/g,
    redact: () => '-----BEGIN ****PRIVATE KEY-----',
  },
  {
    kind: 'env-credential',
    regex: /\b(PASSWORD|SECRET|API_KEY|TOKEN|PRIVATE_KEY|AUTH_TOKEN|ACCESS_TOKEN)\s*[=:]\s*["']?([^\s"']{8,})["']?/gi,
    redact: (m) => {
      const eq = m.indexOf('=')
      if (eq === -1) return m.slice(0, 10) + '****'
      return m.slice(0, eq + 1) + '****'
    },
  },
]

// ── Shannon Entropy ────────────────────────────────────────────────────────

const ENTROPY_THRESHOLD = 4.5
const MIN_ENTROPY_LENGTH = 20
const ENTROPY_REGEX = /[A-Za-z0-9/+=]{20,}/g

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let entropy = 0
  for (const count of freq.values()) {
    const p = count / s.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Scan a string for credential patterns.
 * Returns an array of LeakMatch objects (empty if no leaks found).
 */
export function scanForLeaks(
  text: string,
  filePath?: string,
): LeakMatch[] {
  const matches: LeakMatch[] = []
  const seen = new Set<string>()

  // Named patterns
  for (const pat of PATTERNS) {
    pat.regex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pat.regex.exec(text)) !== null) {
      const raw = m[0]
      const key = `${pat.kind}:${raw}`
      if (seen.has(key)) continue
      seen.add(key)

      const line = filePath ? text.slice(0, m.index).split('\n').length : undefined

      matches.push({
        kind: pat.kind,
        preview: pat.redact(raw),
        filePath,
        line,
      })
    }
  }

  // High-entropy strings (skip if already matched a named pattern)
  ENTROPY_REGEX.lastIndex = 0
  let em: RegExpExecArray | null
  while ((em = ENTROPY_REGEX.exec(text)) !== null) {
    const raw = em[0]
    if (raw.length < MIN_ENTROPY_LENGTH) continue

    // Skip if this substring was already caught by a named pattern
    let alreadyCaught = false
    for (const s of seen) {
      if (s.includes(raw) || raw.includes(s.split(':')[1] ?? '')) {
        alreadyCaught = true
        break
      }
    }
    if (alreadyCaught) continue

    const entropy = shannonEntropy(raw)
    if (entropy >= ENTROPY_THRESHOLD) {
      const key = `high-entropy:${raw}`
      if (seen.has(key)) continue
      seen.add(key)

      matches.push({
        kind: 'high-entropy',
        preview: raw.slice(0, 6) + '****' + raw.slice(-4),
        filePath,
        line: filePath ? text.slice(0, em.index).split('\n').length : undefined,
      })
    }
  }

  return matches
}
```

**Step 2: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/main/lib/leak-scanner.ts
git commit -m "feat: add leak-scanner pure computation module with 8 credential patterns"
```

---

### Task 3: Create Budget Enforcer Service

**Files:**
- Create: `src/main/services/budget-enforcer.ts`

**Step 1: Write the budget enforcer**

This service:
- Subscribes to usage events (same events usage-watcher pushes)
- Maintains running cost per session and per project (daily reset)
- Emits LiveEvent anomalies at 80% and budget alerts at 100%
- Supports kill (via pty-manager) and extend (double the limit)

```typescript
// src/main/services/budget-enforcer.ts

/**
 * @module budget-enforcer
 * @description Tracks running session and project costs against configured
 * budgets. Emits LiveEvent anomalies at 80% and budget alert dialogs at
 * 100%. Subscribes to the same usage events as usage-watcher.
 */

import crypto from 'node:crypto'
import type { UsageEvent, BudgetAlert, LiveEvent, FeedItem, RadarSignal } from '../../types'

// ── Types ──────────────────────────────────────────────────────────────────

interface SessionBudget {
  sessionId: string
  limitUsd: number
  currentCostUsd: number
  warningEmitted: boolean
  exceededEmitted: boolean
  extensions: number
}

interface ProjectDayCost {
  projectSlug: string
  date: string
  costUsd: number
  warningEmitted: boolean
  exceededEmitted: boolean
}

export interface BudgetEnforcerOptions {
  sendToRenderer: (channel: string, payload: unknown) => void
  getSessionBudget: (sessionId: string) => number | null
  getGlobalSessionBudget: () => number | null
  getDailyProjectBudget: () => number | null
  getSessionProject: (sessionId: string) => string | null
  killSession: (sessionId: string) => void
  recordFeed: (params: { sessionId: string; message: string; harnessId: string }) => FeedItem
  emitRadar: (signal: RadarSignal) => void
}

// ── State ──────────────────────────────────────────────────────────────────

const sessionBudgets = new Map<string, SessionBudget>()
const projectDayCosts = new Map<string, ProjectDayCost>()
const pendingAlerts = new Map<string, BudgetAlert>()

let _opts: BudgetEnforcerOptions | null = null

// ── Helpers ────────────────────────────────────────────────────────────────

function uid(): string {
  return `budget-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function emitLiveEvent(event: LiveEvent): void {
  _opts?.sendToRenderer('latch:live-event', event)
}

function emitBudgetAlert(alert: BudgetAlert): void {
  _opts?.sendToRenderer('latch:budget-alert', alert)
}

function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  return `$${usd.toFixed(2)}`
}

// ── Session Budget Logic ───────────────────────────────────────────────────

function getOrCreateSessionBudget(sessionId: string): SessionBudget | null {
  if (sessionBudgets.has(sessionId)) return sessionBudgets.get(sessionId)!

  // Check per-session override, then global default
  const limit = _opts?.getSessionBudget(sessionId) ?? _opts?.getGlobalSessionBudget() ?? null
  if (limit === null) return null

  const budget: SessionBudget = {
    sessionId,
    limitUsd: limit,
    currentCostUsd: 0,
    warningEmitted: false,
    exceededEmitted: false,
    extensions: 0,
  }
  sessionBudgets.set(sessionId, budget)
  return budget
}

function checkSessionBudget(budget: SessionBudget): void {
  const pct = budget.currentCostUsd / budget.limitUsd
  const now = new Date().toISOString()

  // 80% warning
  if (pct >= 0.8 && !budget.warningEmitted) {
    budget.warningEmitted = true

    emitLiveEvent({
      id: uid(),
      sessionId: budget.sessionId,
      timestamp: now,
      kind: 'anomaly',
      anomalyKind: 'budget-warning',
      anomalyMessage: `Session approaching budget limit (${formatCost(budget.currentCostUsd)} / ${formatCost(budget.limitUsd)})`,
    })

    _opts?.recordFeed({
      sessionId: budget.sessionId,
      message: `Budget warning: session at ${Math.round(pct * 100)}% of ${formatCost(budget.limitUsd)} limit`,
      harnessId: 'latch',
    })
  }

  // 100% exceeded
  if (pct >= 1.0 && !budget.exceededEmitted) {
    budget.exceededEmitted = true

    const alert: BudgetAlert = {
      id: uid(),
      sessionId: budget.sessionId,
      kind: 'exceeded',
      currentCostUsd: budget.currentCostUsd,
      limitUsd: budget.limitUsd,
      timestamp: now,
    }
    pendingAlerts.set(alert.id, alert)
    emitBudgetAlert(alert)

    emitLiveEvent({
      id: uid(),
      sessionId: budget.sessionId,
      timestamp: now,
      kind: 'anomaly',
      anomalyKind: 'budget-exceeded',
      anomalyMessage: `Session exceeded ${formatCost(budget.limitUsd)} budget (${formatCost(budget.currentCostUsd)})`,
    })

    _opts?.recordFeed({
      sessionId: budget.sessionId,
      message: `Budget exceeded: session at ${formatCost(budget.currentCostUsd)}, limit was ${formatCost(budget.limitUsd)}`,
      harnessId: 'latch',
    })

    _opts?.emitRadar({
      id: uid(),
      level: 'high',
      message: `Session budget exceeded: ${formatCost(budget.currentCostUsd)} / ${formatCost(budget.limitUsd)}`,
      observedAt: now,
    })
  }
}

// ── Project Budget Logic ───────────────────────────────────────────────────

function checkProjectBudget(sessionId: string, costUsd: number): void {
  const dailyLimit = _opts?.getDailyProjectBudget() ?? null
  if (dailyLimit === null) return

  const projectSlug = _opts?.getSessionProject(sessionId) ?? null
  if (!projectSlug) return

  const date = todayKey()
  const key = `${projectSlug}:${date}`

  let entry = projectDayCosts.get(key)
  if (!entry) {
    entry = { projectSlug, date, costUsd: 0, warningEmitted: false, exceededEmitted: false }
    projectDayCosts.set(key, entry)
  }

  entry.costUsd += costUsd
  const pct = entry.costUsd / dailyLimit
  const now = new Date().toISOString()

  if (pct >= 0.8 && !entry.warningEmitted) {
    entry.warningEmitted = true
    emitLiveEvent({
      id: uid(),
      sessionId,
      timestamp: now,
      kind: 'anomaly',
      anomalyKind: 'project-budget-warning',
      anomalyMessage: `Project "${projectSlug}" approaching daily budget (${formatCost(entry.costUsd)} / ${formatCost(dailyLimit)})`,
    })
  }

  if (pct >= 1.0 && !entry.exceededEmitted) {
    entry.exceededEmitted = true
    _opts?.emitRadar({
      id: uid(),
      level: 'high',
      message: `Daily project budget exceeded for "${projectSlug}": ${formatCost(entry.costUsd)} / ${formatCost(dailyLimit)}`,
      observedAt: now,
    })
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize the budget enforcer.
 */
export function startBudgetEnforcer(opts: BudgetEnforcerOptions): void {
  _opts = opts
  console.log('[budget-enforcer] Started')
}

/**
 * Process a usage event. Called for every usage event (same events usage-watcher pushes).
 */
export function budgetEnforcerProcessEvent(event: UsageEvent): void {
  if (!_opts) return
  if (!event.sessionId) return

  // Session budget tracking
  const budget = getOrCreateSessionBudget(event.sessionId)
  if (budget) {
    budget.currentCostUsd += event.costUsd
    checkSessionBudget(budget)
  }

  // Project budget tracking
  checkProjectBudget(event.sessionId, event.costUsd)
}

/**
 * Handle user response to a budget alert (kill or extend).
 */
export function respondToBudgetAlert(alertId: string, action: 'kill' | 'extend'): void {
  const alert = pendingAlerts.get(alertId)
  if (!alert) return
  pendingAlerts.delete(alertId)

  const budget = sessionBudgets.get(alert.sessionId)

  if (action === 'kill') {
    _opts?.killSession(alert.sessionId)
    _opts?.recordFeed({
      sessionId: alert.sessionId,
      message: `Session killed: budget of ${formatCost(alert.limitUsd)} exceeded`,
      harnessId: 'latch',
    })
  } else if (action === 'extend' && budget) {
    budget.limitUsd *= 2
    budget.warningEmitted = false
    budget.exceededEmitted = false
    budget.extensions++
    _opts?.recordFeed({
      sessionId: alert.sessionId,
      message: `Budget extended to ${formatCost(budget.limitUsd)} (extension #${budget.extensions})`,
      harnessId: 'latch',
    })
  }
}

/**
 * Remove tracking for a closed session.
 */
export function budgetEnforcerRemoveSession(sessionId: string): void {
  sessionBudgets.delete(sessionId)
}

/**
 * Clean up all state.
 */
export function stopBudgetEnforcer(): void {
  sessionBudgets.clear()
  projectDayCosts.clear()
  pendingAlerts.clear()
  _opts = null
  console.log('[budget-enforcer] Stopped')
}
```

**Step 2: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/main/services/budget-enforcer.ts
git commit -m "feat: add budget-enforcer service with session/project limit tracking"
```

---

### Task 4: Wire Budget Enforcer into Main Process

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

**Step 1: Import and start budget enforcer in main/index.ts**

Add import at top alongside other service imports:

```typescript
import {
  startBudgetEnforcer,
  budgetEnforcerProcessEvent,
  respondToBudgetAlert,
  budgetEnforcerRemoveSession,
  stopBudgetEnforcer,
} from './services/budget-enforcer'
```

In `app.whenReady()`, after the usage watcher starts, add:

```typescript
startBudgetEnforcer({
  sendToRenderer: (channel, payload) => {
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send(channel, payload))
  },
  getSessionBudget: (sessionId) => {
    // Check session record for budget override
    const row = sessionStore.getSession(sessionId)
    if (!row) return null
    const budgetStr = settingsStore.get(`session-budget:${sessionId}`)
    return budgetStr ? parseFloat(budgetStr) : null
  },
  getGlobalSessionBudget: () => {
    const v = settingsStore.get('default-session-budget')
    return v ? parseFloat(v) : null
  },
  getDailyProjectBudget: () => {
    const v = settingsStore.get('daily-project-budget')
    return v ? parseFloat(v) : null
  },
  getSessionProject: (sessionId) => {
    const row = sessionStore.getSession(sessionId)
    return row?.project_dir ?? row?.repo_root ?? null
  },
  killSession: (sessionId) => {
    // Kill all PTYs for this session's tabs
    const row = sessionStore.getSession(sessionId)
    if (!row) return
    // The sessionId used for PTY is the tabId, but we need to kill all tabs
    ptyManager?.kill(sessionId)
  },
  recordFeed: (params) => feedStore.record(params),
  emitRadar: (signal) => {
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send('latch:radar-signal', signal))
  },
})
```

**Step 2: Hook into usage event flow**

Find where usage events are emitted to the renderer (in the usage watcher callback or IPC handler). Add a call to `budgetEnforcerProcessEvent(event)` right after. If usage events flow through a callback like `onUsageEvent`, add budget processing there.

**Step 3: Add IPC handlers for budget alerts**

```typescript
ipcMain.handle('latch:budget-respond', async (_event: any, payload: any) => {
  const { alertId, action } = payload
  if (!alertId || !['kill', 'extend'].includes(action)) {
    return { ok: false, error: 'Invalid payload' }
  }
  respondToBudgetAlert(alertId, action)
  return { ok: true }
})
```

**Step 4: Add cleanup in before-quit**

Add `stopBudgetEnforcer()` in the `before-quit` handler alongside `stopUsageWatcher()` and `stopLiveTailer()`.

**Step 5: Add preload bridge for budget alerts**

In `src/preload/index.ts`, add to the `contextBridge.exposeInMainWorld('latch', { ... })` object:

```typescript
onBudgetAlert: (callback: (alert: any) => void) => {
  const handler = (_event: any, payload: any) => callback(payload)
  ipcRenderer.on('latch:budget-alert', handler)
  return () => { ipcRenderer.removeListener('latch:budget-alert', handler) }
},
respondBudgetAlert: (payload: { alertId: string; action: string }) =>
  ipcRenderer.invoke('latch:budget-respond', payload),
```

**Step 6: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 7: Commit**

```bash
git add src/main/index.ts src/preload/index.ts
git commit -m "feat: wire budget enforcer into main process with IPC and preload bridge"
```

---

### Task 5: Wire Leak Scanner into Live Tailer

**Files:**
- Modify: `src/main/services/live-tailer.ts`

The leak scanner needs to run on Write/Edit tool call content as it flows through the JSONL parser.

**Step 1: Import the leak scanner**

Add at top of `live-tailer.ts`:

```typescript
import { scanForLeaks } from '../lib/leak-scanner'
```

**Step 2: Add leak scanning to tool call processing**

In the `processJsonlEntry` function, inside the `type === 'assistant'` block where tool calls are extracted (the `for (const block of content)` loop), after the existing `emit()` for tool-call events, add leak scanning for Write/Edit tools:

```typescript
// Scan Write/Edit content for credential leaks
const toolNameLower = toolName.toLowerCase()
if (toolNameLower === 'write' || toolNameLower === 'edit') {
  const content = (toolInput.content ?? toolInput.new_string ?? '') as string
  const target = (toolInput.file_path ?? toolInput.path ?? '') as string
  if (content) {
    const leaks = scanForLeaks(content, target || undefined)
    for (const leak of leaks) {
      emit({
        id: uid(),
        sessionId: state.sessionId,
        timestamp,
        kind: 'anomaly',
        anomalyKind: 'credential-leak',
        anomalyMessage: `Credential detected (${leak.kind}): ${leak.preview}${leak.filePath ? ` in ${leak.filePath}` : ''}`,
      })
    }
  }
}
```

**Step 3: Also push leak detections to feed and radar**

The live-tailer doesn't have direct access to feed-store or radar. Add optional callbacks to `LiveTailerOptions`:

```typescript
export interface LiveTailerOptions {
  sendToRenderer: (channel: string, payload: unknown) => void
  getSessionMap: () => Map<string, string>
  onLeakDetected?: (sessionId: string, leak: import('../../types').LeakMatch) => void
}
```

Store the callback and invoke it when leaks are found. Wire it up in main/index.ts:

```typescript
onLeakDetected: (sessionId, leak) => {
  feedStore.record({
    sessionId,
    message: `Credential leak detected (${leak.kind}): ${leak.preview}${leak.filePath ? ` in ${leak.filePath}` : ''}`,
    harnessId: 'latch',
  })
  const signal = {
    id: `radar-leak-${Date.now()}`,
    level: 'high' as const,
    message: `Credential leak: ${leak.kind} detected${leak.filePath ? ` in ${leak.filePath}` : ''}`,
    observedAt: new Date().toISOString(),
  }
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send('latch:radar-signal', signal))
}
```

**Step 4: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/main/services/live-tailer.ts src/main/index.ts
git commit -m "feat: wire leak scanner into live-tailer JSONL parsing for Write/Edit tools"
```

---

### Task 6: Zustand Store Updates

**Files:**
- Modify: `src/renderer/store/useAppStore.ts`

**Step 1: Import BudgetAlert**

Add `BudgetAlert` to the type imports from `../../types`.

**Step 2: Add state and actions**

Add to the store interface:

```typescript
// Budget enforcement
activeBudgetAlert: BudgetAlert | null
handleBudgetAlert: (alert: BudgetAlert) => void
respondBudgetAlert: (alertId: string, action: 'kill' | 'extend') => void
dismissBudgetAlert: () => void
```

Add to the store implementation:

```typescript
activeBudgetAlert: null,

handleBudgetAlert: (alert) => {
  set({ activeBudgetAlert: alert })
},

respondBudgetAlert: async (alertId, action) => {
  await window.latch?.respondBudgetAlert?.({ alertId, action })
  set({ activeBudgetAlert: null })
},

dismissBudgetAlert: () => {
  set({ activeBudgetAlert: null })
},
```

**Step 3: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/store/useAppStore.ts
git commit -m "feat: add budget alert state and actions to Zustand store"
```

---

### Task 7: Register Budget Alert Listener in App.tsx

**Files:**
- Modify: `src/renderer/App.tsx`

**Step 1: Add handleBudgetAlert to destructured store actions**

In the `useAppStore()` destructure at top of `App()`, add `handleBudgetAlert`.

**Step 2: Register IPC listener in boot useEffect**

Add alongside the existing live event listener:

```typescript
const disposeBudgetAlert = window.latch?.onBudgetAlert?.((alert) => {
  handleBudgetAlert(alert)
})
```

Add cleanup: `disposeBudgetAlert?.()` in the return function.

**Step 3: Render BudgetAlertDialog modal**

Import and render the dialog (to be created in Task 8):

```typescript
import BudgetAlertDialog from './components/modals/BudgetAlertDialog'
```

In the JSX, alongside the existing modal overlays:

```tsx
{useAppStore.getState().activeBudgetAlert && <BudgetAlertDialog />}
```

Note: Use a simpler reactive pattern — pull `activeBudgetAlert` from the destructured store:

```tsx
const { activeBudgetAlert } = useAppStore()
// ...
{activeBudgetAlert && <BudgetAlertDialog />}
```

**Step 4: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: May fail until BudgetAlertDialog exists — create a stub if needed.

**Step 5: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: register budget alert listener and render dialog in App.tsx"
```

---

### Task 8: Budget Alert Dialog Component

**Files:**
- Create: `src/renderer/components/modals/BudgetAlertDialog.tsx`
- Modify: `src/renderer/styles.css`

**Step 1: Create the dialog component**

```tsx
// src/renderer/components/modals/BudgetAlertDialog.tsx

import React from 'react'
import { Warning } from '@phosphor-icons/react'
import { useAppStore } from '../../store/useAppStore'

function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  return `$${usd.toFixed(2)}`
}

export default function BudgetAlertDialog() {
  const alert = useAppStore((s) => s.activeBudgetAlert)
  const respondBudgetAlert = useAppStore((s) => s.respondBudgetAlert)
  const sessions = useAppStore((s) => s.sessions)

  if (!alert) return null

  const session = sessions.get(alert.sessionId)
  const sessionName = session?.name ?? alert.sessionId

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && undefined}>
      <div className="budget-alert-dialog">
        <div className="budget-alert-icon">
          <Warning size={32} weight="fill" />
        </div>
        <h2 className="budget-alert-title">Budget Exceeded</h2>
        <p className="budget-alert-desc">
          Session <strong>{sessionName}</strong> has exceeded its budget limit.
        </p>
        <div className="budget-alert-stats">
          <div className="budget-alert-stat">
            <span className="budget-alert-stat-label">Current Cost</span>
            <span className="budget-alert-stat-value">{formatCost(alert.currentCostUsd)}</span>
          </div>
          <div className="budget-alert-stat">
            <span className="budget-alert-stat-label">Budget Limit</span>
            <span className="budget-alert-stat-value">{formatCost(alert.limitUsd)}</span>
          </div>
        </div>
        <div className="budget-alert-actions">
          <button
            className="budget-alert-btn is-danger"
            onClick={() => respondBudgetAlert(alert.id, 'kill')}
          >
            Kill Session
          </button>
          <button
            className="budget-alert-btn is-extend"
            onClick={() => respondBudgetAlert(alert.id, 'extend')}
          >
            Extend to {formatCost(alert.limitUsd * 2)}
          </button>
        </div>
      </div>
    </div>
  )
}
```

**Step 2: Add CSS**

Add to `src/renderer/styles.css`:

```css
/* ── Budget Alert Dialog ──────────────────────────────────────────────────── */

.budget-alert-dialog {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 32px;
  max-width: 400px;
  width: 90%;
  text-align: center;
}

.budget-alert-icon {
  color: var(--warning);
  margin-bottom: 12px;
}

.budget-alert-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px;
}

.budget-alert-desc {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 20px;
  line-height: 1.4;
}

.budget-alert-stats {
  display: flex;
  gap: 24px;
  justify-content: center;
  margin-bottom: 24px;
}

.budget-alert-stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.budget-alert-stat-label {
  font-size: 11px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.budget-alert-stat-value {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.budget-alert-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
}

.budget-alert-btn {
  padding: 8px 20px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--border-subtle);
  transition: background 0.15s;
}

.budget-alert-btn.is-danger {
  background: rgb(var(--d-red, 248 113 113) / 0.15);
  color: rgb(var(--d-red, 248 113 113));
  border-color: rgb(var(--d-red, 248 113 113) / 0.3);
}

.budget-alert-btn.is-danger:hover {
  background: rgb(var(--d-red, 248 113 113) / 0.25);
}

.budget-alert-btn.is-extend {
  background: var(--accent-muted);
  color: var(--accent);
  border-color: var(--accent-border);
}

.budget-alert-btn.is-extend:hover {
  background: var(--accent);
  color: var(--bg-app);
}
```

**Step 3: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/components/modals/BudgetAlertDialog.tsx src/renderer/styles.css
git commit -m "feat: add budget alert dialog component with kill/extend actions"
```

---

### Task 9: Settings Panel — Budget Section

**Files:**
- Modify: `src/renderer/components/panels/SettingsPanel.tsx`

**Step 1: Add BudgetSection component**

Add a new section component inside `SettingsPanel.tsx`:

```tsx
function BudgetSection() {
  const [sessionBudget, setSessionBudget] = useState('')
  const [projectBudget, setProjectBudget] = useState('')
  const [sloCost, setSloCost] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const load = async () => {
      const [sb, pb, slo] = await Promise.all([
        window.latch?.getSetting?.({ key: 'default-session-budget' }),
        window.latch?.getSetting?.({ key: 'daily-project-budget' }),
        window.latch?.getSetting?.({ key: 'slo-session-cost-p95' }),
      ])
      if (sb?.ok && sb.value) setSessionBudget(sb.value)
      if (pb?.ok && pb.value) setProjectBudget(pb.value)
      if (slo?.ok && slo.value) setSloCost(slo.value)
      setLoaded(true)
    }
    load()
  }, [])

  const handleSave = async () => {
    const saves = []
    if (sessionBudget.trim()) {
      saves.push(window.latch?.setSetting?.({ key: 'default-session-budget', value: sessionBudget.trim() }))
    } else {
      saves.push(window.latch?.deleteSetting?.({ key: 'default-session-budget' }))
    }
    if (projectBudget.trim()) {
      saves.push(window.latch?.setSetting?.({ key: 'daily-project-budget', value: projectBudget.trim() }))
    } else {
      saves.push(window.latch?.deleteSetting?.({ key: 'daily-project-budget' }))
    }
    if (sloCost.trim()) {
      saves.push(window.latch?.setSetting?.({ key: 'slo-session-cost-p95', value: sloCost.trim() }))
    } else {
      saves.push(window.latch?.deleteSetting?.({ key: 'slo-session-cost-p95' }))
    }
    await Promise.all(saves)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  if (!loaded) return null

  return (
    <div className="panel-card">
      <div className="budget-field">
        <label className="cp-toggle-text" style={{ fontSize: 12, marginBottom: 4, display: 'block' }}>
          Default session budget (USD)
        </label>
        <input
          type="number"
          className="wizard-input"
          placeholder="e.g. 10"
          value={sessionBudget}
          onChange={(e) => setSessionBudget(e.target.value)}
          min="0"
          step="0.5"
          style={{ maxWidth: 160 }}
        />
        <div className="settings-toggle-desc">
          Maximum spend per session. Leave blank for no limit. Can be overridden per session.
        </div>
      </div>

      <div className="budget-field" style={{ marginTop: 16 }}>
        <label className="cp-toggle-text" style={{ fontSize: 12, marginBottom: 4, display: 'block' }}>
          Daily project budget (USD)
        </label>
        <input
          type="number"
          className="wizard-input"
          placeholder="e.g. 50"
          value={projectBudget}
          onChange={(e) => setProjectBudget(e.target.value)}
          min="0"
          step="1"
          style={{ maxWidth: 160 }}
        />
        <div className="settings-toggle-desc">
          Maximum spend per project per day across all sessions.
        </div>
      </div>

      <div className="budget-field" style={{ marginTop: 16 }}>
        <label className="cp-toggle-text" style={{ fontSize: 12, marginBottom: 4, display: 'block' }}>
          SLO: 95th percentile session cost (USD)
        </label>
        <input
          type="number"
          className="wizard-input"
          placeholder="e.g. 8"
          value={sloCost}
          onChange={(e) => setSloCost(e.target.value)}
          min="0"
          step="0.5"
          style={{ maxWidth: 160 }}
        />
        <div className="settings-toggle-desc">
          Target P95 session cost. Triggers a Radar signal when breached.
        </div>
      </div>

      <button
        className="panel-action is-primary"
        onClick={handleSave}
        style={{ marginTop: 16 }}
      >
        {saved ? 'Saved!' : 'Save budgets'}
      </button>
    </div>
  )
}
```

**Step 2: Render the section in SettingsPanel**

Add between the Sandbox and General sections:

```tsx
{/* ── Budgets ───────────────────────────────────────────────── */}
<div className="view-section-label">Budgets</div>
<BudgetSection />
```

**Step 3: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/components/panels/SettingsPanel.tsx
git commit -m "feat: add budget configuration section to Settings view"
```

---

### Task 10: Session Wizard — Budget Field

**Files:**
- Modify: `src/renderer/terminal/TerminalWizard.ts`

**Step 1: Add budget step to wizard**

In `buildWizardSteps()`, add a budget step after the goal step:

```typescript
{
  id: 'budget',
  prompt: 'Session budget (USD)',
  type: 'text',
  hint: 'Leave blank to use default. e.g. 10',
  skip: false,
},
```

**Step 2: Store budget value on session creation**

In the wizard's completion handler (where answers are collected and session is created), save the budget value if provided:

```typescript
if (answers.budget && parseFloat(answers.budget) > 0) {
  await window.latch?.setSetting?.({
    key: `session-budget:${sessionId}`,
    value: answers.budget,
  })
}
```

**Step 3: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/terminal/TerminalWizard.ts
git commit -m "feat: add optional budget field to session wizard"
```

---

### Task 11: Enhanced Anomaly Rendering in Live View

**Files:**
- Modify: `src/renderer/components/LiveView.tsx`
- Modify: `src/renderer/styles.css`

**Step 1: Update EventRow to distinguish anomaly types**

In the `EventRow` component, replace the generic anomaly rendering with type-aware rendering:

```tsx
if (event.kind === 'anomaly') {
  const isLeak = event.anomalyKind === 'credential-leak'
  const isBudget = event.anomalyKind?.startsWith('budget-') || event.anomalyKind?.startsWith('project-budget-')

  return (
    <div className={`live-event live-event-anomaly${isLeak ? ' is-leak' : ''}${isBudget ? ' is-budget' : ''}`}>
      <span className="live-event-time">{formatTime(event.timestamp)}</span>
      <span className="live-event-anomaly-icon">{isLeak ? '🔑' : isBudget ? '💰' : '⚠'}</span>
      <span className="live-event-anomaly-text">{event.anomalyMessage}</span>
    </div>
  )
}
```

**Step 2: Add CSS for credential leak and budget anomalies**

```css
.live-event-anomaly.is-leak {
  background: rgb(var(--d-red, 248 113 113) / 0.12);
  border-left: 3px solid rgb(var(--d-red, 248 113 113));
}

.live-event-anomaly.is-budget {
  background: rgb(var(--d-amber, 251 191 36) / 0.12);
  border-left: 3px solid rgb(var(--d-amber, 251 191 36));
}
```

**Step 3: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/components/LiveView.tsx src/renderer/styles.css
git commit -m "feat: add type-aware anomaly rendering for leaks and budget alerts in Live view"
```

---

### Task 12: Final Typecheck and Verification

**Step 1: Run full typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS — no errors

**Step 2: Verify all new files exist**

```bash
ls -la src/main/lib/leak-scanner.ts src/main/services/budget-enforcer.ts src/renderer/components/modals/BudgetAlertDialog.tsx
```

**Step 3: Run dev build**

Run: `cd /Users/cbryant/code/latch-core && npm run dev`
Verify: App launches, Settings shows Budgets section, no console errors.

**Step 4: Final commit if any fixups needed**

```bash
git add -A
git commit -m "chore: final fixups for budgets and leak detection"
```
