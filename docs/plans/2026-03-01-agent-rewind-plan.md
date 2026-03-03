# Agent Rewind — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users rewind agent sessions to auto-created checkpoints, revert file changes via git reset, and redirect the agent with new instructions via PTY context injection.

**Architecture:** A new `checkpoint-engine.ts` service hooks into the live-tailer's Write/Edit detection, debounces writes, and auto-commits to git. Checkpoint metadata is stored in SQLite via `checkpoint-store.ts`. New git IPC handlers expose log/diff/reset. A dedicated Rewind view in the sidebar shows a searchable checkpoint timeline with diffs and a "Rewind here" flow that resets git, invalidates checkpoints, and injects context into the terminal.

**Tech Stack:** TypeScript, git CLI via child_process, SQLite, existing live-tailer Write/Edit detection, PTY manager, Zustand, React.

---

### Task 1: Add Types

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Add Checkpoint interface**

Add after the `LeakMatch` interface (around line 605):

```typescript
// ── Checkpoints (Agent Rewind) ─────────────────────────────────────────────

export interface Checkpoint {
  id: string
  sessionId: string
  number: number
  commitHash: string
  turnStart: number
  turnEnd: number
  summary: string
  filesChanged: string[]
  costUsd: number
  timestamp: string
}
```

**Step 2: Add 'rewind' to AppView**

Find the `AppView` type and add `'rewind'`:

```typescript
export type AppView = '...' | 'live' | 'rewind';
```

**Step 3: Add rewind IPC methods to LatchAPI**

Add after the `respondBudgetAlert` entry:

```typescript
  // Rewind / Checkpoints
  listCheckpoints(payload: { sessionId: string }): Promise<{ ok: boolean; checkpoints: Checkpoint[] }>;
  searchCheckpoints(payload: { query: string; sessionId?: string }): Promise<{ ok: boolean; checkpoints: Checkpoint[] }>;
  gitLog(payload: { cwd: string; limit?: number }): Promise<{ ok: boolean; commits: { hash: string; message: string; timestamp: string }[]; error?: string }>;
  gitDiff(payload: { cwd: string; from: string; to?: string }): Promise<{ ok: boolean; diff: string; error?: string }>;
  rewind(payload: { sessionId: string; checkpointId: string }): Promise<{ ok: boolean; error?: string }>;
```

**Step 4: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add Checkpoint type, rewind AppView, and rewind IPC methods"
```

---

### Task 2: Create Checkpoint Store

**Files:**
- Create: `src/main/stores/checkpoint-store.ts`

Follow the exact pattern from `src/main/stores/feed-store.ts`.

**Step 1: Write the checkpoint store**

```typescript
// src/main/stores/checkpoint-store.ts

/**
 * @module checkpoint-store
 * @description SQLite-backed store for agent rewind checkpoints.
 * Each checkpoint maps to a git commit created automatically after
 * agent file writes.
 */

import type Database from 'better-sqlite3'
import type { Checkpoint } from '../../types'

let idCounter = 0

export class CheckpointStore {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  static open(db: Database.Database): CheckpointStore {
    const store = new CheckpointStore(db)
    store._init()
    return store
  }

