# Latch Observability — Design Document

**Date:** 2026-03-01
**Status:** Draft
**Author:** Claude (brainstorm session with CB)

---

## Vision

Latch becomes **"the observability and governance layer for your AI agents"**.

Today Latch governs what agents can do. With observability, Latch shows what
agents *did do* — how much they cost, how they spent their time, whether they
got stuck, and whether the work was effective. Think Datadog for AI coding
agents.

Latch is uniquely positioned because it:

1. **Wraps the PTY** — sees everything the agent does in the terminal
2. **Owns the authz layer** — already intercepts every tool call
3. **Reads the filesystem** — can watch and parse harness log files
4. **Is multi-harness** — unified view across Claude Code, Codex, OpenClaw
5. **Manages sessions** — has project/workflow context that raw log parsers lack

---

## Phased Roadmap

| Phase | Feature | Description |
|-------|---------|-------------|
| **1** | Cost & Token Dashboard | Real-time token/cost tracking from JSONL files |
| **2** | Session Timeline / Replay | Visual scrubbable timeline of every agent action |
| **3** | Stuck / Loop Detection | Real-time detection of unproductive agent behavior |
| **4** | Deep Analytics | Cost attribution, context pressure, effectiveness scoring |

---

## Sidebar Navigation Restructure

The sidebar gets grouped section headers to reinforce the "observe + govern"
positioning and give observability features a natural home.

```
── Home ──────────────────
  Home
  Feed

── OBSERVE ───────────────
  Usage         (ChartBar)      ← Phase 1
  Timeline      (Clock)         ← Phase 2
  Radar         (Target)        ← existing, relocated

── GOVERN ────────────────
  Policies      (Lock)
  Gateway       (ShieldCheck)
  Services      (Plugs)

── BUILD ─────────────────
  Agents        (Robot)
  MCP           (HardDrives)

── ───────────────────────
  Docs
  Settings
```

Section headers: 10px uppercase monospace, `var(--text-tertiary)`, subtle
top-border divider. Minimal vertical footprint.

---

## Phase 1: Cost & Token Dashboard

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  MAIN PROCESS                                                │
│                                                              │
│  ┌──────────────────┐   ┌──────────────┐   ┌────────────┐  │
│  │  Usage Watcher    │──▶│  Usage Store  │◀──│  Pricing   │  │
│  │  (Service)        │   │  (SQLite)     │   │  Engine    │  │
│  └────────┬─────────┘   └──────┬───────┘   └────────────┘  │
│           │                     │                            │
│    watches fs                  IPC push                      │
│    ~/.claude/projects/          │                            │
│    ~/.codex/sessions/           ▼                            │
│                       sendToRenderer()                       │
└──────────────────────────────────────────────────────────────┘
                                │
                       ┌────────▼────────┐
                       │   RENDERER      │
                       │                 │
                       │   UsageView     │
                       │  (sidebar view) │
                       └─────────────────┘
