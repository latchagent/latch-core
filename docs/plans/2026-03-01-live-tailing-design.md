# Live Session Tailing — Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:writing-plans to create the implementation plan from this design.

**Goal:** Real-time observability into active agent sessions — tool calls, thinking, cost, and anomalies streaming live. The "Datadog Live Tail" for AI coding agents.

**Architecture:** A dedicated "Live" view in the sidebar shows session cards for all active sessions. Clicking a card drills into a full trace view with tool calls, agent thinking summaries, file touch map, and running cost. Data flows from existing activity events and PTY output parsing, pushed to the renderer in real-time via IPC.

**Tech Stack:** React + Zustand, IPC push events, existing activity/usage infrastructure.

---

## Navigation Flow

```
Live View (all active sessions)
  └── Session Card (compact: name, status, cost, last action, turn count)
        └── Click → Session Detail (full trace)
              ├── Live tool call stream with thinking
              ├── Running cost ticker
              ├── Files touched map
              └── Anomaly/loop warnings (inline)
```

Back button at detail level returns to the card overview.

---

## Session Cards (Overview)

Each active session renders as a card showing:

| Field | Source | Notes |
|-------|--------|-------|
| Session name | session record | |
| Harness | session record | Icon + label (Claude/Codex/OpenClaw) |
| Status indicator | PTY activity | Pulsing dot when active, idle when waiting |
| Running cost | usage events | Ticking up in real-time |
| Turn count | activity events | How many turns so far |
| Last action | latest activity event | "Edit src/foo.ts" or "Bash: npm test" |
| Time elapsed | session start time | "4m 32s" running timer |

Cards are sorted by most recently active. Cards disappear when sessions end (or move to a "completed" section at the bottom).

### Status States
- **Active** (green pulse) — agent is producing output right now
- **Thinking** (amber pulse) — waiting for LLM response
- **Idle** (gray) — waiting for user input
- **Rate limited** (red) — gap detected, waiting

---

## Session Detail (Full Trace)

### Tool Call Stream

Each entry in the stream is a row:

```
┌──────────────────────────────────────────────────────────────┐
│ 14:23:05  Read  src/renderer/App.tsx            $0.02  0.3s │
│                                                              │
│ 💭 "I need to check how the router works before             │
│    adding the new view..."                                   │
│                                                              │
│ 14:23:08  Edit  src/renderer/App.tsx            $0.04  1.2s │
│                                                              │
│ 💭 "Adding the import and route for LiveView..."             │
│                                                              │
│ 14:23:12  Bash  npx tsc --noEmit          ✓     $0.01  3.4s │
│                                                              │
│ ⚠ Loop warning: Read "App.tsx" 3 times in last 8 turns      │
└──────────────────────────────────────────────────────────────┘
```

Each row shows:
- **Timestamp** — when the call started
- **Tool name** — Read, Edit, Write, Bash, Glob, Grep, etc.
- **Target** — file path, command, or search pattern
- **Cost** — cost of this specific call
- **Duration** — how long the call took
- **Status** — success (✓), error (✗), or in-progress (spinner)
- **Thinking summary** — collapsed by default, expandable. Shows the agent's reasoning between tool calls.

Rows stream in from the bottom (newest at bottom, auto-scroll). User can scroll up to pause auto-scroll, click "Jump to latest" to resume.

### Inline Anomaly Warnings

When loop detection or anomaly detection fires during the live stream, insert a warning banner inline:

- Loop detected (repeated read, write cycle, etc.)
- Cost spike (current window exceeding baseline)
- Rate limit gap (extended pause between turns)
- Policy violation (tool call denied or flagged)

These use the same detection logic from loop-detector.ts and radar.ts, but running on the live data as it arrives.

### Running Stats Bar (sticky header)

Sticky at top of detail view:
- **Total cost** — running total, ticking up
- **Turns** — count
- **Duration** — elapsed time
- **Cache hit ratio** — percentage
- **Files touched** — count (click to expand list)

### Files Touched Panel

Collapsible side panel or section showing every file the agent has interacted with:
- File path
- Operations performed (read/write/edit)
- Number of times touched
- Highlighted if touched 3+ times (potential loop)

---

## Data Pipeline