  private _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        number      INTEGER NOT NULL,
        commit_hash TEXT NOT NULL,
        turn_start  INTEGER NOT NULL,
        turn_end    INTEGER NOT NULL,
        summary     TEXT NOT NULL,
        files       TEXT NOT NULL,
        cost_usd    REAL NOT NULL DEFAULT 0,
        timestamp   TEXT NOT NULL
      )
    `)

    try {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_checkpoints_session
          ON checkpoints (session_id, number DESC)
      `)
    } catch { /* already exists */ }
  }

  record(params: {
    sessionId: string
    number: number
    commitHash: string
    turnStart: number
    turnEnd: number
    summary: string
    filesChanged: string[]
    costUsd: number
  }): Checkpoint {
    const id = `ckpt-${Date.now()}-${++idCounter}`
    const timestamp = new Date().toISOString()

    this.db.prepare(`
      INSERT INTO checkpoints (id, session_id, number, commit_hash, turn_start, turn_end, summary, files, cost_usd, timestamp)
      VALUES (@id, @session_id, @number, @commit_hash, @turn_start, @turn_end, @summary, @files, @cost_usd, @timestamp)
    `).run({
      id,
      session_id: params.sessionId,
      number: params.number,
      commit_hash: params.commitHash,
      turn_start: params.turnStart,
      turn_end: params.turnEnd,
      summary: params.summary,
      files: JSON.stringify(params.filesChanged),
      cost_usd: params.costUsd,
      timestamp,
    })

    return {
      id,
      sessionId: params.sessionId,
      number: params.number,
      commitHash: params.commitHash,
      turnStart: params.turnStart,
      turnEnd: params.turnEnd,
      summary: params.summary,
      filesChanged: params.filesChanged,
      costUsd: params.costUsd,
      timestamp,
    }
  }

  list(sessionId: string): Checkpoint[] {
    const rows = this.db.prepare(
      'SELECT * FROM checkpoints WHERE session_id = ? ORDER BY number DESC'
    ).all(sessionId) as any[]

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      number: row.number,
      commitHash: row.commit_hash,
      turnStart: row.turn_start,
      turnEnd: row.turn_end,
      summary: row.summary,
      filesChanged: JSON.parse(row.files),
      costUsd: row.cost_usd,
      timestamp: row.timestamp,
    }))
  }

  search(query: string, sessionId?: string): Checkpoint[] {
    const pattern = `%${query}%`
    const sql = sessionId
      ? 'SELECT * FROM checkpoints WHERE session_id = ? AND (summary LIKE ? OR files LIKE ?) ORDER BY number DESC'
      : 'SELECT * FROM checkpoints WHERE summary LIKE ? OR files LIKE ? ORDER BY number DESC'
    const params = sessionId ? [sessionId, pattern, pattern] : [pattern, pattern]

    const rows = this.db.prepare(sql).all(...params) as any[]

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      number: row.number,
      commitHash: row.commit_hash,
      turnStart: row.turn_start,
      turnEnd: row.turn_end,
      summary: row.summary,
      filesChanged: JSON.parse(row.files),
      costUsd: row.cost_usd,
      timestamp: row.timestamp,
    }))
  }

  /** Delete all checkpoints after a given number for a session (used during rewind). */
  invalidateAfter(sessionId: string, afterNumber: number): void {
    this.db.prepare(
      'DELETE FROM checkpoints WHERE session_id = ? AND number > ?'
    ).run(sessionId, afterNumber)
  }

  /** Get the latest checkpoint number for a session. */
  latestNumber(sessionId: string): number {
    const row = this.db.prepare(
      'SELECT MAX(number) as max_num FROM checkpoints WHERE session_id = ?'
    ).get(sessionId) as any
    return row?.max_num ?? 0
  }

  /** Get a single checkpoint by ID. */
  get(id: string): Checkpoint | null {
    const row = this.db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id) as any
    if (!row) return null
    return {
      id: row.id,
      sessionId: row.session_id,
      number: row.number,
      commitHash: row.commit_hash,
      turnStart: row.turn_start,
      turnEnd: row.turn_end,
      summary: row.summary,
      filesChanged: JSON.parse(row.files),
      costUsd: row.cost_usd,
      timestamp: row.timestamp,
    }
  }

  clear(sessionId?: string): void {
    if (sessionId) {
      this.db.prepare('DELETE FROM checkpoints WHERE session_id = ?').run(sessionId)
    } else {
      this.db.exec('DELETE FROM checkpoints')
    }
  }
}
```

**Step 2: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/main/stores/checkpoint-store.ts
git commit -m "feat: add checkpoint-store with SQLite CRUD and search"
```

---

### Task 3: Create Checkpoint Engine Service

**Files:**
- Create: `src/main/services/checkpoint-engine.ts`

**Step 1: Write the checkpoint engine**

```typescript
// src/main/services/checkpoint-engine.ts

/**
 * @module checkpoint-engine
 * @description Auto-creates git checkpoints when agents write files.
 * Debounces writes within a 3-second window into a single checkpoint.
 * Triggered by the live-tailer's onFileWrite callback.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Checkpoint, LiveEvent } from '../../types'
import type { CheckpointStore } from '../stores/checkpoint-store'

const execFileAsync = promisify(execFile)

// ── Configuration ──────────────────────────────────────────────────────────

const DEBOUNCE_MS = 3_000

// ── Types ──────────────────────────────────────────────────────────────────

interface SessionCheckpointState {
  sessionId: string
  worktreePath: string
  pendingFiles: Set<string>
  debounceTimer: ReturnType<typeof setTimeout> | null
  lastTurnIndex: number
  lastCheckpointTurn: number
  cumulativeCostUsd: number
  lastThinkingSummary: string | null
}

export interface CheckpointEngineOptions {
  store: CheckpointStore
  sendToRenderer: (channel: string, payload: unknown) => void
  getSessionWorktree: (sessionId: string) => string | null
}

// ── State ──────────────────────────────────────────────────────────────────

const sessions = new Map<string, SessionCheckpointState>()
let _opts: CheckpointEngineOptions | null = null

// ── Helpers ────────────────────────────────────────────────────────────────

function uid(): string {
  return `ckpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function gitCommitCheckpoint(
  worktreePath: string,
  message: string,
): Promise<string | null> {
  try {
    // Stage all changes
    await execFileAsync('git', ['add', '-A'], { cwd: worktreePath })

    // Check if there are staged changes
    try {
      await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd: worktreePath })
      // If diff --cached --quiet succeeds, there are no staged changes
      return null
    } catch {
      // Non-zero exit = there ARE staged changes, proceed with commit
    }

    // Commit
    await execFileAsync('git', ['commit', '-m', message, '--no-verify'], {
      cwd: worktreePath,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Latch', GIT_AUTHOR_EMAIL: 'checkpoint@latch.dev', GIT_COMMITTER_NAME: 'Latch', GIT_COMMITTER_EMAIL: 'checkpoint@latch.dev' },
    })

    // Get the commit hash
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })
    return stdout.trim()
  } catch (err) {
    console.warn('[checkpoint-engine] Failed to create checkpoint commit:', err)
    return null
  }
}

