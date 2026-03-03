# Session Replay — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a step-through replay player for agent sessions — watch turns unfold chronologically with thinking, tool calls, and file diffs, with play/pause/scrub/speed controls.

**Architecture:** A new ReplayView component loads timeline data via the existing `latch:timeline-load` IPC and plays it back turn-by-turn. Checkpoint markers from `latch:checkpoint-list` overlay on the scrub bar. Playback timing is duration-proportional with gap compression. All state managed in Zustand. No new IPC handlers needed.

**Tech Stack:** TypeScript, React, Zustand, existing timeline-parser + checkpoint-list IPC, Phosphor icons.

---

### Task 1: Add Types and AppView

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Add PlaybackSpeed type**

Add after the `Checkpoint` interface block (around line 620):

```typescript
// ── Session Replay ────────────────────────────────────────────────────────

export type PlaybackSpeed = 0.5 | 1 | 2 | 4
```

**Step 2: Add 'replay' to AppView**

Find the `AppView` type and add `'replay'` after `'rewind'`:

```typescript
export type AppView = '...' | 'rewind' | 'replay';
```

**Step 3: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add PlaybackSpeed type and replay AppView"
```

---

### Task 2: Add Replay State to Zustand Store

**Files:**
- Modify: `src/renderer/store/useAppStore.ts`

**Step 1: Import PlaybackSpeed and TimelineData**

Add `PlaybackSpeed` to the imports from `../../types`. `TimelineData`, `TimelineTurn`, and `TimelineConversation` should already be imported.

**Step 2: Add state fields**

Add after the rewind state block:

```typescript
// ── Replay ──────────────────────────────────────────────────────────────────
replayConversationId: string | null;
replayTurns: TimelineTurn[];
replayCurrentIndex: number;
replayIsPlaying: boolean;
replaySpeed: PlaybackSpeed;
replayCheckpointIndices: number[];
```

**Step 3: Add actions to interface**

Add after the rewind actions:

```typescript
// Replay
setReplayConversation: (id: string | null) => void;
loadReplay: (filePath: string, sessionId?: string) => Promise<void>;
replayPlay: () => void;
replayPause: () => void;
replayStep: (direction: 1 | -1) => void;
replaySeek: (turnIndex: number) => void;
setReplaySpeed: (speed: PlaybackSpeed) => void;
```

**Step 4: Add initial state values**

```typescript
replayConversationId: null,
replayTurns: [],
replayCurrentIndex: 0,
replayIsPlaying: false,
replaySpeed: 1,
replayCheckpointIndices: [],
```

**Step 5: Add action implementations**

```typescript
// ── Replay ─────────────────────────────────────────────────────────────────

setReplayConversation: (id) => {
  get().replayPause()
  set({
    replayConversationId: id,
    replayTurns: [],
    replayCurrentIndex: 0,
    replayIsPlaying: false,
    replayCheckpointIndices: [],
  })
},

loadReplay: async (filePath, sessionId?) => {
  get().replayPause()
  const result = await window.latch?.loadTimeline?.({ filePath })
  const data = result?.data ?? null
  if (!data) return

  // Load checkpoint indices if we have a session
  let checkpointIndices: number[] = []
  if (sessionId) {
    const cpResult = await window.latch?.listCheckpoints?.({ sessionId })
    if (cpResult?.ok && cpResult.checkpoints.length > 0) {
      // Map checkpoint turnEnd to turn array indices
      checkpointIndices = cpResult.checkpoints
        .map(cp => data.turns.findIndex(t => t.index === cp.turnEnd))
        .filter(i => i >= 0)
        .sort((a, b) => a - b)
    }
  }

  set({
    replayConversationId: data.conversation.id,
    replayTurns: data.turns,
    replayCurrentIndex: 0,
    replayIsPlaying: false,
    replayCheckpointIndices: checkpointIndices,
  })
},

replayPlay: () => {
  set({ replayIsPlaying: true })
},

replayPause: () => {
  set({ replayIsPlaying: false })
},

replayStep: (direction) => {
  const { replayCurrentIndex, replayTurns } = get()
  const next = replayCurrentIndex + direction
  if (next >= 0 && next < replayTurns.length) {
    set({ replayCurrentIndex: next })
  }
  if (next >= replayTurns.length) {
    set({ replayIsPlaying: false })
  }
},

