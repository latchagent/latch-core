# Live Session Tailing — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a real-time "Live" view that streams tool calls, agent thinking, cost, and anomaly warnings for all active sessions — the Datadog Live Tail for AI coding agents.

**Architecture:** Extend the existing activity event pipeline to emit enriched `LiveEvent` objects. A new `live-tailer.ts` service tails active JSONL files and extracts thinking summaries and tool call details. The renderer gets a dedicated Live view with session cards (overview) and drill-down detail (full trace with thinking, stats, and anomalies). All data flows via IPC push events — no polling.

**Tech Stack:** TypeScript, React 18, Zustand, fs.watch (Node), IPC push events, existing activity/usage/radar infrastructure.

---

## Reference Files

Before starting, read these to understand existing patterns:

| File | Why |
|------|-----|
| `src/types/index.ts` | All type definitions, `AppView`, `ActivityEvent`, `UsageEvent` |
| `src/main/services/usage-watcher.ts` | Existing JSONL tail + fs.watch pattern to follow |
| `src/main/services/authz-server.ts:700-800` | Where activity events are emitted with `toolInput` |
| `src/main/index.ts:185-187` | `sendToRenderer` helper for IPC push |
| `src/preload/index.ts:197-210` | `onActivityEvent` pattern for IPC listeners |
| `src/renderer/App.tsx:86-150` | Where push event listeners are registered on mount |
| `src/renderer/store/useAppStore.ts:1395-1462` | Activity/usage event handlers in Zustand |
| `src/renderer/components/Sidebar.tsx:97-131` | Observe section nav items |
| `src/renderer/components/AnalyticsView.tsx` | Drill-down navigation pattern (overview → detail) |
| `src/main/lib/loop-detector.ts` | Loop detection logic to reuse |

---

### Task 1: Add LiveEvent types and AppView

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Add the types**

Add these types after the existing `RadarSignal` interface (around line 535):

```typescript
// ── Live Tailing ────────────────────────────────────────────────────────────

export type LiveEventKind = 'tool-call' | 'thinking' | 'anomaly' | 'status-change'
export type LiveSessionStatus = 'active' | 'thinking' | 'idle' | 'rate-limited'

export interface LiveEvent {
  id: string
  sessionId: string
  timestamp: string
  kind: LiveEventKind

  // tool-call fields
  toolName?: string
  target?: string
  costUsd?: number
  durationMs?: number
  status?: 'running' | 'success' | 'error'
  inputTokens?: number
  outputTokens?: number

  // thinking fields
  thinkingSummary?: string

  // anomaly fields
  anomalyKind?: string
  anomalyMessage?: string

  // status-change fields
  sessionStatus?: LiveSessionStatus
}

export interface LiveSessionStats {
  sessionId: string
  totalCostUsd: number
  turnCount: number
  startedAt: string
  lastEventAt: string
  filesTouched: Map<string, { reads: number; writes: number }>
  cacheHitRatio: number
  totalInputTokens: number
  totalCacheReadTokens: number
}
```

**Step 2: Add `'live'` to AppView**

Find the `AppView` type (line ~806) and add `'live'`:

```typescript
export type AppView = 'home' | 'policies' | 'agents' | 'mcp' | 'create-policy' | 'edit-policy' | 'create-service' | 'settings' | 'feed' | 'radar' | 'docs' | 'services' | 'gateway' | 'usage' | 'timeline' | 'analytics' | 'live';
```

**Step 3: Add IPC listener types to LatchAPI**

Find the `LatchAPI` interface in `Window.latch` section and add:

```typescript
onLiveEvent?: (callback: (event: LiveEvent) => void) => (() => void);
```

**Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (new types are additive, nothing references them yet)

**Step 5: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add LiveEvent types and 'live' AppView for session tailing"
```

---

### Task 2: Create live-tailer service

This is the core data pipeline. It tails active JSONL files, extracts thinking summaries and tool call details, correlates with activity/usage events, and emits unified `LiveEvent` objects.

**Files:**
- Create: `src/main/services/live-tailer.ts`

**Step 1: Create the service**

Create `src/main/services/live-tailer.ts`:

```typescript
// src/main/services/live-tailer.ts