// ── Core Logic ─────────────────────────────────────────────────────────────

function getOrCreateState(sessionId: string): SessionCheckpointState | null {
  if (sessions.has(sessionId)) return sessions.get(sessionId)!

  const worktreePath = _opts?.getSessionWorktree(sessionId)
  if (!worktreePath) return null

  const state: SessionCheckpointState = {
    sessionId,
    worktreePath,
    pendingFiles: new Set(),
    debounceTimer: null,
    lastTurnIndex: 0,
    lastCheckpointTurn: 0,
    cumulativeCostUsd: 0,
    lastThinkingSummary: null,
  }
  sessions.set(sessionId, state)
  return state
}

async function flushCheckpoint(state: SessionCheckpointState): Promise<void> {
  if (!_opts || state.pendingFiles.size === 0) return

  const filesChanged = [...state.pendingFiles]
  state.pendingFiles.clear()

  const number = _opts.store.latestNumber(state.sessionId) + 1
  const fileList = filesChanged.map(f => f.split('/').pop()).join(', ')
  const commitMsg = `latch:checkpoint #${number} — turn ${state.lastTurnIndex} [${fileList}]`

  const commitHash = await gitCommitCheckpoint(state.worktreePath, commitMsg)
  if (!commitHash) return

  const summary = state.lastThinkingSummary
    || `Modified ${filesChanged.length} file${filesChanged.length === 1 ? '' : 's'}: ${fileList}`

  const checkpoint = _opts.store.record({
    sessionId: state.sessionId,
    number,
    commitHash,
    turnStart: state.lastCheckpointTurn + 1,
    turnEnd: state.lastTurnIndex,
    summary,
    filesChanged,
    costUsd: state.cumulativeCostUsd,
  })

  state.lastCheckpointTurn = state.lastTurnIndex
  state.cumulativeCostUsd = 0
  state.lastThinkingSummary = null

  // Emit LiveEvent so checkpoint appears in Live view
  _opts.sendToRenderer('latch:live-event', {
    id: uid(),
    sessionId: state.sessionId,
    timestamp: checkpoint.timestamp,
    kind: 'anomaly',
    anomalyKind: 'checkpoint',
    anomalyMessage: `Checkpoint #${number}: ${summary}`,
  } satisfies LiveEvent)

  console.log(`[checkpoint-engine] Created checkpoint #${number} for session ${state.sessionId} (${commitHash.slice(0, 7)})`)
}

// ── Public API ─────────────────────────────────────────────────────────────

export function startCheckpointEngine(opts: CheckpointEngineOptions): void {
  _opts = opts
  console.log('[checkpoint-engine] Started')
}

/**
 * Called by the live-tailer when a Write/Edit tool call is detected.
 */
export function checkpointOnFileWrite(sessionId: string, filePath: string): void {
  if (!_opts) return

  const state = getOrCreateState(sessionId)
  if (!state) return

  state.pendingFiles.add(filePath)

  // Debounce: batch writes within DEBOUNCE_MS into one checkpoint
  if (state.debounceTimer) clearTimeout(state.debounceTimer)
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null
    flushCheckpoint(state).catch(err => {
      console.warn('[checkpoint-engine] Flush error:', err)
    })
  }, DEBOUNCE_MS)
}

/**
 * Update turn index and thinking summary from live events.
 * Called when live-tailer processes thinking or tool-call events.
 */
export function checkpointUpdateTurn(sessionId: string, turnIndex: number, thinkingSummary?: string, costUsd?: number): void {
  const state = sessions.get(sessionId)
  if (!state) return

  state.lastTurnIndex = Math.max(state.lastTurnIndex, turnIndex)
  if (thinkingSummary) state.lastThinkingSummary = thinkingSummary
  if (costUsd) state.cumulativeCostUsd += costUsd
}

export function checkpointRemoveSession(sessionId: string): void {
  const state = sessions.get(sessionId)
  if (state?.debounceTimer) clearTimeout(state.debounceTimer)
  sessions.delete(sessionId)
}

export function stopCheckpointEngine(): void {
  for (const [, state] of sessions) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
  }
  sessions.clear()
  _opts = null
  console.log('[checkpoint-engine] Stopped')
}
```

**Step 2: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/main/services/checkpoint-engine.ts
git commit -m "feat: add checkpoint-engine with debounced auto-commit on agent writes"
```

---

### Task 4: Add onFileWrite to Live Tailer

