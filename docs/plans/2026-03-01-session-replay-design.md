# Session Replay — Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:writing-plans to create the implementation plan from this design.

**Goal:** Let users replay agent sessions as a step-through player — watching turns unfold chronologically with thinking, tool calls, and file diffs, like a structured screen recording of the agent's work.

**Architecture:** A new ReplayView component loads timeline data (already parsed from JSONL by timeline-parser.ts) and plays it back turn-by-turn with duration-proportional timing. Playback controls (play/pause/step/scrub/speed) are purely renderer-side. Checkpoint markers from the checkpoint store overlay on the scrub bar for quick navigation.

**Tech Stack:** TypeScript, React, Zustand, existing timeline-parser IPC, existing checkpoint-list IPC.

---

## Replay Player

### Layout

Two-panel design:

- **Left panel: Activity stream** — Turns appear chronologically as they "play." Each turn renders as a card showing its action type, summary, and timing. Unplayed turns are hidden. Played turns stay visible and scroll up.
- **Right panel: Turn detail** — Shows the currently selected turn's full content: thinking text, tool call input/output, file diffs for Write/Edit calls, cost and token breakdown.

### Header

- **Conversation selector**: Dropdown to pick a session, then a conversation (JSONL file) within it.
- **Playback stats bar**: Running accumulator — cost so far, tokens consumed, files touched, current work phase (planning/implementing/debugging), turn N of M.

### Scrub Bar

Horizontal bar at the bottom of the view:

- Segments represent turns, width proportional to turn duration
- Color-coded by work phase (same palette as AnalyticsView — planning blue, implementation green, debugging amber, coordination purple, responding gray)
- **Checkpoint markers**: Blue pin dots at checkpoint turn positions
- Click anywhere to jump to that turn
- Current position indicator (playhead)

---

## Playback Controls

### Buttons

- **Play/Pause** — Toggle auto-play
- **Step Back** — Go to previous turn
- **Step Forward** — Go to next turn
- **Speed selector** — 0.5x, 1x, 2x, 4x buttons

### Keyboard Shortcuts

- Space: Play/Pause
- Left arrow: Step back
- Right arrow: Step forward

### Auto-Play Timing

Duration-proportional: each turn displays for its real `durationMs` divided by the speed multiplier.

**Rate-limit gap compression**: Gaps > 10 seconds are compressed to 2 seconds with a visible "gap" indicator on the scrub bar. The analytics engine already detects gaps >= 30s; we extend this to identify all gaps > 10s for the replay.

---

## Turn Rendering

### Activity Stream (Left Panel)

Each turn renders as a card:

- **Header**: Turn number, timestamp, duration, action type badge (color-coded)
- **Body**: Depends on action type:
  - **Thinking**: Truncated thinking summary (expand on click)
  - **Tool call**: Tool name + target file/command, status icon (success/error)
  - **Response**: First ~100 chars of text response
- **Cost**: Micro cost badge if > $0

### Turn Detail (Right Panel)

Full content for the selected turn:

- **Thinking**: Full thinking text in a scrollable block
- **Tool calls**: Each call with full input and result
  - For Write/Edit: Show file diff inline (additions green, deletions red)
  - For Bash: Show command and output
  - For Read/Glob/Grep: Show target and result summary
- **Response**: Full agent response text
- **Metadata**: Model, tokens (input/output/cache), cost, stop reason

---

## Data Flow

1. User selects a conversation → `latch:timeline-load` returns `TimelineData` with all turns
2. If the session has checkpoints → `latch:checkpoint-list` returns checkpoint metadata
3. Turns are loaded into Zustand `replayTurns` state
4. Checkpoint turn indices are computed (map checkpoint.turnEnd to turn array indices)
5. Playback is controlled entirely in the renderer via `setInterval` + speed multiplier
6. No new IPC handlers needed — everything builds on existing infrastructure

---

## New Types

```typescript
export type PlaybackSpeed = 0.5 | 1 | 2 | 4
```

No other new types needed — ReplayView state lives entirely in Zustand.

---

## Zustand State

```typescript
// Replay state
replayConversationId: string | null
replayTurns: TimelineTurn[]
replayCurrentIndex: number
replayIsPlaying: boolean
replaySpeed: PlaybackSpeed
replayCheckpointIndices: number[]
```

## Zustand Actions

```typescript
setReplayConversation: (id: string | null) => void
loadReplay: (filePath: string, sessionId?: string) => Promise<void>
replayPlay: () => void
replayPause: () => void
replayStep: (direction: 1 | -1) => void
replaySeek: (turnIndex: number) => void
setReplaySpeed: (speed: PlaybackSpeed) => void
```

---

## Sidebar Placement

New entry **"Replay"** under Observe, between Live and Rewind. Uses `PlayCircle` icon from Phosphor.

---

## Constraints

- **Local only (v1)**: No export/sharing. Replay viewer only works inside Latch Desktop.
- **Claude Code only**: Timeline parser only handles Claude Code JSONL. Codex/OpenClaw sessions show as "replay not available."
- **Read-only**: Replay is observation only — no ability to interact or rewind from the replay view (that's what Rewind view is for).
- **No new IPC**: Entirely built on existing `timeline-load` and `checkpoint-list` handlers.
