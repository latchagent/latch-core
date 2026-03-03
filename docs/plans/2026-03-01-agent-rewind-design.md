# Agent Rewind — Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:writing-plans to create the implementation plan from this design.

**Goal:** Let users rewind agent sessions to any checkpoint, revert file changes, and redirect the agent with new instructions — undo + redirect for AI coding agents.

**Architecture:** A new main-process service `checkpoint-engine.ts` auto-commits to git after agent writes (debounced 3s), storing checkpoint metadata in SQLite. A dedicated Rewind view shows a searchable timeline of checkpoints with diffs. Rewind executes `git reset --hard`, injects context into the terminal, and lets the user type new instructions.

**Tech Stack:** TypeScript, git CLI via child_process, SQLite checkpoints table, existing live-tailer Write/Edit detection, PTY write for context injection.

---

## Auto-Checkpoint Engine

### Trigger

The live-tailer already detects Write/Edit tool calls in the JSONL stream. A new `onFileWrite` callback (same pattern as `onLeakDetected`) signals the checkpoint engine when the agent writes a file.

### Debouncing

Writes within a 3-second window are batched into a single checkpoint. This prevents rapid-fire edits from creating dozens of commits.

### Checkpoint Creation

1. Receive "file was written" signal from live-tailer
2. Debounce (3s window)
3. Run `git add -A && git commit -m "latch:checkpoint #N — turn T [file1.ts, file2.ts]"` in the session's worktree
4. Store metadata in SQLite `checkpoints` table
5. Emit `LiveEvent` anomaly so checkpoint appears in Live view

### Commit Message Format

```
latch:checkpoint #3 — turn 12 [auth.ts, router.ts]
```

Parseable, greppable, human-readable. On session load, checkpoints can be reconstructed from `git log --grep="latch:checkpoint"`.

### Summary Generation

Each checkpoint captures a human-readable summary of what changed:
- **Primary source:** Agent's last thinking block before the write (extracted by live-tailer)
- **Fallback:** Generated from tool calls: "Modified auth.ts, middleware.ts (3 writes, 1 bash)"
- **Data captured:** Summary text, file paths with change counts, cost for the segment, turn range

---

## Rewind View

### Sidebar Placement

New entry **"Rewind"** under Observe in the sidebar (alongside Live, Usage, Timeline, Analytics, Radar). Uses a clock/rewind icon.

### Layout

- **Session selector** at top — dropdown of sessions that have checkpoints (only git-tracked sessions)
- **Search bar** — full-text search across checkpoint summaries and file paths (SQLite FTS)
- **Checkpoint timeline** — vertical list, newest at top

### Checkpoint Card

Each card shows:
- Checkpoint number + turn range (e.g., "Checkpoint #5 — turns 8-12")
- Summary text (thinking-derived description)
- Files changed with indicators
- Cost for that segment
- Timestamp
- **"Rewind here"** button

### Diff Panel

Click a checkpoint → right panel shows the git diff between that checkpoint and current HEAD. Color-coded additions/deletions per file, collapsible file sections.

### Search

Filters checkpoints by summary text, file paths, or turn numbers. Backed by SQLite full-text search on the `checkpoints` table.

---

## Rewind Execution

### Flow

1. User clicks "Rewind here" on checkpoint #5
2. **Confirmation dialog:** "This will revert all file changes after checkpoint #5 (turns 13-20). Continue?"
3. On confirm:
   - `git reset --hard <commitHash>` in the session's worktree
   - Invalidate all checkpoints after #5 (remove from SQLite + memory)
   - Checkpoint counter continues from #5 (next auto-checkpoint is #6)
4. Focus switches to the session terminal
5. Latch injects context message via PTY write
6. User types their new direction

### Context Injection

Latch writes a message into the terminal so the agent sees it as user input:

```
[LATCH REWIND] Codebase reverted to checkpoint #5 (after turn 12).

Turns 13-20 were abandoned. Files on disk match turn 12 state.

Changes that were reverted:
- auth.ts: Refactored to OAuth (reverted back to session-based)
- oauth-client.ts: New file (deleted)
- test/auth.test.ts: Updated for OAuth (reverted)

Your new direction:
```

The cursor is then ready for the user to type their corrected prompt. The agent sees this as a normal user message — no special harness integration needed. Works with Claude Code, Codex, and OpenClaw.

### Side Effects

- Feed item: "Session X rewound to checkpoint #5"
- LiveEvent anomaly surfaces in Live view stream
- Radar signal at 'medium' level

---

## New Types

```typescript
export interface Checkpoint {
  id: string
  sessionId: string
  number: number           // sequential per session
  commitHash: string
  turnStart: number        // first turn in this segment
  turnEnd: number          // last turn before checkpoint
  summary: string          // thinking-derived description
  filesChanged: string[]   // file paths
  costUsd: number          // cost for this segment
  timestamp: string
}
```

---

## New IPC Handlers

| Channel | Purpose |
|---------|---------|
| `latch:git-log` | Get commit history for a worktree |
| `latch:git-diff` | Diff between two commits (or commit vs HEAD) |
| `latch:git-reset` | Reset worktree to a specific commit |
| `latch:checkpoint-list` | List checkpoints for a session |
| `latch:checkpoint-search` | Full-text search across checkpoints |
| `latch:rewind` | Orchestrate full rewind (reset + invalidate + inject context) |

---

## Storage

### SQLite Table: `checkpoints`

```sql
CREATE TABLE IF NOT EXISTS checkpoints (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  number      INTEGER NOT NULL,
  commit_hash TEXT NOT NULL,
  turn_start  INTEGER NOT NULL,
  turn_end    INTEGER NOT NULL,
  summary     TEXT NOT NULL,
  files       TEXT NOT NULL,        -- JSON array of file paths
  cost_usd    REAL NOT NULL DEFAULT 0,
  timestamp   TEXT NOT NULL
)
```

### Reconstruction

If the checkpoints table is lost, checkpoints can be reconstructed from `git log --grep="latch:checkpoint"` in the session's worktree.

---

## Constraints

- **Git-only:** Rewind requires a git worktree. Non-git sessions get observation-only (can view timeline but not revert).
- **Destructive:** `git reset --hard` discards uncommitted changes. The confirmation dialog warns clearly.
- **No turn-level revert (v1):** Checkpoints happen after writes, not per-turn. Finer granularity can be added later.
- **Harness-agnostic:** Context injection is plain text via PTY — works with any harness without special integration.