replaySeek: (turnIndex) => {
  const { replayTurns } = get()
  if (turnIndex >= 0 && turnIndex < replayTurns.length) {
    set({ replayCurrentIndex: turnIndex })
  }
},

setReplaySpeed: (speed) => {
  set({ replaySpeed: speed })
},
```

**Step 6: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 7: Commit**

```bash
git add src/renderer/store/useAppStore.ts
git commit -m "feat: add replay state and actions to Zustand store"
```

---

### Task 3: Create ReplayView Component

**Files:**
- Create: `src/renderer/components/ReplayView.tsx`

**Step 1: Write the component**

```tsx
// src/renderer/components/ReplayView.tsx

import React, { useEffect, useRef, useCallback } from 'react'
import {
  PlayCircle, PauseCircle, SkipBack, SkipForward,
  ArrowLeft, MagnifyingGlass,
} from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'
import type { TimelineTurn, TimelineActionType, PlaybackSpeed } from '../../types'

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  if (usd >= 0.01) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(3)}`
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${ms}ms`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

const ACTION_COLORS: Record<TimelineActionType, string> = {
  read:    'rgb(var(--d-blue))',
  write:   'rgb(var(--d-green))',
  bash:    'rgb(var(--d-yellow))',
  search:  'rgb(var(--d-blue))',
  agent:   'rgb(168, 85, 247)',
  error:   'var(--error)',
  respond: 'var(--text-tertiary)',
}

const ACTION_LABELS: Record<TimelineActionType, string> = {
  read:    'Read',
  write:   'Write',
  bash:    'Bash',
  search:  'Search',
  agent:   'Agent',
  error:   'Error',
  respond: 'Response',
}

const SPEED_OPTIONS: PlaybackSpeed[] = [0.5, 1, 2, 4]

/** Duration (ms) to display a turn during auto-play. Compress gaps > 10s. */
function turnDisplayMs(turn: TimelineTurn, speed: PlaybackSpeed): number {
  const raw = turn.durationMs ?? 2_000
  const capped = raw > 10_000 ? 2_000 : raw  // compress rate-limit gaps
  return Math.max(capped / speed, 200)        // minimum 200ms visibility
}

// ── Root ────────────────────────────────────────────────────────────────────