### Where the data comes from

We already have two data sources:

1. **Activity events** (`activity-store.ts` / `authz-server.ts`) — every tool call that goes through authorization. Has: tool name, action class, risk, decision, timestamp, session ID.

2. **Usage events** (`usage-store.ts`) — token/cost data per call. Has: model, input/output tokens, cache tokens, cost, timestamp.

What we're missing:
- **Thinking summaries** — we need to extract these from PTY output or JSONL in real-time
- **Tool call targets** — activity events have tool name but not always the target (file path, command)
- **Tool call duration** — not currently tracked
- **Tool call status** (success/error) — partially available via `isError` flag

### New: Live Event Stream

Create a unified `LiveEvent` type that merges activity + usage + enrichments:

```typescript
interface LiveEvent {
  id: string
  sessionId: string
  timestamp: string
  kind: 'tool-call' | 'thinking' | 'anomaly' | 'status-change'

  // tool-call fields
  toolName?: string
  target?: string        // file path, command, search pattern
  costUsd?: number
  durationMs?: number
  status?: 'running' | 'success' | 'error'
  inputTokens?: number
  outputTokens?: number

  // thinking fields
  thinkingSummary?: string

  // anomaly fields
  anomalyKind?: string   // 'loop', 'cost-spike', 'rate-limit', 'policy-violation'
  anomalyMessage?: string

  // status-change fields
  sessionStatus?: 'active' | 'thinking' | 'idle' | 'rate-limited'
}
```

### Push mechanism

Main process emits `latch:live-event` IPC push events to the renderer whenever:
- A tool call starts (status: running)
- A tool call completes (status: success/error, with cost + duration)
- Thinking summary is extracted
- Anomaly is detected
- Session status changes

Renderer stores these in a ring buffer (last 1000 events per session) in Zustand.

---

## Real-time Parsing

### Extracting thinking summaries

Two approaches:

**Option A: JSONL tail** — tail the active conversation's JSONL file and parse new entries as they're written. This gives us structured data including thinking blocks. More reliable but slight delay.

**Option B: PTY output parsing** — parse the terminal output stream for thinking indicators. Faster but fragile (depends on harness output format).

**Recommendation: Option A (JSONL tail).** We already have the JSONL parser from timeline-parser.ts. Create a file watcher that tails the active JSONL and emits LiveEvents as new entries appear.

### Extracting tool call targets

Enrich activity events with target information:
- Read/Edit/Write → file path from tool call input
- Bash → command string
- Glob → pattern
- Grep → search pattern + path

This enrichment happens in the authz-server when processing the tool call, before emitting the activity event.

---

## Intervention Controls

From the session detail view, the user can:

- **Kill session** — sends SIGTERM to the PTY process
- **Flag for review** — marks the session, creates a note (feeds into future Issues feature)

These are simple actions on existing infrastructure (pty-kill, session metadata).

---

## UI Components

### New Components
- `LiveView.tsx` — root view, manages active session list
- `LiveSessionCard.tsx` — compact card for overview
- `LiveSessionDetail.tsx` — full trace view with stream
- `LiveEventRow.tsx` — single event in the stream
- `LiveStatsBar.tsx` — sticky header with running stats
- `LiveFilesPanel.tsx` — files touched list

### Store additions (useAppStore.ts)
- `liveEvents: Map<string, LiveEvent[]>` — ring buffer per session
- `liveSessionStats: Map<string, LiveSessionStats>` — running aggregates
- `liveDetailSessionId: string | null` — which session is expanded

### New IPC
- `latch:live-event` — push event from main → renderer (no invoke needed)
- `latch:live-subscribe` — tell main to start streaming for a session
- `latch:live-unsubscribe` — stop streaming

### New AppView
- Add `'live'` to `AppView` type
- Add to Sidebar under OBSERVE section

---

## What this unlocks

With the live event pipeline in place:
- **Phase 6 (Budgets)** — budget enforcement is just a threshold check on the live cost stream
- **Phase 6 (Leak Detection)** — scan tool call targets and outputs in the live stream
- **Phase 7 (Issues)** — auto-create issues when anomalies accumulate past a threshold
- **Phase 8 (Rewind)** — checkpoint triggers based on live session milestones