/**
 * @module live-tailer
 * @description Tails active Claude Code JSONL files in real-time, extracts
 * thinking summaries and tool call details, and emits unified LiveEvent
 * objects to the renderer. Works alongside usage-watcher (which handles
 * cost/token tracking) — this service focuses on the richer trace data.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import type { LiveEvent, LiveSessionStatus } from '../../types'

// ── Configuration ───────────────────────────────────────────────────────────

const DEBOUNCE_MS = 80
const GAP_THRESHOLD_MS = 30_000  // 30s gap = rate-limited status
const IDLE_THRESHOLD_MS = 10_000 // 10s no activity = idle

// ── State ───────────────────────────────────────────────────────────────────

interface TailState {
  filePath: string
  offset: number
  sessionId: string
  lastEventTs: number
  status: LiveSessionStatus
  turnIndex: number
}

const tails = new Map<string, TailState>()
const watchers = new Map<string, fs.FSWatcher>()
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

let sendToRenderer: ((channel: string, payload: unknown) => void) | null = null
let getSessionMap: (() => Map<string, string>) | null = null
let statusInterval: ReturnType<typeof setInterval> | null = null

// ── Helpers ─────────────────────────────────────────────────────────────────

function uid(): string {
  return `live-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
}

function emit(event: LiveEvent): void {
  sendToRenderer?.('latch:live-event', event)
}

function claudeSlug(repoRoot: string): string {
  return repoRoot.replace(/\//g, '-')
}

/**
 * Extract thinking summary from an assistant message's content blocks.
 */
function extractThinking(content: unknown[]): string | null {
  if (!Array.isArray(content)) return null
  for (const block of content) {
    const b = block as Record<string, unknown>
    if (b.type === 'thinking' && typeof b.thinking === 'string') {
      // Take first 200 chars as summary
      const text = (b.thinking as string).trim()
      if (text.length === 0) continue
      return text.length > 200 ? text.slice(0, 197) + '...' : text
    }
  }
  return null
}

/**
 * Extract tool call target (file path, command, pattern) from tool input.
 */
function extractTarget(toolName: string, toolInput: Record<string, unknown>): string | null {
  const fp = toolInput?.file_path ?? toolInput?.path
  if (fp && typeof fp === 'string') return fp
  const cmd = toolInput?.command
  if (cmd && typeof cmd === 'string') {
    return cmd.length > 100 ? cmd.slice(0, 97) + '...' : cmd
  }
  const pattern = toolInput?.pattern
  if (pattern && typeof pattern === 'string') return pattern
  const query = toolInput?.query
  if (query && typeof query === 'string') return query
  return null
}

/**
 * Classify file operation for the files-touched map.
 */
function classifyFileOp(toolName: string): 'read' | 'write' | null {
  if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') return 'read'
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') return 'write'
  return null
}

// ── JSONL Parsing ───────────────────────────────────────────────────────────

/**
 * Process new bytes from a tailed JSONL file.
 */
function processNewData(state: TailState): void {
  let stat: fs.Stats
  try {
    stat = fs.statSync(state.filePath)
  } catch {
    return
  }
  if (stat.size <= state.offset) return

  const fd = fs.openSync(state.filePath, 'r')
  const buf = Buffer.alloc(stat.size - state.offset)
  fs.readSync(fd, buf, 0, buf.length, state.offset)
  fs.closeSync(fd)
  state.offset = stat.size

  const text = buf.toString('utf8')
  const lines = text.split('\n').filter(l => l.trim())

  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      processJsonlEntry(obj, state)
    } catch {
      // Skip malformed lines
    }
  }
}

/**
 * Process a single JSONL entry and emit LiveEvents.
 */
function processJsonlEntry(obj: Record<string, unknown>, state: TailState): void {
  const type = obj.type as string
  const timestamp = (obj.timestamp as string) ?? new Date().toISOString()
  const now = Date.now()

  // Check for rate-limit gap
  if (state.lastEventTs > 0) {
    const gap = now - state.lastEventTs
    if (gap >= GAP_THRESHOLD_MS && state.status !== 'rate-limited') {
      state.status = 'rate-limited'
      emit({
        id: uid(),
        sessionId: state.sessionId,
        timestamp,
        kind: 'status-change',
        sessionStatus: 'rate-limited',
      })
      emit({
        id: uid(),
        sessionId: state.sessionId,
        timestamp,
        kind: 'anomaly',
        anomalyKind: 'rate-limit',
        anomalyMessage: `${Math.round(gap / 1000)}s gap — possible rate limiting`,
      })
    }
  }
  state.lastEventTs = now

  // ── Human message = new turn ──────────────────────────
  if (type === 'human') {
    state.turnIndex++
    if (state.status !== 'active') {
      state.status = 'active'
      emit({
        id: uid(),
        sessionId: state.sessionId,
        timestamp,
        kind: 'status-change',
        sessionStatus: 'active',
      })
    }
    return
  }

  // ── Assistant message = thinking + tool calls ─────────
  if (type === 'assistant') {
    const message = obj.message as Record<string, unknown> | undefined
    if (!message) return

    const content = message.content as unknown[]
    if (!Array.isArray(content)) return

    // Extract thinking
    const thinking = extractThinking(content)
    if (thinking) {
      emit({
        id: uid(),
        sessionId: state.sessionId,
        timestamp,
        kind: 'thinking',
        thinkingSummary: thinking,
      })
    }

    // Extract tool calls
    for (const block of content) {
      const b = block as Record<string, unknown>
      if (b.type !== 'tool_use') continue

      const toolName = (b.name as string) ?? 'unknown'
      const toolInput = (b.input as Record<string, unknown>) ?? {}
      const target = extractTarget(toolName, toolInput)

      emit({
        id: uid(),
        sessionId: state.sessionId,
        timestamp,
        kind: 'tool-call',
        toolName,
        target: target ?? undefined,
        status: 'running',
      })
    }

    // Mark active
    if (state.status !== 'active') {
      state.status = 'active'
      emit({
        id: uid(),
        sessionId: state.sessionId,
        timestamp,
        kind: 'status-change',
        sessionStatus: 'active',
      })
    }
    return
  }

  // ── Tool result = completion ──────────────────────────
  if (type === 'tool_result') {
    const toolName = (obj.tool_name as string) ?? null
    const isError = obj.is_error === true
    const target = toolName ? extractTarget(toolName, obj as Record<string, unknown>) : undefined

    if (toolName) {
      emit({
        id: uid(),
        sessionId: state.sessionId,
        timestamp,
        kind: 'tool-call',
        toolName,
        target: target ?? undefined,
        status: isError ? 'error' : 'success',
      })
    }
    return
  }
}