export default function ReplayView() {
  const {
    timelineConversations,
    replayConversationId,
    replayTurns,
    replayCurrentIndex,
    replayIsPlaying,
    replaySpeed,
    replayCheckpointIndices,
    loadTimelineConversations,
    loadReplay,
    replayPlay,
    replayPause,
    replayStep,
    replaySeek,
    setReplaySpeed,
    sessions,
  } = useAppStore()

  const streamRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load conversations on mount
  useEffect(() => {
    loadTimelineConversations()
  }, [])

  // Auto-play timer
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)

    if (!replayIsPlaying || replayTurns.length === 0) return

    if (replayCurrentIndex >= replayTurns.length - 1) {
      replayPause()
      return
    }

    const currentTurn = replayTurns[replayCurrentIndex]
    const delay = turnDisplayMs(currentTurn, replaySpeed)

    timerRef.current = setTimeout(() => {
      replayStep(1)
    }, delay)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [replayIsPlaying, replayCurrentIndex, replaySpeed, replayTurns.length])

  // Auto-scroll stream to latest turn
  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight
    }
  }, [replayCurrentIndex])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (replayTurns.length === 0) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return

      if (e.code === 'Space') {
        e.preventDefault()
        replayIsPlaying ? replayPause() : replayPlay()
      } else if (e.code === 'ArrowRight') {
        e.preventDefault()
        replayStep(1)
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault()
        replayStep(-1)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [replayTurns.length, replayIsPlaying])

  // Handle conversation selection
  const handleConversationSelect = useCallback((filePath: string) => {
    // Try to find matching session for checkpoint data
    const conv = timelineConversations.find(c => c.filePath === filePath)
    const sessionId = conv ? findSessionForProject(conv.projectSlug, sessions) : undefined
    loadReplay(filePath, sessionId)
  }, [timelineConversations, sessions])

  // Running stats
  const playedTurns = replayTurns.slice(0, replayCurrentIndex + 1)
  const runningCost = playedTurns.reduce((sum, t) => sum + t.costUsd, 0)
  const runningTokens = playedTurns.reduce((sum, t) => sum + t.inputTokens + t.outputTokens, 0)
  const currentTurn = replayTurns[replayCurrentIndex] ?? null

  if (replayTurns.length > 0) {
    return (
      <div className="view-container replay-view">
        <div className="view-header">
          <button className="an-back-btn" onClick={() => loadReplay('', undefined).catch(() => useAppStore.getState().setReplayConversation(null))}>
            <ArrowLeft size={16} weight="bold" />
            Conversations
          </button>
          <h1 className="view-title">Replay</h1>
        </div>

        {/* Stats bar */}
        <div className="replay-stats-bar">
          <span className="replay-stat">Turn {replayCurrentIndex + 1} / {replayTurns.length}</span>
          <span className="replay-stat">{formatCost(runningCost)}</span>
          <span className="replay-stat">{formatTokens(runningTokens)} tokens</span>
          {currentTurn && (
            <span className="replay-stat replay-stat-phase" style={{ color: ACTION_COLORS[currentTurn.actionType] }}>
              {ACTION_LABELS[currentTurn.actionType]}
            </span>
          )}
        </div>

        {/* Main content: two panels */}
        <div className="replay-panels">
          {/* Left: Activity stream */}
          <div className="replay-stream" ref={streamRef}>
            {playedTurns.map((turn, i) => (
              <TurnCard
                key={turn.index}
                turn={turn}
                isActive={i === replayCurrentIndex}
                isCheckpoint={replayCheckpointIndices.includes(i)}
                onClick={() => replaySeek(i)}
              />
            ))}
          </div>

          {/* Right: Turn detail */}
          <div className="replay-detail">
            {currentTurn ? (
              <TurnDetail turn={currentTurn} />
            ) : (
              <div className="an-empty-text" style={{ padding: 32 }}>Select a turn to view details</div>
            )}
          </div>
        </div>

        {/* Scrub bar */}
        <ScrubBar
          turns={replayTurns}
          currentIndex={replayCurrentIndex}
          checkpointIndices={replayCheckpointIndices}
          onSeek={replaySeek}
        />

        {/* Playback controls */}
        <div className="replay-controls">
          <button className="replay-ctrl-btn" onClick={() => replayStep(-1)} title="Step back">
            <SkipBack size={20} weight="fill" />
          </button>
          <button className="replay-ctrl-btn replay-ctrl-play" onClick={() => replayIsPlaying ? replayPause() : replayPlay()} title={replayIsPlaying ? 'Pause' : 'Play'}>
            {replayIsPlaying ? <PauseCircle size={32} weight="fill" /> : <PlayCircle size={32} weight="fill" />}
          </button>
          <button className="replay-ctrl-btn" onClick={() => replayStep(1)} title="Step forward">
            <SkipForward size={20} weight="fill" />
          </button>

          <div className="replay-speed-group">
            {SPEED_OPTIONS.map(s => (
              <button
                key={s}
                className={`replay-speed-btn${replaySpeed === s ? ' is-active' : ''}`}
                onClick={() => setReplaySpeed(s)}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // Conversation selector
  return (
    <div className="view-container">
      <div className="view-header">
        <h1 className="view-title">Replay</h1>
      </div>

      {timelineConversations.length === 0 ? (
        <div className="an-empty">
          <PlayCircle size={48} weight="light" className="an-empty-icon" />
          <span className="an-empty-text">No conversations found</span>
          <span className="an-empty-hint">Run an agent session first. Conversations are loaded from Claude Code project logs.</span>
        </div>
      ) : (
        <div className="replay-conversation-list">
          {timelineConversations.map(conv => (
            <div
              key={conv.id}
              className="replay-conversation-card"
              onClick={() => handleConversationSelect(conv.filePath)}
            >
              <div className="replay-conv-header">
                <span className="replay-conv-project">{conv.projectName}</span>
                <span className="replay-conv-date">
                  {new Date(conv.lastModified).toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </span>
              </div>
              {conv.promptPreview && (
                <div className="replay-conv-preview">{conv.promptPreview}</div>
              )}
              <div className="replay-conv-meta">
                <span>{conv.turnCount} turns</span>
                <span>{formatCost(conv.totalCostUsd)}</span>
                <span>{formatTokens(conv.totalTokens)} tokens</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findSessionForProject(projectSlug: string, sessions: Map<string, any>): string | undefined {
  for (const [id, s] of sessions) {
    if (s.repoRoot && s.repoRoot.replace(/\//g, '-') === projectSlug) return id
  }
  return undefined
}

// ── Turn Card (Activity Stream) ─────────────────────────────────────────────

function TurnCard({
  turn, isActive, isCheckpoint, onClick,
}: {
  turn: TimelineTurn; isActive: boolean; isCheckpoint: boolean; onClick: () => void
}) {
  const toolCall = turn.toolCalls[0]

  return (
    <div
      className={`replay-turn-card${isActive ? ' is-active' : ''}${isCheckpoint ? ' is-checkpoint' : ''}`}
      onClick={onClick}
    >
      <div className="replay-turn-header">
        <span className="replay-turn-badge" style={{ background: ACTION_COLORS[turn.actionType] }}>
          {ACTION_LABELS[turn.actionType]}
        </span>
        <span className="replay-turn-num">#{turn.index + 1}</span>
        <span className="replay-turn-time">{formatTime(turn.timestamp)}</span>
        {turn.costUsd > 0 && <span className="replay-turn-cost">{formatCost(turn.costUsd)}</span>}
        {isCheckpoint && <span className="replay-turn-checkpoint" title="Checkpoint">📌</span>}
      </div>
      {toolCall && (
        <div className="replay-turn-tool">
          {toolCall.name}{toolCall.inputSummary ? ` — ${toolCall.inputSummary}` : ''}
        </div>
      )}
      {!toolCall && turn.thinkingSummary && (
        <div className="replay-turn-thinking">{turn.thinkingSummary}</div>
      )}
      {!toolCall && !turn.thinkingSummary && turn.textSummary && (
        <div className="replay-turn-text">{turn.textSummary}</div>
      )}
    </div>
  )
}

// ── Turn Detail (Right Panel) ───────────────────────────────────────────────

function TurnDetail({ turn }: { turn: TimelineTurn }) {
  return (
    <div className="replay-turn-detail">
      <div className="replay-detail-header">
        <span className="replay-detail-badge" style={{ background: ACTION_COLORS[turn.actionType] }}>
          {ACTION_LABELS[turn.actionType]}
        </span>
        <span className="replay-detail-turn">Turn #{turn.index + 1}</span>
        <span className="replay-detail-time">{formatTime(turn.timestamp)}</span>
        {turn.durationMs != null && (
          <span className="replay-detail-duration">{formatDuration(turn.durationMs)}</span>
        )}
      </div>

      {/* Thinking */}
      {turn.thinkingSummary && (
        <div className="replay-detail-section">
          <div className="replay-detail-section-label">Thinking</div>
          <div className="replay-detail-thinking">{turn.thinkingSummary}</div>
        </div>
      )}

      {/* Tool calls */}
      {turn.toolCalls.length > 0 && (
        <div className="replay-detail-section">
          <div className="replay-detail-section-label">Tool Calls</div>
          {turn.toolCalls.map((tc, i) => (
            <div key={i} className={`replay-detail-tool${tc.isError ? ' is-error' : ''}`}>
              <div className="replay-detail-tool-name">
                {tc.isError ? '✗ ' : '✓ '}{tc.name}
              </div>
              {tc.inputSummary && (
                <pre className="replay-detail-tool-input">{tc.inputSummary}</pre>
              )}
              {tc.resultSummary && (
                <pre className="replay-detail-tool-result">{tc.resultSummary}</pre>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Response */}
      {turn.textSummary && (
        <div className="replay-detail-section">
          <div className="replay-detail-section-label">Response</div>
          <div className="replay-detail-response">{turn.textSummary}</div>
        </div>
      )}

      {/* Metadata */}
      <div className="replay-detail-section">
        <div className="replay-detail-section-label">Metadata</div>
        <div className="replay-detail-meta-grid">
          <div className="replay-detail-meta-item">
            <span className="replay-detail-meta-label">Model</span>
            <span className="replay-detail-meta-value">{turn.model}</span>
          </div>
          <div className="replay-detail-meta-item">
            <span className="replay-detail-meta-label">Cost</span>
            <span className="replay-detail-meta-value">{formatCost(turn.costUsd)}</span>
          </div>
          <div className="replay-detail-meta-item">
            <span className="replay-detail-meta-label">Input</span>
            <span className="replay-detail-meta-value">{formatTokens(turn.inputTokens)}</span>
          </div>
          <div className="replay-detail-meta-item">
            <span className="replay-detail-meta-label">Output</span>
            <span className="replay-detail-meta-value">{formatTokens(turn.outputTokens)}</span>
          </div>
          {turn.cacheReadTokens > 0 && (
            <div className="replay-detail-meta-item">
              <span className="replay-detail-meta-label">Cache Read</span>
              <span className="replay-detail-meta-value">{formatTokens(turn.cacheReadTokens)}</span>
            </div>
          )}
          {turn.stopReason && (
            <div className="replay-detail-meta-item">
              <span className="replay-detail-meta-label">Stop</span>
              <span className="replay-detail-meta-value">{turn.stopReason}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Scrub Bar ───────────────────────────────────────────────────────────────

function ScrubBar({
  turns, currentIndex, checkpointIndices, onSeek,
}: {
  turns: TimelineTurn[]
  currentIndex: number
  checkpointIndices: number[]
  onSeek: (index: number) => void
}) {
  if (turns.length === 0) return null

  // Total duration for proportional widths
  const totalDuration = turns.reduce((sum, t) => sum + (t.durationMs ?? 2_000), 0) || 1

  return (
    <div className="replay-scrub">
      <div className="replay-scrub-bar">
        {turns.map((turn, i) => {
          const width = ((turn.durationMs ?? 2_000) / totalDuration) * 100
          const isPlayed = i <= currentIndex
          const isCurrent = i === currentIndex
          const isCheckpoint = checkpointIndices.includes(i)
          const isGap = (turn.durationMs ?? 0) > 10_000

          return (
            <div
              key={i}
              className={`replay-scrub-seg${isPlayed ? ' is-played' : ''}${isCurrent ? ' is-current' : ''}${isGap ? ' is-gap' : ''}`}
              style={{
                width: `${Math.max(width, 0.3)}%`,
                background: isPlayed ? ACTION_COLORS[turn.actionType] : undefined,
              }}
              onClick={() => onSeek(i)}
              title={`Turn #${turn.index + 1} — ${ACTION_LABELS[turn.actionType]}`}
            >
              {isCheckpoint && <span className="replay-scrub-checkpoint" />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

**Step 2: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/renderer/components/ReplayView.tsx
git commit -m "feat: add ReplayView with step-through player, scrub bar, and turn detail"
```

---

### Task 4: Add Replay to Sidebar, App Router, and CSS

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`

**Step 1: Add Replay to Sidebar**

Import `PlayCircle` from `@phosphor-icons/react`.

Add a button after Live and before Rewind in the Observe section:

```tsx
<button
  className={`sidebar-nav-item${activeView === 'replay' ? ' is-active' : ''}`}
  onClick={() => setActiveView('replay')}
>
  <PlayCircle className="sidebar-nav-icon" weight="light" />
  Replay
</button>
```

**Step 2: Add ReplayView route to App.tsx**

Import:

```typescript
import ReplayView from './components/ReplayView'
```

Add after the `live` case in the `if/else` chain:

```tsx
} else if (activeView === 'replay') {
  mainContent = <ReplayView />
```

**Step 3: Add CSS**

Append to `src/renderer/styles.css`:

```css
/* ── Replay View ─────────────────────────────────────────────────────────── */

.replay-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.replay-stats-bar {
  display: flex;
  gap: 16px;
  padding: 0 24px;
  margin-bottom: 12px;
  align-items: center;
}

.replay-stat {
  font-size: 12px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.replay-stat-phase {
  font-weight: 600;
}

/* ── Panels ──────────────────────────────────────────────────────────── */

.replay-panels {
  flex: 1;
  display: flex;
  gap: 1px;
  background: var(--border-subtle);
  min-height: 0;
  margin: 0 24px;
  border-radius: 8px;
  overflow: hidden;
}

.replay-stream {
  flex: 1;
  overflow-y: auto;
  background: var(--bg-app);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.replay-detail {
  flex: 1;
  overflow-y: auto;
  background: var(--bg-app);
  padding: 12px;
}

/* ── Turn Card (stream) ──────────────────────────────────────────────── */

.replay-turn-card {
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.replay-turn-card:hover {
  background: var(--bg-hover);
}

.replay-turn-card.is-active {
  background: var(--bg-card);
  border-color: var(--accent-border);
}

.replay-turn-card.is-checkpoint {
  border-left: 3px solid rgb(96 165 250);
}

.replay-turn-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.replay-turn-badge {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  color: white;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.replay-turn-num {
  font-size: 11px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.replay-turn-time {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-left: auto;
}

.replay-turn-cost {
  font-size: 11px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.replay-turn-checkpoint {
  font-size: 12px;
}

.replay-turn-tool,
.replay-turn-thinking,
.replay-turn-text {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.replay-turn-thinking {
  font-style: italic;
  color: var(--text-tertiary);
}

/* ── Turn Detail ─────────────────────────────────────────────────────── */

.replay-turn-detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.replay-detail-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.replay-detail-badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  color: white;
  text-transform: uppercase;
}

.replay-detail-turn {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.replay-detail-time {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-left: auto;
}

.replay-detail-duration {
  font-size: 12px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.replay-detail-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.replay-detail-section-label {
  font-size: 11px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.replay-detail-thinking {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
  font-style: italic;
}

.replay-detail-tool {
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 10px 12px;
}

.replay-detail-tool.is-error {
  border-color: var(--error);
}

.replay-detail-tool-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
}

.replay-detail-tool-input,
.replay-detail-tool-result {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  background: var(--bg-elevated);
  border-radius: 4px;
  padding: 8px;
  margin: 4px 0;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
}

.replay-detail-response {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
  white-space: pre-wrap;
}

.replay-detail-meta-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.replay-detail-meta-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.replay-detail-meta-label {
  font-size: 10px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.replay-detail-meta-value {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  font-family: var(--font-mono);
}

/* ── Scrub Bar ───────────────────────────────────────────────────────── */

.replay-scrub {
  padding: 8px 24px;
}

.replay-scrub-bar {
  display: flex;
  height: 16px;
  border-radius: 4px;
  overflow: hidden;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
}

.replay-scrub-seg {
  position: relative;
  height: 100%;
  background: var(--bg-elevated);
  transition: opacity 0.15s;
  min-width: 1px;
  border-right: 1px solid var(--bg-app);
}

.replay-scrub-seg.is-played {
  opacity: 1;
}

.replay-scrub-seg:not(.is-played) {
  opacity: 0.2;
}

.replay-scrub-seg.is-current {
  opacity: 1;
  box-shadow: inset 0 0 0 1px white;
}

.replay-scrub-seg.is-gap {
  background: repeating-linear-gradient(
    45deg,
    transparent,
    transparent 2px,
    var(--text-tertiary) 2px,
    var(--text-tertiary) 4px
  ) !important;
  opacity: 0.3;
}

.replay-scrub-checkpoint {
  position: absolute;
  top: -2px;
  left: 50%;
  transform: translateX(-50%);
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgb(96 165 250);
  border: 1px solid var(--bg-app);
}

/* ── Playback Controls ───────────────────────────────────────────────── */

.replay-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 24px 16px;
}

.replay-ctrl-btn {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: color 0.15s;
  display: flex;
  align-items: center;
}

.replay-ctrl-btn:hover {
  color: var(--text-primary);
}

.replay-ctrl-play {
  color: var(--accent);
}

.replay-ctrl-play:hover {
  color: var(--accent);
  opacity: 0.8;
}

.replay-speed-group {
  display: flex;
  gap: 2px;
  margin-left: 16px;
  background: var(--bg-card);
  border-radius: 6px;
  padding: 2px;
  border: 1px solid var(--border-subtle);
}

.replay-speed-btn {
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  background: transparent;
  color: var(--text-tertiary);
  transition: all 0.15s;
}

.replay-speed-btn.is-active {
  background: var(--accent);
  color: var(--bg-app);
}

.replay-speed-btn:hover:not(.is-active) {
  color: var(--text-primary);
}

/* ── Conversation List ───────────────────────────────────────────────── */

.replay-conversation-list {
  padding: 0 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.replay-conversation-card {
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 14px 16px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.replay-conversation-card:hover {
  border-color: var(--accent-border);
  background: var(--bg-hover);
}

.replay-conv-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
}

.replay-conv-project {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.replay-conv-date {
  font-size: 11px;
  color: var(--text-tertiary);
}

.replay-conv-preview {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.4;
  margin-bottom: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.replay-conv-meta {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
```

**Step 4: Run typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/components/Sidebar.tsx src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat: add Replay to sidebar, App router, and styles"
```

---

### Task 5: Final Typecheck and Verification

**Step 1: Run full typecheck**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit`
Expected: PASS — no errors

**Step 2: Verify all new files exist**

```bash
ls -la src/renderer/components/ReplayView.tsx
```

**Step 3: Verify sidebar order**

Read `src/renderer/components/Sidebar.tsx` and confirm the Observe section has: Live, Replay, Rewind, Timeline, Usage, Analytics, Radar — in that order.
