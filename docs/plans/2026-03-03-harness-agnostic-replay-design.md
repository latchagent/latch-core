# Harness-Agnostic Conversation Replay Design

**Goal:** Make the replay/conversation system work across all harnesses (Claude Code, OpenCode, Codex, future harnesses) using a ConversationSource pattern, so replay, timeline, analytics, and live tailing work regardless of which harness produced the data.

**Date:** 2026-03-03

---

## Design Decisions

1. **Data source:** Plugin/SSE feeds Latch-owned store (not reading harness-native data directly)
2. **Migration:** Keep Claude JSONL parser alongside new store (dual-source, zero risk to working Claude path)
3. **Event detail:** Full turn data — tool name, args, result, error, tokens, cost, thinking, model
4. **Architecture:** ConversationSource interface pattern with per-source implementations and a registry

---

## Architecture

### ConversationSource Interface

```typescript
// src/main/lib/conversation-source.ts

interface ConversationSource {
  id: string                    // 'claude-jsonl' | 'opencode-sse' | ...
  listConversations(projectSlug?: string): TimelineConversation[]
  loadConversation(conversationId: string): TimelineData | null
}

class ConversationRegistry {
  private sources: ConversationSource[] = []
  register(source: ConversationSource): void
  listAll(projectSlug?: string): TimelineConversation[]   // merged, sorted by lastModified
  load(conversationId: string, sourceId: string): TimelineData | null
}
```

### Concrete Implementations

| Source | Data origin | Registration |
|--------|------------|-------------|
| `ClaudeConversationSource` | JSONL files in `~/.claude/projects/` | Wraps existing `timeline-parser.ts` — zero changes to parser |
| `PluginConversationSource` | `conversation_events` SQLite table | Fed by `OpenCodeTailer` SSE client |

### Type Extension

```typescript
export interface TimelineConversation {
  // ... existing fields ...
  sourceId: string          // 'claude-jsonl' | 'opencode-sse' | ...
  harnessId?: string        // 'claude' | 'opencode' | ...
}
```

---

## Data Model (SQLite)

One new table stores events from all non-Claude harnesses:

```sql
CREATE TABLE IF NOT EXISTS conversation_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  harness_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  kind TEXT NOT NULL,           -- 'tool-call' | 'thinking' | 'response' | 'prompt'
                               -- | 'session-start' | 'session-end' | 'file-edit'
                               -- | 'step-finish'

  -- Turn tracking
  turn_index INTEGER,

  -- Tool call data
  tool_name TEXT,
  tool_input TEXT,             -- truncated summary
  tool_result TEXT,            -- truncated result
  is_error INTEGER DEFAULT 0,

  -- Model / tokens / cost
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd REAL,

  -- Text content
  text_content TEXT            -- response text or thinking text
);

CREATE INDEX IF NOT EXISTS idx_ce_session ON conversation_events(session_id);
CREATE INDEX IF NOT EXISTS idx_ce_session_ts ON conversation_events(session_id, timestamp);
```

**Turn assembly** in `PluginConversationSource`: Group events by `(session_id, turn_index)`. Within each group:
- `prompt` → user prompt text
- `tool-call` events → `TimelineToolCall[]`
- `thinking` → `thinkingSummary`
- `response` → `textSummary`, model, tokens, cost

**Conversation listing:** `SELECT session_id, harness_id, MIN(timestamp), MAX(timestamp), SUM(cost_usd), COUNT(DISTINCT turn_index) FROM conversation_events GROUP BY session_id` joined with `sessions` table.

---

## Data Flow: OpenCode SSE Event Stream

OpenCode exposes a full REST API with SSE event streaming at `GET /event`. This gives us complete data — tokens, cost, model, thinking/reasoning, tool input/output, timing — full parity with Claude's JSONL.