```

### Component 1: Usage Watcher (`src/main/services/usage-watcher.ts`)

A main-process service that watches harness log directories for new JSONL
lines and extracts usage data in real-time.

**Data sources:**

| Harness | Log location | Format |
|---------|-------------|--------|
| Claude Code | `~/.claude/projects/<slug>/<uuid>.jsonl` | JSONL, one message per line |
| Codex CLI | `~/.codex/sessions/<id>.jsonl` | JSONL, event_msg records |
| OpenClaw | TBD | TBD |

**How it works:**

1. Uses `fs.watch` on harness log directories
2. Tracks file byte offsets — only reads new bytes appended since last read
3. Filters for assistant messages (`type: "assistant"`) that contain `usage`
4. Deduplicates by `requestId` (streaming produces multiple lines; last wins)
5. Extracts: `model`, `usage.*` (all token buckets), tool calls from `content[]`, `timestamp`
6. Passes to Pricing Engine for cost calculation
7. Writes to Usage Store
8. Pushes `latch:usage-event` to renderer

**Session mapping:**

When a Latch session has `repo_root = /Users/foo/code/myproject`, the Claude
JSONL files live at `~/.claude/projects/-Users-foo-code-myproject/*.jsonl`.
The watcher maps this path back to the Latch session ID. Sessions without a
mapped Latch session are tagged as "untracked" but still ingested — this
makes Latch useful even when running Claude Code directly.

**Lifecycle:**

- Starts on `app.whenReady()` alongside other services
- On first launch, performs a one-time backfill of existing JSONL files
  (historical import) with a progress toast in the renderer
- Uses debounced file watching (100ms) to batch rapid appends

**Subagent handling:**

Claude Code spawns subagents whose logs live in
`<session-uuid>/subagents/agent-<id>.jsonl`. The watcher also watches these
files and attributes their usage to the parent session.

### Component 2: Pricing Engine (`src/main/lib/pricing.ts`)

A pure utility module that maps model IDs to per-token pricing and calculates
costs. No network calls — pricing is hardcoded and ships with the app.

**Cost formula (Claude):**

```
cost = (input_tokens / 1M × inputRate)
     + (output_tokens / 1M × outputRate)
     + (cache_creation_input_tokens / 1M × cacheWriteRate)
     + (cache_read_input_tokens / 1M × cacheReadRate)
```

**Cost formula (Codex / OpenAI):**

```
non_cached = input_tokens - cached_input_tokens
cost = (non_cached / 1M × inputRate)
     + (cached_input_tokens / 1M × cachedInputRate)
     + (output_tokens / 1M × outputRate)
```

**Pricing table (current as of 2026-03-01):**

| Model | Input/MTok | Output/MTok | Cache Write/MTok | Cache Read/MTok |
|-------|-----------|-------------|-----------------|-----------------|
| claude-opus-4-6 | $5.00 | $25.00 | $10.00 (1h) | $0.50 |
| claude-sonnet-4-6 | $3.00 | $15.00 | $6.00 (1h) | $0.30 |
| claude-haiku-4-5 | $1.00 | $5.00 | $2.00 (1h) | $0.10 |
| gpt-5-codex | $1.25 | $10.00 | — | $0.125 (cached) |
| gpt-5.1-codex | $1.25 | $10.00 | — | $0.125 (cached) |
| gpt-4.1 | $2.00 | $8.00 | — | $0.50 (cached) |
| o3 | $2.00 | $8.00 | — | $0.50 (cached) |
| o4-mini | $1.10 | $4.40 | — | $0.275 (cached) |

**Model ID normalization:**

Harness logs include dated model IDs (e.g., `claude-opus-4-6-20260101`).
The engine strips date suffixes for lookup. Unknown models fall back to the
most expensive rate in their family with a console warning.

**Long-context surcharge:** When total input tokens exceed 200K, Claude
models charge ~2x. The engine checks cumulative session tokens and applies
the surcharge when threshold is crossed.

### Component 3: Usage Store (`src/main/stores/usage-store.ts`)

SQLite persistence following the existing store pattern (ActivityStore,
FeedStore). Shared `latch.db` database.

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS usage_events (
  id                TEXT PRIMARY KEY,
  session_id        TEXT,             -- Latch session ID (null = untracked)
  harness_id        TEXT NOT NULL,    -- 'claude' | 'codex' | 'openclaw'
  model             TEXT NOT NULL,    -- e.g. 'claude-opus-4-6'
  timestamp         TEXT NOT NULL,    -- ISO 8601
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0.0,
  tool_name         TEXT,             -- tool used this turn (nullable)
  source_file       TEXT,             -- JSONL file path for dedup
  request_id        TEXT              -- dedup key within a file
);

CREATE INDEX IF NOT EXISTS idx_usage_session_ts
  ON usage_events (session_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_usage_ts
  ON usage_events (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_usage_source_req
  ON usage_events (source_file, request_id);
```

**Aggregate rollup table** (for fast dashboard queries):

```sql
CREATE TABLE IF NOT EXISTS usage_daily (
  date              TEXT NOT NULL,    -- YYYY-MM-DD
  harness_id        TEXT NOT NULL,
  model             TEXT NOT NULL,
  total_input       INTEGER NOT NULL DEFAULT 0,
  total_output      INTEGER NOT NULL DEFAULT 0,
  total_cache_write INTEGER NOT NULL DEFAULT 0,
  total_cache_read  INTEGER NOT NULL DEFAULT 0,
  total_cost_usd    REAL NOT NULL DEFAULT 0.0,
  event_count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, harness_id, model)
);
```

**Built-in aggregation queries:**

| Method | Returns |
|--------|---------|
| `summaryBySession(sessionId)` | Total tokens, cost, model breakdown for one session |
| `summaryByDay(days?)` | Daily rollup for dashboard (default 30 days) |
| `summaryByModel()` | Cost per model across all sessions |
| `summaryByProject(repoRoot)` | Aggregate across sessions for same repo |
| `topSessions(limit)` | Most expensive sessions |
| `cacheEfficiency(sessionId?)` | cache_read / (input + cache_write + cache_read) ratio |

**Retention:**

- `usage_events`: 50,000 rows max with auto-pruning every 500 inserts
- `usage_daily`: Kept indefinitely (one row per day/harness/model — small)

### Component 4: IPC Surface

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `latch:usage-list` | renderer → main | Paginated usage events |
| `latch:usage-summary` | renderer → main | Aggregated summaries (by session/day/model/project) |
| `latch:usage-clear` | renderer → main | Clear usage data |
| `latch:usage-export` | renderer → main | Export as JSON/CSV via file dialog |
| `latch:usage-event` | main → renderer | Real-time push of new usage events |
| `latch:usage-backfill-progress` | main → renderer | Backfill progress updates |

### Component 5: Preload Bridge

```ts
// In contextBridge exposure
listUsage: (payload?) => ipcRenderer.invoke('latch:usage-list', payload),
getUsageSummary: (payload?) => ipcRenderer.invoke('latch:usage-summary', payload),
clearUsage: (payload?) => ipcRenderer.invoke('latch:usage-clear', payload),
exportUsage: (payload?) => ipcRenderer.invoke('latch:usage-export', payload),
onUsageEvent: (cb) => { /* subscribe pattern with unsubscribe return */ },
onUsageBackfillProgress: (cb) => { /* subscribe pattern */ },
```

### Component 6: Zustand Store Additions

```ts
// State
usageEvents: UsageEvent[]
usageSummary: UsageSummary | null
usageLoading: boolean