**Files:**
- Modify: `src/main/services/live-tailer.ts`

**Step 1: Add onFileWrite to LiveTailerOptions**

In `LiveTailerOptions`, add:

```typescript
onFileWrite?: (sessionId: string, filePath: string) => void
```

**Step 2: Store the callback**

Add alongside `_onLeakDetected`:

```typescript
let _onFileWrite: ((sessionId: string, filePath: string) => void) | null = null
```

In `startLiveTailer`, add:

```typescript
_onFileWrite = opts.onFileWrite ?? null
```

**Step 3: Call it when Write/Edit is detected**

In `processJsonlEntry`, inside the Write/Edit scan block (where leak scanning already happens), add after the leak scanning:

```typescript
_onFileWrite?.(state.sessionId, filePath || toolName)
```

**Step 4: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/main/services/live-tailer.ts
git commit -m "feat: add onFileWrite callback to live-tailer for checkpoint engine"
```

---

### Task 5: Wire Checkpoint Engine + Git IPC into Main Process

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

**Step 1: Import and initialize checkpoint store and engine**

Add imports:

```typescript
import { CheckpointStore } from './stores/checkpoint-store'
import {
  startCheckpointEngine,
  checkpointOnFileWrite,
  checkpointUpdateTurn,
  checkpointRemoveSession,
  stopCheckpointEngine,
} from './services/checkpoint-engine'
```

Add `checkpointStore` variable alongside other stores. Initialize in the try block:

```typescript
checkpointStore = CheckpointStore.open(db)
```

Start the engine after the live-tailer starts:

```typescript
startCheckpointEngine({
  store: checkpointStore,
  sendToRenderer,
  getSessionWorktree: (sessionId) => {
    const result = sessionStore.listSessions() as any
    const sessions = result?.sessions ?? []
    const row = sessions.find((s: any) => s.id === sessionId)
    return row?.worktree_path ?? row?.project_dir ?? null
  },
})
```

**Step 2: Wire onFileWrite into live-tailer options**

In the `startLiveTailer()` call, add the `onFileWrite` callback:

```typescript
onFileWrite: (sessionId, filePath) => {
  checkpointOnFileWrite(sessionId, filePath)
},
```

**Step 3: Add git IPC handlers**

```typescript
// ── Git operations for rewind ────────────────────────────────────────────

ipcMain.handle('latch:git-log', async (_event: any, payload: any) => {
  const { cwd, limit = 50 } = payload ?? {}
  if (!cwd) return { ok: false, error: 'Missing cwd' }
  try {
    const { stdout } = await execFileAsync('git', [
      'log', `--max-count=${limit}`, '--format=%H|%s|%aI',
    ], { cwd })
    const commits = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [hash, message, timestamp] = line.split('|')
      return { hash, message, timestamp }
    })
    return { ok: true, commits }
  } catch (err: any) {
    return { ok: false, error: err.message, commits: [] }
  }
})