```
OpenCode TUI starts in PTY
  → Latch discovers API URL (plugin reports via POST to authz server)
  → OpenCodeTailer subscribes to GET /event?directory=<workdir> (SSE)

SSE events processed:
  EventMessageUpdated       → AssistantMessage: cost, tokens, model, timing
  EventMessagePartUpdated   → ToolPart (input/output/timing/error)
                            → TextPart (response text)
                            → ReasoningPart (thinking text)
                            → StepFinishPart (per-step cost/tokens)
  EventSessionStatus        → idle/busy/retry
  EventSessionCreated       → session start with title, directory
  EventFileEdited           → file changes

OpenCodeTailer:
  → Stores structured events in conversation_events (SQLite)
  → Emits latch:live-event to renderer (real-time feed)
  → Updates feed sidebar
```

### OpenCode Event Types (Key)

From OpenCode's auto-generated types:

- **`AssistantMessage`**: `cost: number`, `tokens: { input, output, reasoning, cache: { read, write } }`, `modelID`, `providerID`, `time: { created, completed }`, `error`, `finish`
- **`ToolPart`**: `tool: string`, `state: ToolState` with `input`, `output`, `time: { start, end }`, `status: pending|running|completed|error`
- **`ReasoningPart`**: `text: string` (thinking/reasoning content)
- **`TextPart`**: `text: string` (response text)
- **`StepFinishPart`**: `cost: number`, `tokens: { input, output, reasoning, cache: { read, write } }`

### API URL Discovery

The plugin's `session.created` hook captures the API base URL from context and POSTs it to our authz server. Once we have the URL, `OpenCodeTailer` connects.

### Architecture Parallel

| | Claude | OpenCode |
|--|--------|----------|
| Raw data source | JSONL files in `~/.claude/projects/` | SSE from local API (`/event`) |
| Live tailer | `live-tailer.ts` (file watcher) | `opencode-tailer.ts` (SSE client) |
| Replay parser | `timeline-parser.ts` (JSONL → turns) | `PluginConversationSource` (SQLite → turns) |
| Turn shape | `TimelineTurn` | Same `TimelineTurn` |

---

## Replay View Integration

### IPC Changes

- `listTimelineConversations` → delegates to `ConversationRegistry.listAll()` instead of `listConversations()` directly
- `loadTimeline` → extended to accept `{ filePath }` (Claude) or `{ sessionId, sourceId }` (others)

### ReplayView Changes

- `handleConversationSelect()` passes `sourceId` alongside identifier
- Conversation cards show harness badge (Claude vs OpenCode)
- Empty state: "No conversations found. Run an agent session to see replay data here."

### Store Changes (`useAppStore.ts`)

- `loadTimelineConversations()` — same IPC, now returns merged list
- `loadReplay(identifier, sourceId)` — passes sourceId for routing

### Live View

No changes — both `live-tailer.ts` (Claude) and `opencode-tailer.ts` emit `latch:live-event`.

---

## Error Handling

- **SSE connection drops** — Auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s)
- **API URL not available** — Queue retry until plugin reports URL
- **Malformed events** — Skip with `console.warn`
- **Missing fields** — Graceful defaults (cost=0, tokens=0, model='unknown')
- **Duplicate events** — Dedup by event ID (INSERT OR IGNORE)

---

## Testing

- **ConversationStore** — Insert events, query by session, verify aggregates
- **Turn assembly** — Raw events → `TimelineTurn[]` (tool grouping, thinking, cost summation)
- **ConversationRegistry** — Merge sources, sort order, sourceId routing
- **OpenCodeTailer** — Mock SSE, verify events stored and `latch:live-event` emitted
- **ClaudeConversationSource** — Verify delegation to existing parser

---

## Plugin Role (Revised)

The OpenCode plugin continues to handle:
- **Policy enforcement** — `tool.execute.before` → authz check → throw to block
- **Feed messages** — Session lifecycle events to feed sidebar
- **API URL reporting** — `session.created` hook reports the opencode API URL to Latch

Data collection moves entirely to the SSE event stream, which provides richer data than plugin hooks.

---

## Future Harnesses

To add a new harness (e.g., Codex):
1. Create a `CodexConversationSource` implementing the interface
2. Create a `codex-tailer.ts` (file watcher, SSE, or other mechanism)
3. Register the source in the `ConversationRegistry`
4. Everything else (replay view, analytics, live feed) works automatically