// Actions
loadUsageView: () => Promise<void>       // fetch summary + recent events
handleUsageEvent: (event) => void        // real-time prepend
clearUsage: () => Promise<void>
```

### Component 7: UsageView (`src/renderer/components/UsageView.tsx`)

A full main-area view (not a rail panel) accessed via the sidebar "Usage"
nav item under the OBSERVE section.

**Visual layout:**

```
┌─────────────────────────────────────────────────────────────┐
│  USAGE                                            [Export]  │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  $14.82  │  │   847k   │  │   23k    │  │   72%    │  │
│  │  today   │  │  input   │  │  output  │  │  cache   │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
│                                                             │
│  DAILY SPEND                                                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  ▁ ▃ ▅ ▂ ▇ ▄ █                                     │   │
│  │  M T W T F S S                        $68.41 week   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  MODEL MIX                                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  ████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │   │
│  │  ■ opus $42.18   ■ sonnet $18.41   ■ haiku $7.82   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  SESSIONS                                      ▾ this week │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  fix auth bug                           ● claude    │   │
│  │  ████████░░  $4.82              12min · opus        │   │
│  │  847k input · 23k output · 92% cache                │   │
│  ├─────────────────────────────────────────────────────┤   │
│  │  refactor api routes                    ● codex     │   │
│  │  ████░░░░░░  $2.14               8min · gpt-5      │   │
│  │  312k input · 18k output                            │   │
│  ├─────────────────────────────────────────────────────┤   │
│  │  add unit tests                         ● claude    │   │
│  │  ██████████  $6.41              22min · sonnet      │   │
│  │  1.2M input · 45k output · 88% cache               │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  UNTRACKED SESSIONS                              3 found   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  ~/code/other-project                   ● claude    │   │
│  │  ██░░░░░░░░  $1.22                                  │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**Visual design details:**