ipcMain.handle('latch:git-diff', async (_event: any, payload: any) => {
  const { cwd, from, to } = payload ?? {}
  if (!cwd || !from) return { ok: false, error: 'Missing cwd or from' }
  try {
    const args = to ? ['diff', from, to] : ['diff', from, 'HEAD']
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 1024 * 1024 * 5 })
    return { ok: true, diff: stdout }
  } catch (err: any) {
    return { ok: false, error: err.message, diff: '' }
  }
})
```

Note: `execFileAsync` from `node:child_process` — import `execFile` and `promisify` at the top of `index.ts` if not already imported. Check first — `git-workspaces.ts` is imported and it uses this, but the main index.ts may need its own.

**Step 4: Add rewind IPC handler**

```typescript
ipcMain.handle('latch:rewind', async (_event: any, payload: any) => {
  const { sessionId, checkpointId } = payload ?? {}
  if (!sessionId || !checkpointId) return { ok: false, error: 'Missing sessionId or checkpointId' }

  const checkpoint = checkpointStore.get(checkpointId)
  if (!checkpoint) return { ok: false, error: 'Checkpoint not found' }

  // Find the worktree path
  const result = sessionStore.listSessions() as any
  const sessions = result?.sessions ?? []
  const row = sessions.find((s: any) => s.id === sessionId)
  const cwd = row?.worktree_path ?? row?.project_dir
  if (!cwd) return { ok: false, error: 'Session has no worktree' }

  try {
    // Git reset --hard to checkpoint commit
    await execFileAsync('git', ['reset', '--hard', checkpoint.commitHash], { cwd })

    // Invalidate checkpoints after this one
    checkpointStore.invalidateAfter(sessionId, checkpoint.number)

    // Record feed item
    feedStore.record({
      sessionId,
      message: `Rewound to checkpoint #${checkpoint.number}: ${checkpoint.summary}`,
      harnessId: 'latch',
    })

    // Build rewind context message for the agent
    const filesReverted = checkpoint.filesChanged.map(f => `- ${f}`).join('\n')
    // Get checkpoints that were invalidated to describe what was reverted
    const rewindContext = [
      `[LATCH REWIND] Codebase reverted to checkpoint #${checkpoint.number} (after turn ${checkpoint.turnEnd}).`,
      '',
      `Changes after turn ${checkpoint.turnEnd} were abandoned. Files on disk match the state at turn ${checkpoint.turnEnd}.`,
      '',
      'Your new direction:',
    ].join('\n')

    return { ok: true, rewindContext }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

// Checkpoint list/search handlers
ipcMain.handle('latch:checkpoint-list', async (_event: any, payload: any) => {
  const { sessionId } = payload ?? {}
  if (!sessionId) return { ok: false, checkpoints: [] }
  return { ok: true, checkpoints: checkpointStore.list(sessionId) }
})

ipcMain.handle('latch:checkpoint-search', async (_event: any, payload: any) => {
  const { query, sessionId } = payload ?? {}
  if (!query) return { ok: true, checkpoints: [] }
  return { ok: true, checkpoints: checkpointStore.search(query, sessionId) }
})
```

**Step 5: Add cleanup in before-quit**

```typescript
stopCheckpointEngine()
```

**Step 6: Add preload bridges**

In `src/preload/index.ts`:

```typescript
listCheckpoints: (payload: { sessionId: string }) =>
  ipcRenderer.invoke('latch:checkpoint-list', payload),

searchCheckpoints: (payload: { query: string; sessionId?: string }) =>
  ipcRenderer.invoke('latch:checkpoint-search', payload),

gitLog: (payload: { cwd: string; limit?: number }) =>
  ipcRenderer.invoke('latch:git-log', payload),

gitDiff: (payload: { cwd: string; from: string; to?: string }) =>
  ipcRenderer.invoke('latch:git-diff', payload),

rewind: (payload: { sessionId: string; checkpointId: string }) =>
  ipcRenderer.invoke('latch:rewind', payload),
```

**Step 7: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 8: Commit**

```bash
git add src/main/index.ts src/preload/index.ts
git commit -m "feat: wire checkpoint engine and git rewind IPC handlers into main process"
```

---

### Task 6: Zustand Store Updates

**Files:**
- Modify: `src/renderer/store/useAppStore.ts`

**Step 1: Import Checkpoint**

Add `Checkpoint` to the type imports from `../../types`.

**Step 2: Add state**

```typescript
// ── Rewind ─────────────────────────────────────────────────────────────────
rewindSessionId: string | null;
rewindCheckpoints: Checkpoint[];
rewindSelectedCheckpoint: Checkpoint | null;
rewindDiff: string | null;
rewindLoading: boolean;
rewindSearchQuery: string;
```

**Step 3: Add actions to interface**

```typescript
// Rewind
setRewindSession: (sessionId: string | null) => void;
loadCheckpoints: (sessionId: string) => Promise<void>;
searchCheckpoints: (query: string) => Promise<void>;
selectCheckpoint: (checkpoint: Checkpoint | null) => void;
loadCheckpointDiff: (checkpoint: Checkpoint) => Promise<void>;
executeRewind: (checkpointId: string) => Promise<{ ok: boolean; rewindContext?: string; error?: string }>;
```

**Step 4: Add initial state**

```typescript
rewindSessionId: null,
rewindCheckpoints: [],
rewindSelectedCheckpoint: null,
rewindDiff: null,
rewindLoading: false,
rewindSearchQuery: '',
```

**Step 5: Add action implementations**

```typescript
setRewindSession: (sessionId) => {
  set({ rewindSessionId: sessionId, rewindCheckpoints: [], rewindSelectedCheckpoint: null, rewindDiff: null, rewindSearchQuery: '' })
  if (sessionId) get().loadCheckpoints(sessionId)
},

loadCheckpoints: async (sessionId) => {
  set({ rewindLoading: true })
  const res = await window.latch?.listCheckpoints?.({ sessionId })
  set({ rewindCheckpoints: res?.checkpoints ?? [], rewindLoading: false })
},

searchCheckpoints: async (query) => {
  const { rewindSessionId } = get()
  set({ rewindSearchQuery: query })
  if (!query.trim()) {
    if (rewindSessionId) get().loadCheckpoints(rewindSessionId)
    return
  }
  set({ rewindLoading: true })
  const res = await window.latch?.searchCheckpoints?.({ query, sessionId: rewindSessionId ?? undefined })
  set({ rewindCheckpoints: res?.checkpoints ?? [], rewindLoading: false })
},

selectCheckpoint: (checkpoint) => {
  set({ rewindSelectedCheckpoint: checkpoint, rewindDiff: null })
  if (checkpoint) get().loadCheckpointDiff(checkpoint)
},

loadCheckpointDiff: async (checkpoint) => {
  const { sessions, rewindSessionId } = get()
  if (!rewindSessionId) return
  const session = sessions.get(rewindSessionId)
  const cwd = session?.worktreePath ?? session?.projectDir
  if (!cwd) return
  const res = await window.latch?.gitDiff?.({ cwd, from: checkpoint.commitHash })
  set({ rewindDiff: res?.ok ? res.diff : null })
},

executeRewind: async (checkpointId) => {
  const { rewindSessionId } = get()
  if (!rewindSessionId) return { ok: false, error: 'No session selected' }
  const res = await window.latch?.rewind?.({ sessionId: rewindSessionId, checkpointId })
  if (res?.ok) {
    get().loadCheckpoints(rewindSessionId)
    set({ rewindSelectedCheckpoint: null, rewindDiff: null })
  }
  return res ?? { ok: false, error: 'IPC failed' }
},
```

**Step 6: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 7: Commit**

```bash
git add src/renderer/store/useAppStore.ts
git commit -m "feat: add rewind state and actions to Zustand store"
```

---

### Task 7: Create RewindView Component

**Files:**
- Create: `src/renderer/components/RewindView.tsx`

**Step 1: Write the Rewind view**

```tsx
// src/renderer/components/RewindView.tsx

import React, { useEffect, useState } from 'react'
import { ArrowCounterClockwise, MagnifyingGlass, ArrowLeft } from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'
import type { Checkpoint } from '../../types'

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  if (usd >= 0.01) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(3)}`
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatDate(ts: string): string {
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ── Root ────────────────────────────────────────────────────────────────────

export default function RewindView() {
  const {
    sessions,
    rewindSessionId,
    rewindCheckpoints,
    rewindSelectedCheckpoint,
    rewindDiff,
    rewindLoading,
    rewindSearchQuery,
    setRewindSession,
    searchCheckpoints,
    selectCheckpoint,
    executeRewind,
  } = useAppStore()

  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState('')

  // Get sessions with worktrees (only these can have checkpoints)
  const eligibleSessions = Array.from(sessions.values()).filter(
    s => s.worktreePath || s.repoRoot
  )

  // Auto-select first eligible session
  useEffect(() => {
    if (!rewindSessionId && eligibleSessions.length > 0) {
      setRewindSession(eligibleSessions[0].id)
    }
  }, [eligibleSessions.length])

  const handleSearch = (value: string) => {
    setSearchInput(value)
    searchCheckpoints(value)
  }

  const handleRewind = async (checkpoint: Checkpoint) => {
    const result = await executeRewind(checkpoint.id)
    setConfirmingId(null)
    if (result.ok && result.rewindContext) {
      // Focus the session terminal and inject context
      const session = sessions.get(checkpoint.sessionId)
      if (session) {
        useAppStore.getState().activateSession(session.id)
        // Write rewind context to the active tab's PTY
        const tabId = session.activeTabId
        if (tabId) {
          window.latch?.writePty?.({ sessionId: tabId, data: result.rewindContext + '\n' })
        }
      }
    }
  }

  if (rewindSelectedCheckpoint) {
    return (
      <CheckpointDetail
        checkpoint={rewindSelectedCheckpoint}
        diff={rewindDiff}
        confirmingId={confirmingId}
        onBack={() => selectCheckpoint(null)}
        onRewind={() => setConfirmingId(rewindSelectedCheckpoint.id)}
        onConfirmRewind={() => handleRewind(rewindSelectedCheckpoint)}
        onCancelRewind={() => setConfirmingId(null)}
      />
    )
  }

  return (
    <div className="view-container">
      <div className="view-header">
        <h1 className="view-title">Rewind</h1>
      </div>

      {/* Session selector */}
      <div className="rewind-controls">
        <select
          className="modal-input"
          value={rewindSessionId ?? ''}
          onChange={(e) => setRewindSession(e.target.value || null)}
          style={{ maxWidth: 280 }}
        >
          <option value="">Select session...</option>
          {eligibleSessions.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        <div className="rewind-search">
          <MagnifyingGlass size={14} className="rewind-search-icon" />
          <input
            type="text"
            className="wizard-input"
            placeholder="Search checkpoints..."
            value={searchInput}
            onChange={(e) => handleSearch(e.target.value)}
            style={{ paddingLeft: 28 }}
          />
        </div>
      </div>

      {/* Checkpoint list */}
      {!rewindSessionId ? (
        <div className="an-empty">
          <ArrowCounterClockwise size={48} weight="light" className="an-empty-icon" />
          <span className="an-empty-text">Select a session</span>
          <span className="an-empty-hint">Choose a session to view its checkpoints.</span>
        </div>
      ) : rewindLoading ? (
        <div className="an-empty-text" style={{ padding: 32 }}>Loading checkpoints...</div>
      ) : rewindCheckpoints.length === 0 ? (
        <div className="an-empty">
          <ArrowCounterClockwise size={48} weight="light" className="an-empty-icon" />
          <span className="an-empty-text">{rewindSearchQuery ? 'No matches' : 'No checkpoints yet'}</span>
          <span className="an-empty-hint">
            {rewindSearchQuery
              ? 'Try a different search term.'
              : 'Checkpoints are created automatically when the agent writes files.'}
          </span>
        </div>
      ) : (
        <div className="rewind-timeline">
          {rewindCheckpoints.map(cp => (
            <CheckpointCard
              key={cp.id}
              checkpoint={cp}
              onClick={() => selectCheckpoint(cp)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Checkpoint Card ─────────────────────────────────────────────────────────

function CheckpointCard({ checkpoint, onClick }: { checkpoint: Checkpoint; onClick: () => void }) {
  return (
    <div className="rewind-card" onClick={onClick}>
      <div className="rewind-card-header">
        <span className="rewind-card-number">#{checkpoint.number}</span>
        <span className="rewind-card-turns">Turns {checkpoint.turnStart}–{checkpoint.turnEnd}</span>
        <span className="rewind-card-time">{formatDate(checkpoint.timestamp)}</span>
      </div>
      <div className="rewind-card-summary">{checkpoint.summary}</div>
      <div className="rewind-card-meta">
        <span className="rewind-card-files">
          {checkpoint.filesChanged.length} file{checkpoint.filesChanged.length === 1 ? '' : 's'}
        </span>
        {checkpoint.costUsd > 0 && (
          <span className="rewind-card-cost">{formatCost(checkpoint.costUsd)}</span>
        )}
      </div>
    </div>
  )
}

// ── Checkpoint Detail ───────────────────────────────────────────────────────

function CheckpointDetail({
  checkpoint,
  diff,
  confirmingId,
  onBack,
  onRewind,
  onConfirmRewind,
  onCancelRewind,
}: {
  checkpoint: Checkpoint
  diff: string | null
  confirmingId: string | null
  onBack: () => void
  onRewind: () => void
  onConfirmRewind: () => void
  onCancelRewind: () => void
}) {
  const isConfirming = confirmingId === checkpoint.id

  return (
    <div className="view-container">
      <div className="view-header">
        <button className="an-back-btn" onClick={onBack}>
          <ArrowLeft size={16} weight="bold" />
          All Checkpoints
        </button>
        <h1 className="view-title">Checkpoint #{checkpoint.number}</h1>
      </div>

      <div className="rewind-detail-meta">
        <div className="rewind-detail-stat">
          <span className="rewind-detail-label">Turns</span>
          <span className="rewind-detail-value">{checkpoint.turnStart}–{checkpoint.turnEnd}</span>
        </div>
        <div className="rewind-detail-stat">
          <span className="rewind-detail-label">Cost</span>
          <span className="rewind-detail-value">{formatCost(checkpoint.costUsd)}</span>
        </div>
        <div className="rewind-detail-stat">
          <span className="rewind-detail-label">Commit</span>
          <span className="rewind-detail-value" style={{ fontFamily: 'var(--font-mono)' }}>
            {checkpoint.commitHash.slice(0, 7)}
          </span>
        </div>
        <div className="rewind-detail-stat">
          <span className="rewind-detail-label">Time</span>
          <span className="rewind-detail-value">{formatDate(checkpoint.timestamp)}</span>
        </div>
      </div>

      <div className="rewind-detail-summary">{checkpoint.summary}</div>

      <div className="rewind-detail-files">
        <div className="rewind-detail-files-label">Files changed</div>
        {checkpoint.filesChanged.map(f => (
          <div key={f} className="rewind-detail-file">{f}</div>
        ))}
      </div>

      {/* Rewind action */}
      <div className="rewind-action-bar">
        {isConfirming ? (
          <div className="rewind-confirm">
            <span className="rewind-confirm-text">
              This will revert all file changes after checkpoint #{checkpoint.number}. Continue?
            </span>
            <div className="rewind-confirm-actions">
              <button className="budget-alert-btn is-danger" onClick={onConfirmRewind}>
                Yes, rewind
              </button>
              <button className="budget-alert-btn is-extend" onClick={onCancelRewind}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button className="rewind-btn" onClick={onRewind}>
            <ArrowCounterClockwise size={16} weight="bold" />
            Rewind to this checkpoint
          </button>
        )}
      </div>

      {/* Diff viewer */}
      {diff !== null && (
        <div className="rewind-diff">
          <div className="rewind-diff-label">Changes since this checkpoint</div>
          <pre className="rewind-diff-content">{diff || 'No changes since this checkpoint.'}</pre>
        </div>
      )}
    </div>
  )
}
```

**Step 2: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/renderer/components/RewindView.tsx
git commit -m "feat: add RewindView with checkpoint timeline, search, diff viewer, and rewind flow"
```

---

### Task 8: Add Rewind to Sidebar, App Router, and CSS

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`

**Step 1: Add Rewind to Sidebar**

Import `ArrowCounterClockwise` from `@phosphor-icons/react` alongside the existing icons.

Add a button after the Radar button (inside the Observe section):

```tsx
<button
  className={`sidebar-nav-item${activeView === 'rewind' ? ' is-active' : ''}`}
  onClick={() => setActiveView('rewind')}
>
  <ArrowCounterClockwise className="sidebar-nav-icon" weight="light" />
  Rewind
</button>
```

**Step 2: Add RewindView route to App.tsx**

Import:

```typescript
import RewindView from './components/RewindView'
```

In the `if/else` chain for `activeView`, add after the `live` case:

```tsx
} else if (activeView === 'rewind') {
  mainContent = <RewindView />
```

**Step 3: Add CSS**

Append to `src/renderer/styles.css`:

```css
/* ── Rewind View ──────────────────────────────────────────────────────────── */

.rewind-controls {
  display: flex;
  gap: 12px;
  padding: 0 24px;
  margin-bottom: 16px;
  align-items: center;
}

.rewind-search {
  position: relative;
  flex: 1;
  max-width: 320px;
}

.rewind-search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-tertiary);
  pointer-events: none;
}

.rewind-timeline {
  padding: 0 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rewind-card {
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 14px 16px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.rewind-card:hover {
  border-color: var(--accent-border);
  background: var(--bg-hover);
}

.rewind-card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.rewind-card-number {
  font-weight: 600;
  font-size: 13px;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.rewind-card-turns {
  font-size: 12px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.rewind-card-time {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-left: auto;
}

.rewind-card-summary {
  font-size: 13px;
  color: var(--text-primary);
  line-height: 1.4;
  margin-bottom: 8px;
}

.rewind-card-meta {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: var(--text-tertiary);
}

.rewind-card-cost {
  font-variant-numeric: tabular-nums;
}

/* ── Checkpoint Detail ─────────────────────────────────────────────────── */

.rewind-detail-meta {
  display: flex;
  gap: 24px;
  padding: 0 24px;
  margin-bottom: 16px;
}

.rewind-detail-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rewind-detail-label {
  font-size: 11px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.rewind-detail-value {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.rewind-detail-summary {
  padding: 0 24px;
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-bottom: 16px;
}

.rewind-detail-files {
  padding: 0 24px;
  margin-bottom: 16px;
}

.rewind-detail-files-label {
  font-size: 11px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.rewind-detail-file {
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  padding: 2px 0;
}

.rewind-action-bar {
  padding: 0 24px;
  margin-bottom: 16px;
}

.rewind-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  background: var(--accent-muted);
  color: var(--accent);
  border: 1px solid var(--accent-border);
  transition: background 0.15s;
}

.rewind-btn:hover {
  background: var(--accent);
  color: var(--bg-app);
}

.rewind-confirm {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 16px;
}

.rewind-confirm-text {
  display: block;
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.rewind-confirm-actions {
  display: flex;
  gap: 8px;
}

.rewind-diff {
  padding: 0 24px;
  margin-bottom: 24px;
}

.rewind-diff-label {
  font-size: 11px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}

.rewind-diff-content {
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 12px 14px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  overflow-x: auto;
  max-height: 400px;
  overflow-y: auto;
  white-space: pre;
  line-height: 1.5;
  margin: 0;
}

/* ── Checkpoint anomaly in Live View ────────────────────────────────────── */

.live-event-anomaly.is-checkpoint {
  background: rgb(96 165 250 / 0.12);
  border-left: 3px solid rgb(96 165 250);
}
```

**Step 4: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/components/Sidebar.tsx src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat: add Rewind to sidebar, App router, and styles"
```

---

### Task 9: Add Checkpoint Anomaly to LiveView

**Files:**
- Modify: `src/renderer/components/LiveView.tsx`

**Step 1: Add checkpoint anomaly type**

In the `EventRow` component, update the anomaly rendering to add checkpoint detection:

```tsx
const isCheckpoint = event.anomalyKind === 'checkpoint'
```

Add to the className:

```tsx
${isCheckpoint ? ' is-checkpoint' : ''}
```

Add to the icon:

```tsx
{isLeak ? '🔑' : isBudget ? '💰' : isCheckpoint ? '📌' : '⚠'}
```

**Step 2: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/renderer/components/LiveView.tsx
git commit -m "feat: add checkpoint anomaly rendering in Live view"
```

---

### Task 10: Final Typecheck and Verification

**Step 1: Run full typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS — no errors

**Step 2: Verify all new files exist**

```bash
ls -la src/main/stores/checkpoint-store.ts src/main/services/checkpoint-engine.ts src/renderer/components/RewindView.tsx
```

**Step 3: Run dev build**

Run: `cd /Users/cbryant/code/latch-core && npm run dev`
Verify: App launches, Rewind appears in sidebar, Settings + Budgets still work, no console errors.

**Step 4: Final commit if any fixups needed**

```bash
git add -A
git commit -m "chore: final fixups for agent rewind feature"
```