// ── Session Management ──────────────────────────────────────────────────────

/**
 * Find the most recent JSONL file in a Claude project directory.
 */
function findActiveJsonl(projectDir: string): string | null {
  try {
    const entries = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        path: path.join(projectDir, f),
        mtime: fs.statSync(path.join(projectDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)

    return entries.length > 0 ? entries[0].path : null
  } catch {
    return null
  }
}

/**
 * Start tailing a session's JSONL file.
 */
function startTail(sessionId: string, repoRoot: string): void {
  const slug = claudeSlug(repoRoot)
  const projectDir = path.join(os.homedir(), '.claude', 'projects', slug)

  if (!fs.existsSync(projectDir)) return

  const jsonlPath = findActiveJsonl(projectDir)
  if (!jsonlPath) return

  // Skip to end of file (we only want new data)
  let offset = 0
  try {
    offset = fs.statSync(jsonlPath).size
  } catch { /* start from 0 */ }

  const state: TailState = {
    filePath: jsonlPath,
    offset,
    sessionId,
    lastEventTs: Date.now(),
    status: 'active',
    turnIndex: 0,
  }
  tails.set(sessionId, state)

  // Watch the project directory for changes
  try {
    const watcher = fs.watch(projectDir, { recursive: true }, (_eventType, filename) => {
      if (!filename?.endsWith('.jsonl')) return

      const key = `live:${sessionId}`
      if (debounceTimers.has(key)) clearTimeout(debounceTimers.get(key)!)
      debounceTimers.set(key, setTimeout(() => {
        debounceTimers.delete(key)

        // Check if the active file changed (new conversation started)
        const currentActive = findActiveJsonl(projectDir)
        if (currentActive && currentActive !== state.filePath) {
          state.filePath = currentActive
          state.offset = 0
          state.turnIndex = 0
        }

        processNewData(state)
      }, DEBOUNCE_MS))
    })
    watchers.set(sessionId, watcher)
  } catch (err) {
    console.warn(`[live-tailer] Failed to watch ${projectDir}:`, err)
  }

  // Emit initial status
  emit({
    id: uid(),
    sessionId,
    timestamp: new Date().toISOString(),
    kind: 'status-change',
    sessionStatus: 'active',
  })
}

/**
 * Stop tailing a session.
 */
function stopTail(sessionId: string): void {
  tails.delete(sessionId)
  const watcher = watchers.get(sessionId)
  if (watcher) {
    try { watcher.close() } catch { /* already closed */ }
    watchers.delete(sessionId)
  }
  const key = `live:${sessionId}`
  if (debounceTimers.has(key)) {
    clearTimeout(debounceTimers.get(key)!)
    debounceTimers.delete(key)
  }
}

// ── Status Polling ──────────────────────────────────────────────────────────

/**
 * Periodically check for idle sessions (no events for IDLE_THRESHOLD_MS).
 */
function checkIdleStatus(): void {
  const now = Date.now()
  for (const [sessionId, state] of tails) {
    if (state.status === 'idle' || state.status === 'rate-limited') continue
    if (now - state.lastEventTs >= IDLE_THRESHOLD_MS) {
      state.status = 'idle'
      emit({
        id: uid(),
        sessionId,
        timestamp: new Date().toISOString(),
        kind: 'status-change',
        sessionStatus: 'idle',
      })
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface LiveTailerOptions {
  sendToRenderer: (channel: string, payload: unknown) => void
  getSessionMap: () => Map<string, string>
}

/**
 * Initialize the live tailer. Call once from app.whenReady().
 */
export function startLiveTailer(opts: LiveTailerOptions): void {
  sendToRenderer = opts.sendToRenderer
  getSessionMap = opts.getSessionMap

  // Start tailing all current sessions
  for (const [sessionId, repoRoot] of opts.getSessionMap()) {
    startTail(sessionId, repoRoot)
  }

  // Idle-check interval
  statusInterval = setInterval(checkIdleStatus, 5_000)

  console.log(`[live-tailer] Started, tailing ${tails.size} sessions`)
}

/**
 * Start tailing a new session (call when a session is created).
 */
export function liveTailerAddSession(sessionId: string, repoRoot: string): void {
  if (tails.has(sessionId)) return
  startTail(sessionId, repoRoot)
}

/**
 * Stop tailing a session (call when a session is closed).
 */
export function liveTailerRemoveSession(sessionId: string): void {
  stopTail(sessionId)
}

/**
 * Clean up all watchers. Call on app quit.
 */
export function stopLiveTailer(): void {
  if (statusInterval) {
    clearInterval(statusInterval)
    statusInterval = null
  }
  for (const sessionId of [...tails.keys()]) {
    stopTail(sessionId)
  }
  console.log('[live-tailer] Stopped')
}
```

**Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/main/services/live-tailer.ts
git commit -m "feat: add live-tailer service for real-time JSONL tailing"
```

---

### Task 3: Wire live-tailer into main process and add IPC

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

**Step 1: Add imports and startup in main/index.ts**

At the top of `src/main/index.ts`, add the import alongside other service imports:

```typescript
import { startLiveTailer, stopLiveTailer, liveTailerAddSession, liveTailerRemoveSession } from './services/live-tailer'
```

In the `app.whenReady()` block, after `startUsageWatcher(...)`, add:

```typescript
startLiveTailer({
  sendToRenderer,
  getSessionMap: () => {
    const map = new Map<string, string>()
    const result = sessionStore.listSessions()
    if (result.ok && result.sessions) {
      for (const s of result.sessions) {
        if (s.repoRoot) map.set(s.id, s.repoRoot)
      }
    }
    return map
  },
})
```

In the `app.on('before-quit')` handler, add `stopLiveTailer()` alongside `stopUsageWatcher()`.

**Step 2: Hook into session lifecycle**

Find the `latch:session-create` IPC handler. After the session is created and returned, add:

```typescript
if (result.ok && result.session?.repoRoot) {
  liveTailerAddSession(result.session.id, result.session.repoRoot)
}
```

Find the session delete/close handler (or the PTY exit handler). Add:

```typescript
liveTailerRemoveSession(sessionId)
```

**Step 3: Add preload listener**

In `src/preload/index.ts`, near the other `on*` listeners (around line 197-210), add:

```typescript
onLiveEvent: (callback: (event: any) => void) => {
  const handler = (_event: any, payload: any) => callback(payload)
  ipcRenderer.on('latch:live-event', handler)
  return () => { ipcRenderer.removeListener('latch:live-event', handler) }
},
```

**Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/main/index.ts src/preload/index.ts
git commit -m "feat: wire live-tailer into main process and preload bridge"
```

---

### Task 4: Add Zustand store state and actions

**Files:**
- Modify: `src/renderer/store/useAppStore.ts`

**Step 1: Add imports**

Add to the type imports at the top:

```typescript
import type { ..., LiveEvent, LiveSessionStats } from '../../types'
```

**Step 2: Add state fields**

In the state interface section, add after the analytics state:

```typescript
// ── Live Tailing ──────────────────────────────────────────────────────────
liveEvents: Map<string, LiveEvent[]>;
liveSessionStats: Map<string, LiveSessionStats>;
liveDetailSessionId: string | null;
```

**Step 3: Add action signatures**

In the actions section, add:

```typescript
// Live tailing
handleLiveEvent:      (event: LiveEvent) => void;
setLiveDetailSession: (sessionId: string | null) => void;
```

**Step 4: Add initial state**

In the initial state section, add:

```typescript
liveEvents:          new Map(),
liveSessionStats:    new Map(),
liveDetailSessionId: null,
```

**Step 5: Add action implementations**

Add the action implementations:

```typescript
// ── Live Tailing ──────────────────────────────────────────────────────

handleLiveEvent: (event) => {
  set((s) => {
    // Update events ring buffer (1000 per session)
    const liveEvents = new Map(s.liveEvents)
    const sessionEvents = [...(liveEvents.get(event.sessionId) ?? []), event].slice(-1000)
    liveEvents.set(event.sessionId, sessionEvents)

    // Update running stats
    const liveSessionStats = new Map(s.liveSessionStats)
    const existing = liveSessionStats.get(event.sessionId) ?? {
      sessionId: event.sessionId,
      totalCostUsd: 0,
      turnCount: 0,
      startedAt: event.timestamp,
      lastEventAt: event.timestamp,
      filesTouched: new Map(),
      cacheHitRatio: 0,
      totalInputTokens: 0,
      totalCacheReadTokens: 0,
    }

    existing.lastEventAt = event.timestamp

    if (event.kind === 'tool-call') {
      if (event.costUsd) existing.totalCostUsd += event.costUsd
      if (event.inputTokens) existing.totalInputTokens += event.inputTokens

      // Track files touched
      if (event.target && event.toolName) {
        const isFile = event.target.includes('/') || event.target.includes('.')
        if (isFile) {
          const fileStat = existing.filesTouched.get(event.target) ?? { reads: 0, writes: 0 }
          const writeTools = new Set(['Write', 'Edit', 'NotebookEdit'])
          if (writeTools.has(event.toolName)) {
            fileStat.writes++
          } else {
            fileStat.reads++
          }
          existing.filesTouched.set(event.target, fileStat)
        }
      }
    }

    if (event.kind === 'status-change' && event.sessionStatus === 'active') {
      // New turn when going from non-active to active
      existing.turnCount++
    }

    liveSessionStats.set(event.sessionId, existing)

    return { liveEvents, liveSessionStats }
  })
},

setLiveDetailSession: (sessionId) => {
  set({ liveDetailSessionId: sessionId })
},
```

**Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 7: Commit**

```bash
git add src/renderer/store/useAppStore.ts
git commit -m "feat: add live tailing state and actions to Zustand store"
```

---

### Task 5: Register live event listener in App.tsx and add route

**Files:**
- Modify: `src/renderer/App.tsx`

**Step 1: Add the live event listener**

In the `useEffect` hook where all push event listeners are registered (around line 86-150), add alongside the other listeners:

```typescript
const disposeLiveEvent = window.latch?.onLiveEvent?.((event) => {
  handleLiveEvent(event)
})
```

Add `handleLiveEvent` to the destructured store actions at the top of the component.

In the cleanup return, add:

```typescript
disposeLiveEvent?.()
```

**Step 2: Add the view route**

Add the import at the top:

```typescript
import LiveView from './components/LiveView'
```

In the view routing section, add before or after the analytics route:

```typescript
{activeView === 'live' && <LiveView />}
```

**Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: FAIL — `LiveView` doesn't exist yet. That's fine, we'll create it next.

**Step 4: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: register live event listener and add live view route"
```

---

### Task 6: Add Live nav item to Sidebar

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`

**Step 1: Add icon import**

Add `Pulse` to the phosphor-icons import:

```typescript
import { ..., Pulse } from '@phosphor-icons/react'
```

**Step 2: Add nav button**

In the Observe section (after `<div className="sidebar-nav-group-label">Observe</div>`, before the Usage button), add:

```typescript
<button
  className={`sidebar-nav-item${activeView === 'live' ? ' is-active' : ''}`}
  onClick={() => setActiveView('live')}
>
  <Pulse className="sidebar-nav-icon" weight="light" />
  Live
</button>
```

**Step 3: Commit**

```bash
git add src/renderer/components/Sidebar.tsx
git commit -m "feat: add Live nav item to sidebar"
```

---

### Task 7: Create LiveView component

This is the main UI — session cards overview with drill-down to full trace.

**Files:**
- Create: `src/renderer/components/LiveView.tsx`

**Step 1: Create the component**

Create `src/renderer/components/LiveView.tsx`:

```typescript
// src/renderer/components/LiveView.tsx

/**
 * @module LiveView
 * @description Real-time session tailing — session cards overview with
 * drill-down to full tool call trace, thinking summaries, and anomaly warnings.
 */

import React, { useEffect, useRef } from 'react'
import { Pulse, ArrowLeft, XCircle } from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'
import type { LiveEvent, LiveSessionStats } from '../../types'

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  if (usd >= 0.01) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(3)}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatElapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime()
  const sec = Math.floor(ms / 1000) % 60
  const min = Math.floor(ms / 60_000) % 60
  const hr = Math.floor(ms / 3_600_000)
  if (hr > 0) return `${hr}h ${min}m`
  if (min > 0) return `${min}m ${sec}s`
  return `${sec}s`
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

const STATUS_COLORS: Record<string, string> = {
  active:        'var(--success)',
  thinking:      'var(--warning)',
  idle:          'var(--text-tertiary)',
  'rate-limited': 'rgb(var(--d-red, 248 113 113))',
}

const STATUS_LABELS: Record<string, string> = {
  active:        'Active',
  thinking:      'Thinking',
  idle:          'Idle',
  'rate-limited': 'Rate Limited',
}

// ── Root Component ──────────────────────────────────────────────────────────

export default function LiveView() {
  const {
    liveEvents,
    liveSessionStats,
    liveDetailSessionId,
    sessions,
    setLiveDetailSession,
  } = useAppStore()

  // If drilling into a session, show detail
  if (liveDetailSessionId) {
    return <SessionDetail sessionId={liveDetailSessionId} />
  }

  // Build list of sessions with live data
  const activeSessions = sessions
    .filter(s => s.status === 'active' || liveSessionStats.has(s.id))
    .sort((a, b) => {
      const statsA = liveSessionStats.get(a.id)
      const statsB = liveSessionStats.get(b.id)
      const tA = statsA ? new Date(statsA.lastEventAt).getTime() : 0
      const tB = statsB ? new Date(statsB.lastEventAt).getTime() : 0
      return tB - tA
    })

  return (
    <div className="view-container">
      <div className="view-header">
        <h1 className="view-title">Live</h1>
      </div>

      {activeSessions.length === 0 ? (
        <div className="an-empty">
          <Pulse size={48} weight="light" className="an-empty-icon" />
          <span className="an-empty-text">No active sessions</span>
          <span className="an-empty-hint">Start an agent session to see real-time activity here.</span>
        </div>
      ) : (
        <div className="live-card-grid">
          {activeSessions.map(session => (
            <SessionCard
              key={session.id}
              session={session}
              stats={liveSessionStats.get(session.id) ?? null}
              events={liveEvents.get(session.id) ?? []}
              onClick={() => setLiveDetailSession(session.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Session Card ────────────────────────────────────────────────────────────

function SessionCard({
  session,
  stats,
  events,
  onClick,
}: {
  session: { id: string; name: string; harnessId: string | null }
  stats: LiveSessionStats | null
  events: LiveEvent[]
  onClick: () => void
}) {
  // Find current status from most recent status-change event
  const statusEvent = [...events].reverse().find(e => e.kind === 'status-change')
  const status = statusEvent?.sessionStatus ?? 'idle'

  // Find last tool call for "last action"
  const lastToolCall = [...events].reverse().find(e => e.kind === 'tool-call')
  const lastAction = lastToolCall
    ? `${lastToolCall.toolName}${lastToolCall.target ? ` ${lastToolCall.target.split('/').pop()}` : ''}`
    : null

  return (
    <div className="live-card" onClick={onClick}>
      <div className="live-card-header">
        <div className="live-card-status">
          <span
            className={`live-status-dot${status === 'active' ? ' is-pulsing' : ''}`}
            style={{ background: STATUS_COLORS[status] ?? STATUS_COLORS.idle }}
          />
          <span className="live-card-name">{session.name}</span>
        </div>
        <span className="live-card-harness">{session.harnessId ?? 'unknown'}</span>
      </div>

      <div className="live-card-stats">
        <div className="live-card-stat">
          <span className="live-card-stat-value">{formatCost(stats?.totalCostUsd ?? 0)}</span>
          <span className="live-card-stat-label">Cost</span>
        </div>
        <div className="live-card-stat">
          <span className="live-card-stat-value">{stats?.turnCount ?? 0}</span>
          <span className="live-card-stat-label">Turns</span>
        </div>
        <div className="live-card-stat">
          <span className="live-card-stat-value">{stats ? formatElapsed(stats.startedAt) : '—'}</span>
          <span className="live-card-stat-label">Elapsed</span>
        </div>
        <div className="live-card-stat">
          <span className="live-card-stat-value">{stats ? stats.filesTouched.size : 0}</span>
          <span className="live-card-stat-label">Files</span>
        </div>
      </div>

      {lastAction && (
        <div className="live-card-last-action">
          <span className="live-card-action-label">Last:</span>
          <span className="live-card-action-value">{lastAction}</span>
        </div>
      )}

      <div className="live-card-status-label" style={{ color: STATUS_COLORS[status] }}>
        {STATUS_LABELS[status] ?? status}
      </div>
    </div>
  )
}

// ── Session Detail ──────────────────────────────────────────────────────────

function SessionDetail({ sessionId }: { sessionId: string }) {
  const {
    liveEvents,
    liveSessionStats,
    sessions,
    setLiveDetailSession,
  } = useAppStore()

  const events = liveEvents.get(sessionId) ?? []
  const stats = liveSessionStats.get(sessionId)
  const session = sessions.find(s => s.id === sessionId)

  const streamRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (autoScrollRef.current && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight
    }
  }, [events.length])

  // Detect manual scroll to pause auto-scroll
  const handleScroll = () => {
    if (!streamRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = streamRef.current
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 50
  }

  const statusEvent = [...events].reverse().find(e => e.kind === 'status-change')
  const status = statusEvent?.sessionStatus ?? 'idle'

  return (
    <div className="view-container">
      <div className="view-header">
        <button className="an-back-btn" onClick={() => setLiveDetailSession(null)}>
          <ArrowLeft size={16} weight="bold" />
          All Sessions
        </button>
        <h1 className="view-title">{session?.name ?? sessionId}</h1>
        <span
          className={`live-status-dot live-status-dot-header${status === 'active' ? ' is-pulsing' : ''}`}
          style={{ background: STATUS_COLORS[status] }}
        />
      </div>

      {/* Running stats bar */}
      {stats && (
        <div className="live-stats-bar">
          <div className="live-stats-item">
            <span className="live-stats-value">{formatCost(stats.totalCostUsd)}</span>
            <span className="live-stats-label">Cost</span>
          </div>
          <div className="live-stats-item">
            <span className="live-stats-value">{stats.turnCount}</span>
            <span className="live-stats-label">Turns</span>
          </div>
          <div className="live-stats-item">
            <span className="live-stats-value">{formatElapsed(stats.startedAt)}</span>
            <span className="live-stats-label">Elapsed</span>
          </div>
          <div className="live-stats-item">
            <span className="live-stats-value">{stats.filesTouched.size}</span>
            <span className="live-stats-label">Files Touched</span>
          </div>
          <div className="live-stats-item">
            <span className="live-stats-value">{formatTokens(stats.totalInputTokens)}</span>
            <span className="live-stats-label">Input Tokens</span>
          </div>
        </div>
      )}

      {/* Event stream */}
      <div className="live-stream" ref={streamRef} onScroll={handleScroll}>
        {events.length === 0 ? (
          <div className="an-empty-text" style={{ padding: 32 }}>Waiting for events...</div>
        ) : (
          events.map(event => <EventRow key={event.id} event={event} />)
        )}
      </div>

      {/* Jump to latest button */}
      {!autoScrollRef.current && events.length > 0 && (
        <button
          className="live-jump-btn"
          onClick={() => {
            autoScrollRef.current = true
            streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: 'smooth' })
          }}
        >
          Jump to latest
        </button>
      )}
    </div>
  )
}

// ── Event Row ───────────────────────────────────────────────────────────────

function EventRow({ event }: { event: LiveEvent }) {
  if (event.kind === 'tool-call') {
    return (
      <div className={`live-event live-event-tool${event.status === 'error' ? ' is-error' : ''}`}>
        <span className="live-event-time">{formatTime(event.timestamp)}</span>
        <span className={`live-event-status-icon${event.status === 'running' ? ' is-running' : ''}`}>
          {event.status === 'success' ? '✓' : event.status === 'error' ? '✗' : '●'}
        </span>
        <span className="live-event-tool">{event.toolName}</span>
        {event.target && <span className="live-event-target">{event.target}</span>}
        {event.costUsd != null && event.costUsd > 0 && (
          <span className="live-event-cost">{formatCost(event.costUsd)}</span>
        )}
        {event.durationMs != null && (
          <span className="live-event-duration">{(event.durationMs / 1000).toFixed(1)}s</span>
        )}
      </div>
    )
  }

  if (event.kind === 'thinking') {
    return (
      <div className="live-event live-event-thinking">
        <span className="live-event-time">{formatTime(event.timestamp)}</span>
        <span className="live-event-thinking-icon">💭</span>
        <span className="live-event-thinking-text">{event.thinkingSummary}</span>
      </div>
    )
  }

  if (event.kind === 'anomaly') {
    return (
      <div className="live-event live-event-anomaly">
        <span className="live-event-time">{formatTime(event.timestamp)}</span>
        <span className="live-event-anomaly-icon">⚠</span>
        <span className="live-event-anomaly-text">{event.anomalyMessage}</span>
      </div>
    )
  }

  if (event.kind === 'status-change') {
    return (
      <div className="live-event live-event-status">
        <span className="live-event-time">{formatTime(event.timestamp)}</span>
        <span
          className="live-event-status-dot"
          style={{ background: STATUS_COLORS[event.sessionStatus ?? 'idle'] }}
        />
        <span className="live-event-status-text">
          {STATUS_LABELS[event.sessionStatus ?? 'idle']}
        </span>
      </div>
    )
  }

  return null
}
```

**Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/renderer/components/LiveView.tsx
git commit -m "feat: create LiveView component with session cards and detail trace"
```

---

### Task 8: Add CSS styles for Live view

**Files:**
- Modify: `src/renderer/styles.css`

**Step 1: Add styles**

Add at the end of `styles.css`, before the final closing comment or at the very end:

```css
/* ══════════════════════════════════════════════════════════════════════════
   LIVE VIEW
   ══════════════════════════════════════════════════════════════════════════ */

/* ── Card grid ──────────────────────────────────────────────────────── */

.live-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
  padding: 0 0 24px;
}

.live-card {
  background: var(--bg-card);
  border-radius: 8px;
  padding: 16px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: background 0.15s;
}
.live-card:hover { background: var(--bg-hover); }

.live-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.live-card-status {
  display: flex;
  align-items: center;
  gap: 8px;
}

.live-card-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.live-card-harness {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* Status dot */
.live-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.live-status-dot.is-pulsing {
  animation: live-pulse 1.5s ease-in-out infinite;
}
.live-status-dot-header {
  width: 10px;
  height: 10px;
  margin-left: 8px;
}
@keyframes live-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.3); }
}

/* Card stats */
.live-card-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.live-card-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.live-card-stat-value {
  font-size: 16px;
  font-weight: 700;
  font-family: var(--font-mono);
  color: var(--text-primary);
}

.live-card-stat-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
}

.live-card-last-action {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  min-width: 0;
}

.live-card-action-label {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.live-card-action-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live-card-status-label {
  font-size: 11px;
  font-family: var(--font-mono);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* ── Stats bar (detail view) ────────────────────────────────────────── */

.live-stats-bar {
  display: flex;
  gap: 24px;
  padding: 12px 16px;
  background: var(--bg-card);
  border-radius: 8px;
  margin-bottom: 12px;
}

.live-stats-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.live-stats-value {
  font-size: 18px;
  font-weight: 700;
  font-family: var(--font-mono);
  color: var(--text-primary);
}

.live-stats-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
}

/* ── Event stream ───────────────────────────────────────────────────── */

.live-stream {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-height: 0;
}

.live-event {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 12px;
  font-size: 12px;
  font-family: var(--font-mono);
  background: var(--bg-card);
}

.live-event:first-child { border-radius: 6px 6px 0 0; }
.live-event:last-child { border-radius: 0 0 6px 6px; }
.live-event:only-child { border-radius: 6px; }

.live-event-time {
  color: var(--text-tertiary);
  flex-shrink: 0;
  min-width: 72px;
  font-size: 11px;
}

/* Tool call events */
.live-event-tool {
  color: rgb(var(--d-blue));
  font-weight: 600;
  flex-shrink: 0;
  min-width: 48px;
}

.live-event-target {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.live-event-cost {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.live-event-duration {
  color: var(--text-tertiary);
  flex-shrink: 0;
  min-width: 40px;
  text-align: right;
}

.live-event-status-icon {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
  color: var(--success);
  font-size: 11px;
}
.live-event-status-icon.is-running {
  color: var(--warning);
  animation: live-pulse 1s ease-in-out infinite;
}
.live-event.is-error .live-event-status-icon { color: rgb(var(--d-red, 248 113 113)); }
.live-event.is-error .live-event-tool { color: rgb(var(--d-red, 248 113 113)); }

/* Thinking events */
.live-event-thinking {
  background: rgba(251, 191, 36, 0.04);
}
.live-event-thinking-icon {
  flex-shrink: 0;
  font-size: 13px;
}
.live-event-thinking-text {
  color: var(--text-secondary);
  line-height: 1.5;
  font-style: italic;
}

/* Anomaly events */
.live-event-anomaly {
  background: rgba(248, 113, 113, 0.06);
  border-left: 3px solid rgb(var(--d-red, 248 113 113));
}
.live-event-anomaly-icon {
  flex-shrink: 0;
  color: rgb(var(--d-red, 248 113 113));
  font-size: 13px;
}
.live-event-anomaly-text {
  color: rgb(var(--d-red, 248 113 113));
  font-weight: 500;
}

/* Status change events */
.live-event-status {
  background: transparent;
  padding: 4px 12px;
  gap: 8px;
}
.live-event-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 4px;
}
.live-event-status-text {
  color: var(--text-tertiary);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* Jump to latest */
.live-jump-btn {
  position: sticky;
  bottom: 12px;
  align-self: center;
  padding: 6px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 20px;
  color: var(--text-secondary);
  font-size: 12px;
  font-family: var(--font-mono);
  cursor: pointer;
  z-index: 10;
}
.live-jump-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
```

**Step 2: Commit**

```bash
git add src/renderer/styles.css
git commit -m "feat: add CSS styles for Live view"
```

---

### Task 9: Typecheck and smoke test

**Files:** None (verification only)

**Step 1: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS with zero errors

**Step 2: Verify the app starts**

Run: `npm run dev`

Verify:
1. App launches without errors in the console
2. "Live" appears in the sidebar under Observe (first item)
3. Clicking Live shows the empty state: "No active sessions"
4. Start an agent session — a card should appear with pulsing status dot
5. Click the card — should drill into the detail view with events streaming

**Step 3: Commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address any typecheck or runtime issues in live tailing"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Types + AppView | `src/types/index.ts` |
| 2 | Live tailer service | `src/main/services/live-tailer.ts` (create) |
| 3 | Wire into main + preload | `src/main/index.ts`, `src/preload/index.ts` |
| 4 | Zustand store | `src/renderer/store/useAppStore.ts` |
| 5 | App.tsx route + listener | `src/renderer/App.tsx` |
| 6 | Sidebar nav | `src/renderer/components/Sidebar.tsx` |
| 7 | LiveView component | `src/renderer/components/LiveView.tsx` (create) |
| 8 | CSS styles | `src/renderer/styles.css` |
| 9 | Typecheck + smoke test | — |

Total: 2 new files, 6 modified files, 9 tasks.