- **Hero stat cards**: 4-column grid, pixel-square font at 28-32px for the
  big number. Cache efficiency colored: green (>70%), yellow (40-70%), red
  (<40%). Cards use `var(--bg-card)` with subtle border. Numbers animate on
  update (CSS counter transition).

- **Daily spend sparkline**: Pure CSS. 7 `div` bars with proportional
  heights. Tallest bar = `var(--text-primary)`, others at varying opacity.
  Day labels in 9px mono underneath. Total on the right. Hover on a bar
  shows that day's exact spend in a tooltip.

- **Model mix bar**: Single horizontal stacked bar. Each model segment gets
  a color from the design system: Opus = `rgb(var(--d-blue))`, Sonnet =
  `rgb(var(--d-green))`, Haiku = `rgba(255,255,255,0.3)`, GPT models =
  `rgb(var(--d-yellow))`. Legend below with colored squares + dollar amount.
  Bar has 4px border-radius, smooth width transitions on data change.

- **Session cards**: Each card has a thin horizontal progress bar showing
  relative cost (proportional to the most expensive session). Harness
  indicator dot colored by harness type. Token counts in 10px mono.
  Click to expand → per-turn breakdown with tool names and individual
  turn costs.

- **Untracked section**: Collapsed by default with a count badge. These are
  Claude/Codex sessions not started through Latch. Shown with their
  project directory path instead of a session name.

- **Real-time animation**: When a new usage event arrives via IPC push,
  the relevant stat card number ticks up, the session card for that session
  gets a brief pulse animation (`skill-installed-flash` keyframe pattern),
  and the sparkline bar for today grows.

- **Time filter**: Dropdown in the SESSIONS header — "today", "this week",
  "this month", "all time". Defaults to "this week".

- **Export button**: Top-right, opens file save dialog for JSON or CSV
  export of all usage data.

**CSS approach**: All new styles in `styles.css` using the existing design
tokens. No chart library. Sparklines, stacked bars, and progress bars are
all `div` elements with calculated widths/heights. Matches the terminal-first
aesthetic with monospace data, subtle transparency cards, and semantic colors.

---

## Phase 2: Session Timeline / Replay (future)

Visual timeline view of every agent action in a session. The JSONL data
already has everything needed:

- Each `assistant` message with `content[].type === "tool_use"` is an action
- `tool_result` messages show the outcome
- `thinking` blocks show reasoning
- `usage` on each turn shows cost per step
- `timestamp` fields give duration between steps

**UI concept**: Horizontal scrubbable timeline with action nodes. Each node
is color-coded by type (read = blue, write = green, bash = yellow, error =
red). Hovering shows detail. Cost annotation on each node. Zoomable from
session-level down to individual turns.

**Data**: Reuses the JSONL Watcher from Phase 1 but stores richer per-turn
data (full tool name, input summary, result summary, duration).

---

## Phase 3: Stuck / Loop Detection (future)

Real-time detection of unproductive agent behavior patterns:

- **Repeated file reads**: Same file path read 3+ times in N turns
- **Repeated command failures**: Same bash command failing repeatedly
- **Similar diff generation**: Agent writing, reverting, rewriting similar code
- **Cost velocity spike**: Spending rate jumps without corresponding git progress

**Alert UX**: Toast notification with cost-of-waste and an "Intervene" button
that focuses the session terminal. Could also auto-pause the PTY.

**Data**: Analyzed from the UsageStore event stream + JSONL tool call details.
Layered on top of existing Radar infrastructure.

---

## Phase 4: Deep Analytics (future)

- **Cost attribution by phase**: Classify each turn as planning (Read, Grep,
  Glob), implementation (Write, Edit), or debugging (Bash with test commands,
  error recovery). Break session cost into these buckets.
- **Context window pressure**: Track cumulative input tokens and cache
  hit/miss ratio over time. Visualize when the context "fills up" and cache
  starts flushing.
- **Agent effectiveness score**: Correlate sessions with git outcomes — did
  the diff grow? Did tests pass? Did the user revert the branch?
- **Rate limit visibility**: Detect gaps in the JSONL timestamp sequence that
  indicate the harness was throttled/waiting.
- **Per-project health dashboards**: Aggregate across all sessions for a repo.
  Total lifetime spend, sessions per week, model usage trends.

---

## JSONL File Schema Reference

### Claude Code (`~/.claude/projects/<slug>/<uuid>.jsonl`)

Each line is a JSON object with these root fields:

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"user"` \| `"assistant"` \| `"progress"` \| `"file-history-snapshot"` | Event type |
| `sessionId` | string UUID | Conversation identifier |
| `uuid` | string UUID | Unique line identifier |
| `timestamp` | ISO 8601 string | When this event occurred |
| `parentUuid` | string UUID \| null | Previous message in chain |
| `isSidechain` | boolean | `true` = subagent message |
| `message` | object | The message payload (see below) |
| `requestId` | string | API request ID (for dedup) |

**Assistant message.usage object:**

```json
{
  "input_tokens": 3,
  "output_tokens": 10,
  "cache_creation_input_tokens": 7976,
  "cache_read_input_tokens": 18706,
  "service_tier": "standard"
}
```

**Assistant message.model:** Full model ID with date suffix, e.g.
`"claude-opus-4-6-20260101"`.

**Tool use content blocks:**

```json
{
  "type": "tool_use",
  "id": "toolu_01...",
  "name": "Read",
  "input": { "file_path": "/path/to/file" }
}
```

### Codex CLI (`~/.codex/sessions/<id>.jsonl`)

Token events have `payload.type === "token_count"` with:
- `payload.info.total_token_usage` (cumulative)
- `payload.info.last_token_usage` (per-turn delta)
- `turn_context.model` (e.g., `"gpt-5-codex"`)

Token types: `input_tokens`, `cached_input_tokens`, `output_tokens`,
`reasoning_output_tokens`.

---

## Files to Create / Modify

### New files:
- `src/main/services/usage-watcher.ts` — JSONL file watcher service
- `src/main/lib/pricing.ts` — Model pricing table and cost calculator
- `src/main/stores/usage-store.ts` — SQLite store for usage events
- `src/renderer/components/UsageView.tsx` — Main usage dashboard view

### Modified files:
- `src/types/index.ts` — Add `UsageEvent`, `UsageSummary`, `AppView` union, `LatchAPI` methods
- `src/main/index.ts` — Initialize store + watcher, register IPC handlers
- `src/preload/index.ts` — Expose usage IPC methods via contextBridge
- `src/renderer/store/useAppStore.ts` — Add usage state + actions
- `src/renderer/App.tsx` — Register usage event listener, add UsageView route
- `src/renderer/components/Sidebar.tsx` — Restructure with section headers, add Usage nav item
- `src/renderer/styles.css` — Usage view styles, sidebar section headers

---

## Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Pricing source | Hardcoded table | No network dep, works offline, updated with releases |
| Chart library | None (pure CSS) | Matches existing aesthetic, no bundle bloat |
| File watching | `fs.watch` | Already available in Electron, no new deps |
| Storage | Shared `latch.db` SQLite | Follows existing store pattern |
| Untracked sessions | Included | Makes Latch useful from install, even without starting sessions through it |
| Historical backfill | Yes, on first launch | Immediate value from existing data |
| Retention | 50K events + permanent daily rollups | Usage data is high-value, worth keeping |

---

## Open Questions

1. **Codex OTel integration**: Codex supports OpenTelemetry export. Should
   Latch spin up an OTel collector endpoint as an alternative/supplement to
   JSONL parsing? Deferred to Phase 2+.
2. **Budget alerts**: Should Phase 1 include configurable daily/weekly budget
   thresholds with notifications? Could be a fast follow.
3. **OpenClaw log format**: TBD — need to investigate once OpenClaw is more
   widely available.
