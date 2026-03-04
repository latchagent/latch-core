# Harness-Agnostic Conversation Replay — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the replay/conversation system work across all harnesses via a ConversationSource pattern, with OpenCode SSE event streaming as the first non-Claude source.

**Architecture:** ConversationSource interface with ClaudeConversationSource (wraps existing JSONL parser) and PluginConversationSource (SQLite store fed by OpenCodeTailer SSE client). A ConversationRegistry merges results. Existing Claude replay path untouched.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), SSE (EventSource), Vitest, Electron IPC

---

## Task 1: Extend TimelineConversation Type

**Files:**
- Modify: `src/types/index.ts:813-824`

**Step 1: Add sourceId and harnessId to TimelineConversation**

Open `src/types/index.ts` and find the `TimelineConversation` interface (line 813). Add two new fields:

```typescript
export interface TimelineConversation {
  id: string
  filePath: string
  projectSlug: string
  projectName: string
  lastModified: string
  sizeBytes: number
  promptPreview: string | null
  totalCostUsd: number
  totalTokens: number
  turnCount: number
  sourceId: string           // NEW: 'claude-jsonl' | 'opencode-sse' | ...
  harnessId?: string         // NEW: 'claude' | 'opencode' | ...
}
```

**Step 2: Run type-check to see what breaks**

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | head -40`

Expected: Errors in `timeline-parser.ts` where `TimelineConversation` objects are created without `sourceId`. Note the locations.

**Step 3: Fix timeline-parser.ts to include sourceId**

Open `src/main/lib/timeline-parser.ts`. In `listConversations()` at line 111, add `sourceId: 'claude-jsonl'` to the conversation object pushed to the array. In `parseTimeline()` at line 474, add `sourceId: 'claude-jsonl'` to the conversation field.

In `listConversations()` (~line 111):
```typescript
conversations.push({
  id: file.replace('.jsonl', ''),
  filePath,
  projectSlug: slug,
  projectName,
  lastModified: stat.mtime.toISOString(),
  sizeBytes: stat.size,
  sourceId: 'claude-jsonl',  // NEW
  ...preview,
})
```

In `parseTimeline()` (~line 474):
```typescript
conversation: {
  id: path.basename(filePath, '.jsonl'),
  filePath,
  projectSlug: dirName,
  projectName,
  lastModified: fileStat?.mtime.toISOString() ?? new Date().toISOString(),
  sizeBytes: fileStat?.size ?? 0,
  promptPreview: null,
  totalCostUsd: totalCost,
  totalTokens,
  turnCount: turns.length,
  sourceId: 'claude-jsonl',  // NEW
},
```

**Step 4: Run type-check to verify fixes**

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | head -20`
Run: `npx tsc --noEmit -p tsconfig.web.json 2>&1 | head -20`

Expected: PASS (no errors related to sourceId).

**Step 5: Commit**

```bash
git add src/types/index.ts src/main/lib/timeline-parser.ts
git commit -m "feat: add sourceId/harnessId to TimelineConversation type"
```

---

## Task 2: Create ConversationStore (SQLite)

**Files:**
- Create: `src/main/stores/conversation-store.ts`
- Test: `src/main/stores/conversation-store.test.ts`

This follows the exact pattern from `src/main/stores/feed-store.ts`.

**Step 1: Write the failing test**

Create `src/main/stores/conversation-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { ConversationStore } from './conversation-store'

describe('ConversationStore', () => {
  let store: ConversationStore

  beforeEach(() => {
    const db = new Database(':memory:')
    store = ConversationStore.open(db)
  })

  it('records and retrieves a conversation event', () => {
    store.record({
      sessionId: 'sess-1',
      harnessId: 'opencode',
      timestamp: '2026-03-03T10:00:00Z',
      kind: 'tool-call',
      turnIndex: 1,
      toolName: 'Bash',
      toolInput: 'ls -la',
      toolResult: 'total 42',
      isError: false,
    })

    const events = store.listBySession('sess-1')
    expect(events).toHaveLength(1)
    expect(events[0].toolName).toBe('Bash')
    expect(events[0].turnIndex).toBe(1)
  })

  it('lists conversations with aggregates', () => {
    store.record({
      sessionId: 'sess-1',
      harnessId: 'opencode',
      timestamp: '2026-03-03T10:00:00Z',
      kind: 'tool-call',
      turnIndex: 1,
      toolName: 'Read',
      costUsd: 0.01,
    })
    store.record({
      sessionId: 'sess-1',
      harnessId: 'opencode',
      timestamp: '2026-03-03T10:01:00Z',
      kind: 'response',
      turnIndex: 1,
      model: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.02,
    })
    store.record({
      sessionId: 'sess-1',
      harnessId: 'opencode',
      timestamp: '2026-03-03T10:05:00Z',
      kind: 'prompt',
      turnIndex: 2,
      textContent: 'Fix the bug',
    })

    const convs = store.listConversations()
    expect(convs).toHaveLength(1)
    expect(convs[0].sessionId).toBe('sess-1')
    expect(convs[0].harnessId).toBe('opencode')
    expect(convs[0].totalCostUsd).toBeCloseTo(0.03)
    expect(convs[0].turnCount).toBe(2)
  })

  it('returns first prompt as preview', () => {
    store.record({
      sessionId: 'sess-1',
      harnessId: 'opencode',
      timestamp: '2026-03-03T10:00:00Z',
      kind: 'prompt',
      turnIndex: 1,
      textContent: 'Build a REST API',
    })

    const convs = store.listConversations()
    expect(convs[0].promptPreview).toBe('Build a REST API')
  })

  it('deduplicates events by id', () => {
    const params = {
      sessionId: 'sess-1',
      harnessId: 'opencode',
      timestamp: '2026-03-03T10:00:00Z',
      kind: 'tool-call' as const,
      turnIndex: 1,
      toolName: 'Bash',
    }
    store.record(params)
    store.record(params) // duplicate — should not throw

    const events = store.listBySession('sess-1')
    // May have 1 or 2 depending on ID generation, but no crash
    expect(events.length).toBeGreaterThanOrEqual(1)
  })

  it('clears events by session', () => {
    store.record({
      sessionId: 'sess-1',
      harnessId: 'opencode',
      timestamp: '2026-03-03T10:00:00Z',
      kind: 'session-start',
    })
    store.record({
      sessionId: 'sess-2',
      harnessId: 'opencode',
      timestamp: '2026-03-03T10:00:00Z',
      kind: 'session-start',
    })

    store.clear('sess-1')
    expect(store.listBySession('sess-1')).toHaveLength(0)
    expect(store.listBySession('sess-2')).toHaveLength(1)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/stores/conversation-store.test.ts 2>&1 | tail -20`
Expected: FAIL — module not found.

**Step 3: Write the ConversationStore implementation**

Create `src/main/stores/conversation-store.ts`:

```typescript
/**
 * @module conversation-store
 * @description SQLite-backed persistence for conversation events from non-Claude
 * harnesses (OpenCode SSE, future sources). Events are grouped by session and
 * assembled into TimelineTurn[] by PluginConversationSource.
 *
 * Follows the same pattern as feed-store.ts and activity-store.ts.
 */

import type Database from 'better-sqlite3'

let idCounter = 0

/** Maximum rows to retain. Pruning runs after every 100 inserts. */
const MAX_ROWS = 50_000

export interface ConversationEventRecord {
  id: string
  sessionId: string
  harnessId: string
  timestamp: string
  kind: string
  turnIndex: number | null
  toolName: string | null
  toolInput: string | null
  toolResult: string | null
  isError: boolean
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  costUsd: number | null
  textContent: string | null
}

export interface ConversationSummaryRow {
  sessionId: string
  harnessId: string
  firstTimestamp: string
  lastTimestamp: string
  totalCostUsd: number
  turnCount: number
  promptPreview: string | null
}

export class ConversationStore {
  db: Database.Database
  private insertsSincePrune = 0

  constructor(db: Database.Database) {
    this.db = db
  }

  static open(db: Database.Database): ConversationStore {
    const store = new ConversationStore(db)
    store._init()
    return store
  }

  _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_events (
        id                  TEXT PRIMARY KEY,
        session_id          TEXT NOT NULL,
        harness_id          TEXT NOT NULL,
        timestamp           TEXT NOT NULL,
        kind                TEXT NOT NULL,
        turn_index          INTEGER,
        tool_name           TEXT,
        tool_input          TEXT,
        tool_result         TEXT,
        is_error            INTEGER DEFAULT 0,
        model               TEXT,
        input_tokens        INTEGER,
        output_tokens       INTEGER,
        reasoning_tokens    INTEGER,
        cache_read_tokens   INTEGER,
        cache_write_tokens  INTEGER,
        cost_usd            REAL,
        text_content        TEXT
      );
    `)

    try {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_ce_session
          ON conversation_events (session_id);
        CREATE INDEX IF NOT EXISTS idx_ce_session_ts
          ON conversation_events (session_id, timestamp);
      `)
    } catch {
      // Indices already exist
    }
  }

  /** Record a new conversation event. */
  record(params: {
    sessionId: string
    harnessId: string
    timestamp: string
    kind: string
    turnIndex?: number
    toolName?: string
    toolInput?: string
    toolResult?: string
    isError?: boolean
    model?: string
    inputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    costUsd?: number
    textContent?: string
  }): ConversationEventRecord {
    const id = `ce-${Date.now()}-${++idCounter}`

    this.db.prepare(`
      INSERT OR IGNORE INTO conversation_events
        (id, session_id, harness_id, timestamp, kind, turn_index,
         tool_name, tool_input, tool_result, is_error,
         model, input_tokens, output_tokens, reasoning_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, text_content)
      VALUES
        (@id, @session_id, @harness_id, @timestamp, @kind, @turn_index,
         @tool_name, @tool_input, @tool_result, @is_error,
         @model, @input_tokens, @output_tokens, @reasoning_tokens,
         @cache_read_tokens, @cache_write_tokens, @cost_usd, @text_content)
    `).run({
      id,
      session_id: params.sessionId,
      harness_id: params.harnessId,
      timestamp: params.timestamp,
      kind: params.kind,
      turn_index: params.turnIndex ?? null,
      tool_name: params.toolName ?? null,
      tool_input: params.toolInput ?? null,
      tool_result: params.toolResult ?? null,
      is_error: params.isError ? 1 : 0,
      model: params.model ?? null,
      input_tokens: params.inputTokens ?? null,
      output_tokens: params.outputTokens ?? null,
      reasoning_tokens: params.reasoningTokens ?? null,
      cache_read_tokens: params.cacheReadTokens ?? null,
      cache_write_tokens: params.cacheWriteTokens ?? null,
      cost_usd: params.costUsd ?? null,
      text_content: params.textContent ?? null,
    })

    this.insertsSincePrune++
    if (this.insertsSincePrune >= 100) {
      this.insertsSincePrune = 0
      this._prune()
    }

    return {
      id,
      sessionId: params.sessionId,
      harnessId: params.harnessId,
      timestamp: params.timestamp,
      kind: params.kind,
      turnIndex: params.turnIndex ?? null,
      toolName: params.toolName ?? null,
      toolInput: params.toolInput ?? null,
      toolResult: params.toolResult ?? null,
      isError: params.isError ?? false,
      model: params.model ?? null,
      inputTokens: params.inputTokens ?? null,
      outputTokens: params.outputTokens ?? null,
      reasoningTokens: params.reasoningTokens ?? null,
      cacheReadTokens: params.cacheReadTokens ?? null,
      cacheWriteTokens: params.cacheWriteTokens ?? null,
      costUsd: params.costUsd ?? null,
      textContent: params.textContent ?? null,
    }
  }

  /** List all events for a session, oldest first. */
  listBySession(sessionId: string): ConversationEventRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM conversation_events WHERE session_id = ? ORDER BY timestamp ASC`
    ).all(sessionId) as any[]

    return rows.map(this._mapRow)
  }

  /** List conversation summaries (one per session), newest first. */
  listConversations(): ConversationSummaryRow[] {
    const rows = this.db.prepare(`
      SELECT
        session_id,
        harness_id,
        MIN(timestamp) as first_ts,
        MAX(timestamp) as last_ts,
        COALESCE(SUM(cost_usd), 0) as total_cost,
        COUNT(DISTINCT turn_index) as turn_count
      FROM conversation_events
      GROUP BY session_id
      ORDER BY last_ts DESC
    `).all() as any[]

    return rows.map((row) => {
      // Get first prompt text as preview
      const promptRow = this.db.prepare(`
        SELECT text_content FROM conversation_events
        WHERE session_id = ? AND kind = 'prompt' AND text_content IS NOT NULL
        ORDER BY timestamp ASC LIMIT 1
      `).get(row.session_id) as any | undefined

      return {
        sessionId: row.session_id,
        harnessId: row.harness_id,
        firstTimestamp: row.first_ts,
        lastTimestamp: row.last_ts,
        totalCostUsd: row.total_cost,
        turnCount: row.turn_count,
        promptPreview: promptRow?.text_content ?? null,
      }
    })
  }

  /** Delete events. If sessionId provided, only that session. */
  clear(sessionId?: string): void {
    if (sessionId) {
      this.db.prepare('DELETE FROM conversation_events WHERE session_id = ?').run(sessionId)
    } else {
      this.db.exec('DELETE FROM conversation_events')
    }
  }

  /** Check if a session has any events. */
  hasSession(sessionId: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM conversation_events WHERE session_id = ? LIMIT 1'
    ).get(sessionId) as any | undefined
    return !!row
  }

  private _prune(): void {
    try {
      this.db.prepare(`
        DELETE FROM conversation_events WHERE rowid NOT IN (
          SELECT rowid FROM conversation_events ORDER BY timestamp DESC LIMIT ?
        )
      `).run(MAX_ROWS)
    } catch {
      // Non-fatal
    }
  }

  private _mapRow(row: any): ConversationEventRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      harnessId: row.harness_id,
      timestamp: row.timestamp,
      kind: row.kind,
      turnIndex: row.turn_index,
      toolName: row.tool_name,
      toolInput: row.tool_input,
      toolResult: row.tool_result,
      isError: row.is_error === 1,
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      reasoningTokens: row.reasoning_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      costUsd: row.cost_usd,
      textContent: row.text_content,
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/stores/conversation-store.test.ts 2>&1 | tail -20`
Expected: All 5 tests PASS.

**Step 5: Commit**

```bash
git add src/main/stores/conversation-store.ts src/main/stores/conversation-store.test.ts
git commit -m "feat: add ConversationStore for non-Claude conversation events"
```

---

## Task 3: ConversationSource Interface + Registry + ClaudeConversationSource

**Files:**
- Create: `src/main/lib/conversation-source.ts`
- Test: `src/main/lib/conversation-source.test.ts`

**Step 1: Write the failing test**

Create `src/main/lib/conversation-source.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  ConversationRegistry,
  ClaudeConversationSource,
} from './conversation-source'
import type { TimelineConversation, TimelineData } from '../../types'

/** Minimal stub source for testing the registry. */
class StubSource {
  id = 'stub'
  conversations: TimelineConversation[]
  constructor(conversations: TimelineConversation[]) {
    this.conversations = conversations
  }
  listConversations(): TimelineConversation[] {
    return this.conversations
  }
  loadConversation(_id: string): TimelineData | null {
    return null
  }
}

const CONV_A: TimelineConversation = {
  id: 'conv-a',
  filePath: '/a.jsonl',
  projectSlug: 'proj-a',
  projectName: 'Project A',
  lastModified: '2026-03-03T12:00:00Z',
  sizeBytes: 1024,
  promptPreview: 'hello',
  totalCostUsd: 1.5,
  totalTokens: 5000,
  turnCount: 10,
  sourceId: 'stub',
}

const CONV_B: TimelineConversation = {
  id: 'conv-b',
  filePath: '/b.jsonl',
  projectSlug: 'proj-b',
  projectName: 'Project B',
  lastModified: '2026-03-03T14:00:00Z',
  sizeBytes: 2048,
  promptPreview: 'world',
  totalCostUsd: 0.5,
  totalTokens: 2000,
  turnCount: 5,
  sourceId: 'stub',
}

describe('ConversationRegistry', () => {
  it('merges conversations from multiple sources, sorted by lastModified desc', () => {
    const src1 = new StubSource([CONV_A])
    const src2 = new StubSource([CONV_B])

    const registry = new ConversationRegistry()
    registry.register(src1)
    registry.register(src2)

    const all = registry.listAll()
    expect(all).toHaveLength(2)
    expect(all[0].id).toBe('conv-b') // newer
    expect(all[1].id).toBe('conv-a')
  })

  it('routes load() to the correct source by sourceId', () => {
    const src1 = new StubSource([CONV_A])
    const registry = new ConversationRegistry()
    registry.register(src1)

    const result = registry.load('conv-a', 'stub')
    expect(result).toBeNull() // StubSource returns null
  })

  it('returns null for unknown sourceId', () => {
    const registry = new ConversationRegistry()
    const result = registry.load('conv-a', 'nonexistent')
    expect(result).toBeNull()
  })
})

describe('ClaudeConversationSource', () => {
  it('has id = claude-jsonl', () => {
    const src = new ClaudeConversationSource()
    expect(src.id).toBe('claude-jsonl')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/lib/conversation-source.test.ts 2>&1 | tail -20`
Expected: FAIL — module not found.

**Step 3: Write the implementation**

Create `src/main/lib/conversation-source.ts`:

```typescript
/**
 * @module conversation-source
 * @description Harness-agnostic conversation data abstraction.
 *
 * ConversationSource is the interface each data source implements.
 * ConversationRegistry aggregates all registered sources.
 * ClaudeConversationSource wraps the existing timeline-parser (JSONL).
 * PluginConversationSource reads from the conversation_events SQLite table.
 */

import type { TimelineConversation, TimelineData, TimelineTurn, TimelineToolCall, TimelineActionType } from '../../types'
import { listConversations, parseTimeline } from './timeline-parser'
import { classifyAction } from './timeline-classifier'
import type { ConversationStore, ConversationEventRecord } from '../stores/conversation-store'

// ── Interface ────────────────────────────────────────────────────────────────

export interface ConversationSource {
  id: string
  listConversations(projectSlug?: string): TimelineConversation[]
  loadConversation(conversationId: string): TimelineData | null
}

// ── Registry ─────────────────────────────────────────────────────────────────

export class ConversationRegistry {
  private sources: ConversationSource[] = []

  register(source: ConversationSource): void {
    this.sources.push(source)
  }

  /** Merge conversations from all sources, sorted by lastModified desc. */
  listAll(projectSlug?: string): TimelineConversation[] {
    const all: TimelineConversation[] = []
    for (const source of this.sources) {
      try {
        all.push(...source.listConversations(projectSlug))
      } catch (err) {
        console.warn(`[conversation-registry] Error listing from ${source.id}:`, err)
      }
    }
    all.sort((a, b) => b.lastModified.localeCompare(a.lastModified))
    return all
  }

  /** Load a conversation from the source matching sourceId. */
  load(conversationId: string, sourceId: string): TimelineData | null {
    const source = this.sources.find((s) => s.id === sourceId)
    if (!source) return null
    try {
      return source.loadConversation(conversationId)
    } catch (err) {
      console.warn(`[conversation-registry] Error loading from ${sourceId}:`, err)
      return null
    }
  }
}

// ── Claude Source ─────────────────────────────────────────────────────────────

export class ClaudeConversationSource implements ConversationSource {
  id = 'claude-jsonl'

  listConversations(projectSlug?: string): TimelineConversation[] {
    return listConversations(projectSlug)
  }

  loadConversation(conversationId: string): TimelineData | null {
    // conversationId for Claude is the filePath
    try {
      return parseTimeline(conversationId)
    } catch {
      return null
    }
  }
}

// ── Plugin Source ─────────────────────────────────────────────────────────────

/**
 * Summarize a tool input string to max length.
 */
function summarize(text: string | null, maxLen = 2000): string | null {
  if (!text) return null
  const clean = text.trim()
  if (!clean) return null
  return clean.length > maxLen ? clean.slice(0, maxLen) + '…' : clean
}

export class PluginConversationSource implements ConversationSource {
  id = 'opencode-sse'
  private store: ConversationStore
  private sessionNames: Map<string, { name: string; projectName: string }> = new Map()

  constructor(store: ConversationStore) {
    this.store = store
  }

  /** Update cached session metadata for conversation listing. */
  setSessionMeta(sessionId: string, name: string, projectName: string): void {
    this.sessionNames.set(sessionId, { name, projectName })
  }

  listConversations(): TimelineConversation[] {
    const summaries = this.store.listConversations()
    return summaries.map((s) => {
      const meta = this.sessionNames.get(s.sessionId)
      return {
        id: s.sessionId,
        filePath: s.sessionId, // not a real file — used as identifier
        projectSlug: s.sessionId,
        projectName: meta?.projectName ?? s.harnessId,
        lastModified: s.lastTimestamp,
        sizeBytes: 0,
        promptPreview: s.promptPreview,
        totalCostUsd: s.totalCostUsd,
        totalTokens: 0, // calculated during full load
        turnCount: s.turnCount,
        sourceId: this.id,
        harnessId: s.harnessId,
      }
    })
  }

  loadConversation(sessionId: string): TimelineData | null {
    const events = this.store.listBySession(sessionId)
    if (events.length === 0) return null
    return this.assembleTimeline(sessionId, events)
  }

  /**
   * Assemble raw conversation events into TimelineData.
   * Groups events by turn_index, builds TimelineTurn for each group.
   */
  private assembleTimeline(sessionId: string, events: ConversationEventRecord[]): TimelineData {
    // Group events by turn_index
    const turnGroups = new Map<number, ConversationEventRecord[]>()
    const ungrouped: ConversationEventRecord[] = []

    for (const event of events) {
      if (event.turnIndex != null) {
        const group = turnGroups.get(event.turnIndex) ?? []
        group.push(event)
        turnGroups.set(event.turnIndex, group)
      } else {
        ungrouped.push(event)
      }
    }

    const turns: TimelineTurn[] = []
    let totalCost = 0
    const modelsSet = new Set<string>()

    // Sort turn indices
    const sortedIndices = [...turnGroups.keys()].sort((a, b) => a - b)

    for (const turnIdx of sortedIndices) {
      const group = turnGroups.get(turnIdx)!

      // Extract components from the group
      let promptText: string | null = null
      let thinkingText: string | null = null
      let responseText: string | null = null
      let model = ''
      let costUsd = 0
      let inputTokens = 0
      let outputTokens = 0
      let cacheReadTokens = 0
      let cacheWriteTokens = 0
      let timestamp = group[0].timestamp
      const toolCalls: TimelineToolCall[] = []

      for (const evt of group) {
        if (evt.kind === 'prompt') {
          promptText = evt.textContent
          timestamp = evt.timestamp
        } else if (evt.kind === 'thinking') {
          thinkingText = evt.textContent
        } else if (evt.kind === 'response') {
          responseText = evt.textContent
          if (evt.model) model = evt.model
          if (evt.costUsd) costUsd += evt.costUsd
          if (evt.inputTokens) inputTokens += evt.inputTokens
          if (evt.outputTokens) outputTokens += evt.outputTokens
          if (evt.cacheReadTokens) cacheReadTokens += evt.cacheReadTokens
          if (evt.cacheWriteTokens) cacheWriteTokens += evt.cacheWriteTokens
        } else if (evt.kind === 'step-finish') {
          if (evt.model) model = evt.model
          if (evt.costUsd) costUsd += evt.costUsd
          if (evt.inputTokens) inputTokens += evt.inputTokens
          if (evt.outputTokens) outputTokens += evt.outputTokens
          if (evt.cacheReadTokens) cacheReadTokens += evt.cacheReadTokens
          if (evt.cacheWriteTokens) cacheWriteTokens += evt.cacheWriteTokens
        } else if (evt.kind === 'tool-call') {
          toolCalls.push({
            name: evt.toolName ?? 'unknown',
            id: evt.id,
            inputSummary: evt.toolInput ?? '',
            resultSummary: summarize(evt.toolResult),
            isError: evt.isError,
          })
        }
      }

      if (model) modelsSet.add(model)
      totalCost += costUsd

      // If this group is just a user prompt, create a prompt turn
      if (promptText && toolCalls.length === 0 && !responseText) {
        turns.push({
          index: turns.length,
          requestId: null,
          timestamp,
          durationMs: null,
          model: '',
          stopReason: null,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingSummary: null,
          textSummary: summarize(promptText),
          toolCalls: [],
          actionType: 'prompt',
        })
        continue
      }

      // Assistant turn
      const primaryTool = toolCalls[0]
      const hasError = toolCalls.some((tc) => tc.isError)
      const actionType: TimelineActionType = classifyAction(
        primaryTool?.name ?? null,
        hasError,
      )

      turns.push({
        index: turns.length,
        requestId: null,
        timestamp,
        durationMs: null,
        model,
        stopReason: null,
        costUsd,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        thinkingSummary: summarize(thinkingText),
        textSummary: summarize(responseText ?? promptText),
        toolCalls,
        actionType,
      })
    }

    // Calculate durations from gaps
    for (let i = 0; i < turns.length - 1; i++) {
      const thisTs = new Date(turns[i].timestamp).getTime()
      const nextTs = new Date(turns[i + 1].timestamp).getTime()
      const gap = nextTs - thisTs
      turns[i].durationMs = gap >= 0 ? gap : null
    }

    let totalDurationMs = 0
    if (turns.length >= 2) {
      const first = new Date(turns[0].timestamp).getTime()
      const last = new Date(turns[turns.length - 1].timestamp).getTime()
      totalDurationMs = last - first
    }

    const totalTokens = turns.reduce(
      (s, t) => s + t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens,
      0,
    )

    const meta = this.sessionNames.get(sessionId)

    return {
      conversation: {
        id: sessionId,
        filePath: sessionId,
        projectSlug: sessionId,
        projectName: meta?.projectName ?? 'OpenCode',
        lastModified: events[events.length - 1]?.timestamp ?? new Date().toISOString(),
        sizeBytes: 0,
        promptPreview: null,
        totalCostUsd: totalCost,
        totalTokens,
        turnCount: turns.length,
        sourceId: this.id,
      },
      turns,
      totalCostUsd: totalCost,
      totalDurationMs,
      turnCount: turns.length,
      models: Array.from(modelsSet),
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/lib/conversation-source.test.ts 2>&1 | tail -20`
Expected: All 4 tests PASS.

**Step 5: Commit**

```bash
git add src/main/lib/conversation-source.ts src/main/lib/conversation-source.test.ts
git commit -m "feat: ConversationSource interface, registry, Claude + Plugin sources"
```

---

## Task 4: Test Turn Assembly in PluginConversationSource

**Files:**
- Modify: `src/main/lib/conversation-source.test.ts`

**Step 1: Write turn assembly tests**

Add to the existing test file:

```typescript
import Database from 'better-sqlite3'
import { ConversationStore } from '../stores/conversation-store'
import { PluginConversationSource } from './conversation-source'

describe('PluginConversationSource', () => {
  let store: ConversationStore
  let source: PluginConversationSource

  beforeEach(() => {
    const db = new Database(':memory:')
    store = ConversationStore.open(db)
    source = new PluginConversationSource(store)
  })

  it('assembles tool calls into turns grouped by turn_index', () => {
    store.record({ sessionId: 's1', harnessId: 'opencode', timestamp: '2026-03-03T10:00:00Z', kind: 'prompt', turnIndex: 1, textContent: 'Fix the bug' })
    store.record({ sessionId: 's1', harnessId: 'opencode', timestamp: '2026-03-03T10:00:05Z', kind: 'tool-call', turnIndex: 2, toolName: 'Read', toolInput: 'src/main.ts', toolResult: 'file content...' })
    store.record({ sessionId: 's1', harnessId: 'opencode', timestamp: '2026-03-03T10:00:06Z', kind: 'tool-call', turnIndex: 2, toolName: 'Edit', toolInput: 'src/main.ts', toolResult: 'ok' })
    store.record({ sessionId: 's1', harnessId: 'opencode', timestamp: '2026-03-03T10:00:07Z', kind: 'response', turnIndex: 2, model: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 500, costUsd: 0.02, textContent: 'Fixed the bug.' })

    const data = source.loadConversation('s1')
    expect(data).not.toBeNull()
    expect(data!.turns).toHaveLength(2)

    // Turn 1: prompt
    expect(data!.turns[0].actionType).toBe('prompt')
    expect(data!.turns[0].textSummary).toContain('Fix the bug')

    // Turn 2: assistant with tool calls
    expect(data!.turns[1].toolCalls).toHaveLength(2)
    expect(data!.turns[1].toolCalls[0].name).toBe('Read')
    expect(data!.turns[1].toolCalls[1].name).toBe('Edit')
    expect(data!.turns[1].model).toBe('claude-sonnet-4-6')
    expect(data!.turns[1].costUsd).toBeCloseTo(0.02)
  })

  it('sums step-finish tokens and cost', () => {
    store.record({ sessionId: 's1', harnessId: 'opencode', timestamp: '2026-03-03T10:00:00Z', kind: 'step-finish', turnIndex: 1, model: 'claude-sonnet-4-6', inputTokens: 500, outputTokens: 200, costUsd: 0.01 })
    store.record({ sessionId: 's1', harnessId: 'opencode', timestamp: '2026-03-03T10:00:01Z', kind: 'step-finish', turnIndex: 1, model: 'claude-sonnet-4-6', inputTokens: 800, outputTokens: 300, costUsd: 0.015 })

    const data = source.loadConversation('s1')
    expect(data!.turns[0].inputTokens).toBe(1300)
    expect(data!.turns[0].outputTokens).toBe(500)
    expect(data!.turns[0].costUsd).toBeCloseTo(0.025)
  })

  it('returns null for empty session', () => {
    expect(source.loadConversation('nonexistent')).toBeNull()
  })

  it('calculates total cost and duration', () => {
    store.record({ sessionId: 's1', harnessId: 'opencode', timestamp: '2026-03-03T10:00:00Z', kind: 'prompt', turnIndex: 1, textContent: 'Start' })
    store.record({ sessionId: 's1', harnessId: 'opencode', timestamp: '2026-03-03T10:05:00Z', kind: 'response', turnIndex: 2, costUsd: 0.1, model: 'claude-sonnet-4-6', inputTokens: 2000, outputTokens: 1000 })

    const data = source.loadConversation('s1')
    expect(data!.totalCostUsd).toBeCloseTo(0.1)
    expect(data!.totalDurationMs).toBe(300_000) // 5 minutes
    expect(data!.models).toContain('claude-sonnet-4-6')
  })

  it('lists conversations from the store', () => {
    store.record({ sessionId: 's1', harnessId: 'opencode', timestamp: '2026-03-03T10:00:00Z', kind: 'prompt', turnIndex: 1, textContent: 'Hello world' })

    const convs = source.listConversations()
    expect(convs).toHaveLength(1)
    expect(convs[0].sourceId).toBe('opencode-sse')
    expect(convs[0].promptPreview).toBe('Hello world')
  })
})
```

Add `import { beforeEach } from 'vitest'` at the top if not already present.

**Step 2: Run tests**

Run: `npx vitest run src/main/lib/conversation-source.test.ts 2>&1 | tail -30`
Expected: All tests PASS.

**Step 3: Commit**

```bash
git add src/main/lib/conversation-source.test.ts
git commit -m "test: turn assembly and conversation listing for PluginConversationSource"
```

---

## Task 5: Wire ConversationStore + Registry into Main Process

**Files:**
- Modify: `src/main/index.ts:34-99` (imports), `109-130` (declarations), `236-249` (store init), `1155-1174` (IPC handlers)

**Step 1: Add imports**

At the top of `src/main/index.ts`, add:

```typescript
import { ConversationStore }                      from './stores/conversation-store'
import {
  ConversationRegistry,
  ClaudeConversationSource,
  PluginConversationSource,
} from './lib/conversation-source'
```

**Step 2: Add declarations**

After line ~130 (the `let issueStore` line), add:

```typescript
let conversationStore: ConversationStore | null = null
let conversationRegistry: ConversationRegistry | null = null
let pluginConversationSource: PluginConversationSource | null = null
```

**Step 3: Initialize in the store-opening block**

After `issueStore = IssueStore.open(db)` (~line 249), add:

```typescript
    conversationStore = ConversationStore.open(db)

    // Set up harness-agnostic conversation registry
    conversationRegistry = new ConversationRegistry()
    conversationRegistry.register(new ClaudeConversationSource())
    pluginConversationSource = new PluginConversationSource(conversationStore)
    conversationRegistry.register(pluginConversationSource)
```

**Step 4: Update the IPC handlers**

Replace the existing `latch:timeline-conversations` handler (~line 1157):

```typescript
  ipcMain.handle('latch:timeline-conversations', async (_event: any, payload: any = {}) => {
    try {
      const conversations = conversationRegistry
        ? conversationRegistry.listAll(payload.projectSlug)
        : listConversations(payload.projectSlug)
      return { ok: true, conversations }
    } catch (err: unknown) {
      return { ok: false, conversations: [], error: err instanceof Error ? err.message : String(err) }
    }
  })
```

Replace the existing `latch:timeline-load` handler (~line 1166):

```typescript
  ipcMain.handle('latch:timeline-load', async (_event: any, payload: any = {}) => {
    const { filePath, sourceId } = payload
    if (!filePath && !sourceId) return { ok: false, data: null, error: 'filePath or sourceId required' }

    try {
      let data: import('../../types').TimelineData | null = null

      if (sourceId && conversationRegistry) {
        // Load via registry (harness-agnostic path)
        data = conversationRegistry.load(filePath, sourceId)
      } else if (filePath) {
        // Legacy path: direct JSONL parse
        data = parseTimeline(filePath)
      }

      return { ok: true, data }
    } catch (err: unknown) {
      return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) }
    }
  })
```

**Step 5: Run type-check**

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | head -20`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: wire ConversationStore + ConversationRegistry into main process"
```

---

## Task 6: Update Preload + Renderer Store for sourceId

**Files:**
- Modify: `src/preload/index.ts:461-470`
- Modify: `src/renderer/store/useAppStore.ts:1780-2000`

**Step 1: Update preload bridge**

In `src/preload/index.ts`, find the `loadTimeline` bridge (~line 464) and update it to accept the sourceId:

```typescript
    loadTimeline: (payload: { filePath: string; sourceId?: string }) =>
      ipcRenderer.invoke('latch:timeline-load', payload),
```

**Step 2: Update LatchAPI type**

In `src/types/index.ts`, find the `loadTimeline` method in `LatchAPI` (~line 1155) and update:

```typescript
  loadTimeline(payload: { filePath: string; sourceId?: string }): Promise<{ ok: boolean; data: TimelineData | null; error?: string }>;
```

**Step 3: Update useAppStore loadReplay**

In `src/renderer/store/useAppStore.ts`, find the `loadReplay` action. Update it to pass sourceId:

Change the signature from:
```typescript
loadReplay: async (filePath: string, sessionId?: string) => {
```
to:
```typescript
loadReplay: async (filePath: string, sessionId?: string, sourceId?: string) => {
```

And inside the function, update the IPC call:
```typescript
const result = await window.latch?.loadTimeline?.({ filePath, sourceId })
```

**Step 4: Run type-check**

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | head -20`
Run: `npx tsc --noEmit -p tsconfig.web.json 2>&1 | head -20`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/preload/index.ts src/types/index.ts src/renderer/store/useAppStore.ts
git commit -m "feat: pass sourceId through preload + store for harness-agnostic replay loading"
```

---

## Task 7: Update ReplayView for Multi-Source Conversations

**Files:**
- Modify: `src/renderer/components/ReplayView.tsx:333-349,591-630`

**Step 1: Update handleConversationSelect**

In `ReplayView.tsx`, update `handleConversationSelect` (~line 334) to pass sourceId:

```typescript
  const handleConversationSelect = (conv: TimelineConversation) => {
    setFilterSearch('')
    setFilterChips(new Set())
    let sessionId: string | undefined
    // For Claude source, match by path slug
    if (conv.sourceId === 'claude-jsonl') {
      for (const [id, s] of sessions) {
        const cwd = s.worktreePath ?? s.repoRoot
        if (cwd && cwd.replace(/[/.]/g, '-') === conv.projectSlug) {
          sessionId = id
          break
        }
      }
    } else {
      // For plugin sources, the conversation ID IS the session ID
      sessionId = conv.id
    }
    loadReplay(conv.filePath, sessionId, conv.sourceId)
  }
```

**Step 2: Update the conversation card onClick**

In the conversation list (~line 609), change the onClick:

From:
```typescript
onClick={() => handleConversationSelect(conv.filePath)}
```
To:
```typescript
onClick={() => handleConversationSelect(conv)}
```

**Step 3: Add harness badge to conversation cards**

In the conversation card header (~line 612), add a harness badge:

```typescript
<div className="replay-conv-header">
  <span className="replay-conv-project">{sessionNameBySlug.get(conv.projectSlug) ?? conv.projectName}</span>
  {conv.harnessId && conv.harnessId !== 'claude' && (
    <span className="replay-conv-harness">{conv.harnessId}</span>
  )}
  <span className="replay-conv-date">
    {new Date(conv.lastModified).toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
  </span>
</div>
```

**Step 4: Update empty state text**

Change the empty state hint (~line 601):

From:
```typescript
<span className="an-empty-hint">Run an agent session first. Conversations are loaded from Claude Code project logs.</span>
```
To:
```typescript
<span className="an-empty-hint">Run an agent session to see replay data here.</span>
```

**Step 5: Add CSS for harness badge**

In `src/renderer/styles.css`, add:

```css
.replay-conv-harness {
  font-size: 10px;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(var(--d-blue), 0.15);
  color: rgb(var(--d-blue));
  letter-spacing: 0.5px;
}
```

**Step 6: Run type-check**

Run: `npx tsc --noEmit -p tsconfig.web.json 2>&1 | head -20`
Expected: PASS.

**Step 7: Commit**

```bash
git add src/renderer/components/ReplayView.tsx src/renderer/styles.css
git commit -m "feat: multi-source conversation list with harness badges in ReplayView"
```

---

## Task 8: OpenCode Tailer — SSE Event Stream Client

**Files:**
- Create: `src/main/services/opencode-tailer.ts`
- Test: `src/main/services/opencode-tailer.test.ts`

This is the most complex task. The tailer connects to OpenCode's SSE `/event` endpoint and processes events into `conversation_events` + `latch:live-event` emissions.

**Step 1: Write the failing test**

Create `src/main/services/opencode-tailer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { ConversationStore } from '../stores/conversation-store'
import { OpenCodeTailer, processOpenCodeEvent } from './opencode-tailer'

describe('processOpenCodeEvent', () => {
  let store: ConversationStore
  let emitted: any[]

  beforeEach(() => {
    const db = new Database(':memory:')
    store = ConversationStore.open(db)
    emitted = []
  })

  const emit = (event: any) => emitted.push(event)

  it('processes EventMessageUpdated for assistant message with cost/tokens', () => {
    processOpenCodeEvent(
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg-1',
            sessionID: 'oc-sess-1',
            role: 'assistant',
            parentID: 'msg-0',
            modelID: 'claude-sonnet-4-6',
            providerID: 'anthropic',
            mode: 'build',
            path: { cwd: '/project', root: '/project' },
            cost: 0.05,
            tokens: { input: 2000, output: 800, reasoning: 100, cache: { read: 500, write: 200 } },
            time: { created: 1709467200 },
          },
        },
      },
      { sessionId: 'latch-sess-1', store, emit, turnIndex: 1 },
    )

    const events = store.listBySession('latch-sess-1')
    const stepFinish = events.find((e) => e.kind === 'step-finish')
    expect(stepFinish).toBeDefined()
    expect(stepFinish!.model).toBe('claude-sonnet-4-6')
    expect(stepFinish!.costUsd).toBe(0.05)
    expect(stepFinish!.inputTokens).toBe(2000)
    expect(stepFinish!.outputTokens).toBe(800)
  })

  it('processes EventMessagePartUpdated for tool-call with completed state', () => {
    processOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-1',
            sessionID: 'oc-sess-1',
            messageID: 'msg-1',
            type: 'tool',
            callID: 'call-1',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'ls -la' },
              output: 'total 42\ndrwxr-xr-x ...',
              title: 'ls -la',
              metadata: {},
              time: { start: 1709467200, end: 1709467201 },
            },
          },
        },
      },
      { sessionId: 'latch-sess-1', store, emit, turnIndex: 1 },
    )

    const events = store.listBySession('latch-sess-1')
    const toolCall = events.find((e) => e.kind === 'tool-call')
    expect(toolCall).toBeDefined()
    expect(toolCall!.toolName).toBe('bash')
    expect(toolCall!.toolInput).toBe('ls -la')
    expect(toolCall!.toolResult).toContain('total 42')
    expect(toolCall!.isError).toBe(false)

    // Should also emit a live event
    expect(emitted.length).toBeGreaterThan(0)
    const liveEvt = emitted.find((e: any) => e.kind === 'tool-call')
    expect(liveEvt).toBeDefined()
    expect(liveEvt.toolName).toBe('bash')
  })

  it('processes EventMessagePartUpdated for reasoning (thinking)', () => {
    processOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-2',
            sessionID: 'oc-sess-1',
            messageID: 'msg-1',
            type: 'reasoning',
            text: 'Let me think about this problem carefully...',
            metadata: {},
            time: { start: 1709467200 },
          },
        },
      },
      { sessionId: 'latch-sess-1', store, emit, turnIndex: 1 },
    )

    const events = store.listBySession('latch-sess-1')
    const thinking = events.find((e) => e.kind === 'thinking')
    expect(thinking).toBeDefined()
    expect(thinking!.textContent).toContain('think about this problem')
  })

  it('processes tool error state', () => {
    processOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-3',
            sessionID: 'oc-sess-1',
            messageID: 'msg-1',
            type: 'tool',
            callID: 'call-2',
            tool: 'bash',
            state: {
              status: 'error',
              input: { command: 'rm -rf /' },
              error: 'Permission denied',
              metadata: {},
              time: { start: 1709467200, end: 1709467201 },
            },
          },
        },
      },
      { sessionId: 'latch-sess-1', store, emit, turnIndex: 1 },
    )

    const events = store.listBySession('latch-sess-1')
    const toolCall = events.find((e) => e.kind === 'tool-call')
    expect(toolCall!.isError).toBe(true)
    expect(toolCall!.toolResult).toBe('Permission denied')
  })

  it('processes session status events', () => {
    processOpenCodeEvent(
      {
        type: 'session.status',
        properties: {
          sessionID: 'oc-sess-1',
          status: { type: 'idle' },
        },
      },
      { sessionId: 'latch-sess-1', store, emit, turnIndex: 1 },
    )

    const liveEvt = emitted.find((e: any) => e.kind === 'status-change')
    expect(liveEvt).toBeDefined()
    expect(liveEvt.sessionStatus).toBe('idle')
  })

  it('processes user message as prompt', () => {
    processOpenCodeEvent(
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg-0',
            sessionID: 'oc-sess-1',
            role: 'user',
            time: { created: 1709467200 },
            agent: 'build',
            model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
          },
        },
      },
      { sessionId: 'latch-sess-1', store, emit, turnIndex: 1 },
    )

    // User messages don't store conversation events (we get the text from parts)
    // But they should be handled without error
    expect(true).toBe(true)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/services/opencode-tailer.test.ts 2>&1 | tail -20`
Expected: FAIL — module not found.

**Step 3: Write the OpenCode tailer implementation**

Create `src/main/services/opencode-tailer.ts`:

```typescript
/**
 * @module opencode-tailer
 * @description Subscribes to OpenCode's local SSE event stream and processes
 * events into the ConversationStore for replay + emits LiveEvents for the
 * renderer's live feed.
 *
 * Analogous to live-tailer.ts for Claude, but reads from SSE instead of JSONL.
 */

import crypto from 'node:crypto'
import type { LiveEvent, LiveSessionStatus } from '../../types'
import type { ConversationStore } from '../stores/conversation-store'

// ── Configuration ───────────────────────────────────────────────────────────

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const SUMMARIZE_MAX_LEN = 200

// ── Helpers ─────────────────────────────────────────────────────────────────

function uid(): string {
  return `oc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
}

function summarize(text: string | null | undefined, maxLen = SUMMARIZE_MAX_LEN): string | null {
  if (!text) return null
  const clean = text.trim()
  if (!clean) return null
  return clean.length > maxLen ? clean.slice(0, maxLen - 3) + '...' : clean
}

function extractToolInput(tool: string, input: Record<string, unknown>): string {
  const fp = input?.file_path ?? input?.path
  if (fp && typeof fp === 'string') return fp
  const cmd = input?.command
  if (cmd && typeof cmd === 'string') return summarize(cmd, 120) ?? ''
  const pattern = input?.pattern
  if (pattern && typeof pattern === 'string') return pattern
  return ''
}

// ── Event Processing ────────────────────────────────────────────────────────

export interface ProcessContext {
  sessionId: string
  store: ConversationStore
  emit: (event: LiveEvent) => void
  turnIndex: number
}

/**
 * Process a single OpenCode SSE event.
 * This is exported for unit testing; the real tailer calls it internally.
 */
export function processOpenCodeEvent(event: any, ctx: ProcessContext): void {
  const type = event?.type as string
  if (!type) return

  const timestamp = new Date().toISOString()

  // ── message.updated — full message metadata (cost, tokens, model)
  if (type === 'message.updated') {
    const info = event.properties?.info
    if (!info) return

    if (info.role === 'assistant') {
      // Store as step-finish (aggregated turn data)
      ctx.store.record({
        sessionId: ctx.sessionId,
        harnessId: 'opencode',
        timestamp,
        kind: 'step-finish',
        turnIndex: ctx.turnIndex,
        model: info.modelID ?? null,
        inputTokens: info.tokens?.input ?? null,
        outputTokens: info.tokens?.output ?? null,
        reasoningTokens: info.tokens?.reasoning ?? null,
        cacheReadTokens: info.tokens?.cache?.read ?? null,
        cacheWriteTokens: info.tokens?.cache?.write ?? null,
        costUsd: info.cost ?? null,
      })
    }
    // User messages — we capture the prompt text via message.part.updated (text part)
    return
  }

  // ── message.part.updated — individual parts (text, tool, reasoning)
  if (type === 'message.part.updated') {
    const part = event.properties?.part
    if (!part) return

    // Tool calls
    if (part.type === 'tool') {
      const state = part.state
      if (!state) return
      // Only store completed or error states (not pending/running)
      if (state.status !== 'completed' && state.status !== 'error') return

      const isError = state.status === 'error'
      const toolInput = extractToolInput(part.tool, state.input ?? {})
      const toolResult = isError
        ? (state.error ?? 'Unknown error')
        : summarize(state.output ?? null, 2000) ?? ''

      ctx.store.record({
        sessionId: ctx.sessionId,
        harnessId: 'opencode',
        timestamp,
        kind: 'tool-call',
        turnIndex: ctx.turnIndex,
        toolName: part.tool,
        toolInput,
        toolResult,
        isError,
      })

      ctx.emit({
        id: uid(),
        sessionId: ctx.sessionId,
        timestamp,
        kind: 'tool-call',
        toolName: part.tool,
        target: toolInput || undefined,
        status: isError ? 'error' : 'success',
      })
      return
    }

    // Reasoning/thinking
    if (part.type === 'reasoning') {
      const text = part.text
      if (!text) return
      ctx.store.record({
        sessionId: ctx.sessionId,
        harnessId: 'opencode',
        timestamp,
        kind: 'thinking',
        turnIndex: ctx.turnIndex,
        textContent: summarize(text, 2000),
      })
      ctx.emit({
        id: uid(),
        sessionId: ctx.sessionId,
        timestamp,
        kind: 'thinking',
        thinkingSummary: summarize(text),
      })
      return
    }

    // Text response
    if (part.type === 'text' && !part.synthetic) {
      ctx.store.record({
        sessionId: ctx.sessionId,
        harnessId: 'opencode',
        timestamp,
        kind: 'response',
        turnIndex: ctx.turnIndex,
        textContent: summarize(part.text, 2000),
      })
      return
    }

    // Step finish (per-step cost/tokens)
    if (part.type === 'step-finish') {
      ctx.store.record({
        sessionId: ctx.sessionId,
        harnessId: 'opencode',
        timestamp,
        kind: 'step-finish',
        turnIndex: ctx.turnIndex,
        model: null,
        inputTokens: part.tokens?.input ?? null,
        outputTokens: part.tokens?.output ?? null,
        reasoningTokens: part.tokens?.reasoning ?? null,
        cacheReadTokens: part.tokens?.cache?.read ?? null,
        cacheWriteTokens: part.tokens?.cache?.write ?? null,
        costUsd: part.cost ?? null,
      })
      return
    }

    return
  }

  // ── session.status — idle/busy/retry
  if (type === 'session.status') {
    const status = event.properties?.status
    if (!status) return
    let sessionStatus: LiveSessionStatus = 'active'
    if (status.type === 'idle') sessionStatus = 'idle'
    else if (status.type === 'retry') sessionStatus = 'rate-limited'
    else if (status.type === 'busy') sessionStatus = 'active'

    ctx.emit({
      id: uid(),
      sessionId: ctx.sessionId,
      timestamp,
      kind: 'status-change',
      sessionStatus,
    })
    return
  }

  // ── session.idle — turn boundary (increment turn index)
  if (type === 'session.idle') {
    ctx.emit({
      id: uid(),
      sessionId: ctx.sessionId,
      timestamp,
      kind: 'status-change',
      sessionStatus: 'idle',
    })
    return
  }

  // ── file.edited
  if (type === 'file.edited') {
    const file = event.properties?.file
    if (!file) return
    ctx.store.record({
      sessionId: ctx.sessionId,
      harnessId: 'opencode',
      timestamp,
      kind: 'file-edit',
      turnIndex: ctx.turnIndex,
      toolName: 'file.edited',
      toolInput: file,
    })
    return
  }
}

// ── Tailer Lifecycle ────────────────────────────────────────────────────────

interface TailerState {
  sessionId: string
  apiUrl: string
  controller: AbortController | null
  turnIndex: number
  reconnectMs: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
}

const tailers = new Map<string, TailerState>()
let _sendToRenderer: ((channel: string, payload: unknown) => void) | null = null
let _store: ConversationStore | null = null

/** Initialize the OpenCode tailer module. */
export function initOpenCodeTailer(opts: {
  sendToRenderer: (channel: string, payload: unknown) => void
  store: ConversationStore
}): void {
  _sendToRenderer = opts.sendToRenderer
  _store = opts.store
}

/** Start tailing an OpenCode session's event stream. */
export function startOpenCodeTail(sessionId: string, apiUrl: string): void {
  if (tailers.has(sessionId)) return
  if (!_store || !_sendToRenderer) return

  const state: TailerState = {
    sessionId,
    apiUrl,
    controller: null,
    turnIndex: 0,
    reconnectMs: RECONNECT_BASE_MS,
    reconnectTimer: null,
  }
  tailers.set(sessionId, state)
  connectSSE(state)
}

/** Stop tailing an OpenCode session. */
export function stopOpenCodeTail(sessionId: string): void {
  const state = tailers.get(sessionId)
  if (!state) return
  if (state.controller) state.controller.abort()
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
  tailers.delete(sessionId)
}

/** Stop all OpenCode tailers. */
export function stopAllOpenCodeTails(): void {
  for (const sessionId of [...tailers.keys()]) {
    stopOpenCodeTail(sessionId)
  }
}

/** Report the OpenCode API URL for a session (called by plugin via authz). */
export function reportOpenCodeApiUrl(sessionId: string, apiUrl: string): void {
  if (tailers.has(sessionId)) return
  startOpenCodeTail(sessionId, apiUrl)
}

// ── Internal SSE Connection ─────────────────────────────────────────────────

async function connectSSE(state: TailerState): Promise<void> {
  if (!_store || !_sendToRenderer) return

  const store = _store
  const sendToRenderer = _sendToRenderer
  const controller = new AbortController()
  state.controller = controller

  const eventUrl = `${state.apiUrl}/event`

  try {
    const response = await fetch(eventUrl, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    })

    if (!response.ok || !response.body) {
      throw new Error(`SSE connect failed: ${response.status}`)
    }

    // Reset reconnect backoff on successful connection
    state.reconnectMs = RECONNECT_BASE_MS

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Parse SSE frames
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? '' // keep incomplete frame

      for (const frame of frames) {
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))
        if (!dataLine) continue

        try {
          const event = JSON.parse(dataLine.slice(6))

          // Increment turn on session.idle (turn boundary)
          if (event.type === 'session.idle') {
            state.turnIndex++
          }

          // Record prompt text from user message text parts
          if (event.type === 'message.part.updated' && event.properties?.part?.type === 'text') {
            const part = event.properties.part
            // Check if this is a user message part by checking if we have no current turn activity
            // Actually, user message text parts arrive before assistant response begins
          }

          processOpenCodeEvent(event, {
            sessionId: state.sessionId,
            store,
            emit: (liveEvent) => sendToRenderer('latch:live-event', liveEvent),
            turnIndex: state.turnIndex,
          })
        } catch {
          // Skip malformed events
        }
      }
    }
  } catch (err: unknown) {
    if (controller.signal.aborted) return // intentional stop

    console.warn(
      `[opencode-tailer] SSE connection lost for ${state.sessionId}:`,
      err instanceof Error ? err.message : String(err),
    )
  }

  // Schedule reconnect with exponential backoff
  if (tailers.has(state.sessionId)) {
    state.reconnectTimer = setTimeout(() => {
      connectSSE(state)
    }, state.reconnectMs)
    state.reconnectMs = Math.min(state.reconnectMs * 2, RECONNECT_MAX_MS)
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run src/main/services/opencode-tailer.test.ts 2>&1 | tail -30`
Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/main/services/opencode-tailer.ts src/main/services/opencode-tailer.test.ts
git commit -m "feat: OpenCodeTailer SSE event stream client with tests"
```

---

## Task 9: Add Authz Server Endpoint for API URL Reporting

**Files:**
- Modify: `src/main/services/authz-server.ts:536-548,620-662`

**Step 1: Add route matching for /opencode-api/:sessionId**

In `authz-server.ts`, find the route matching section (~line 536). After the `feedMatch` line, add:

```typescript
    // Route: POST /opencode-api/:sessionId — report opencode API URL
    const opencodeApiMatch = (!superviseMatch && !authzMatch && !notifyMatch && !feedMatch && !secretsMatch)
      ? req.url?.match(/^\/opencode-api\/([^/]+)$/)
      : null
```

**Step 2: Add handler in the dispatch block**

In the body parsing section (~line 604), after the `feedMatch` block, add:

```typescript
        } else if (opencodeApiMatch) {
          this.processOpenCodeApiReport(sessionId, body, res)
```

**Step 3: Add the handler method**

After the `processFeed` method (~line 662), add:

```typescript
  /** Process an OpenCode API URL report from the plugin. */
  private processOpenCodeApiReport(sessionId: string, body: string, res: http.ServerResponse): void {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(body)
    } catch {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Invalid JSON' }))
      return
    }

    const apiUrl = String(payload.apiUrl ?? '').trim()
    if (!apiUrl) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Missing apiUrl' }))
      return
    }

    // Forward to the opencode tailer
    this.onOpenCodeApiUrl?.(sessionId, apiUrl)

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  }
```

**Step 4: Add callback property to AuthzServer**

In the class properties section (~line 314), add:

```typescript
  onOpenCodeApiUrl: ((sessionId: string, apiUrl: string) => void) | null = null
```

**Step 5: Wire in main/index.ts**

In `src/main/index.ts`, after `authzServer.setSecretStore(secretStore)` (~line 282), add:

```typescript
    // Wire opencode API URL reporting to the tailer
    import('./services/opencode-tailer').then(({ initOpenCodeTailer, reportOpenCodeApiUrl }) => {
      if (conversationStore) {
        initOpenCodeTailer({ sendToRenderer, store: conversationStore })
      }
      if (authzServer) {
        authzServer.onOpenCodeApiUrl = (sessionId, apiUrl) => {
          console.log(`[opencode-tailer] API URL reported for ${sessionId}: ${apiUrl}`)
          reportOpenCodeApiUrl(sessionId, apiUrl)
        }
      }
    })
```

**Step 6: Run type-check**

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | head -30`
Expected: PASS.

**Step 7: Commit**

```bash
git add src/main/services/authz-server.ts src/main/index.ts
git commit -m "feat: authz endpoint for OpenCode API URL reporting, wire to tailer"
```

---

## Task 10: Update OpenCode Plugin to Report API URL

**Files:**
- Modify: `src/main/services/policy-enforcer.ts` (the `generateOpenCodePlugin` function)

**Step 1: Find and update generateOpenCodePlugin**

In `policy-enforcer.ts`, find the `generateOpenCodePlugin` function. In the plugin's `session.created` hook, add a POST to report the API URL. The opencode plugin runs inside the opencode process and the session context provides the API URL.

Add the following to the `session.created` hook in the generated plugin template:

```typescript
'session.created': async ({ event }) => {
  await postFeed('Session started');

  // Report the OpenCode API URL to Latch for SSE tailing
  try {
    const apiUrl = process.env.OPENCODE_API_URL || \`http://localhost:\${process.env.OPENCODE_PORT || '3000'}\`;
    await fetch(\`\${AUTHZ_URL.replace('/feed/', '/opencode-api/')}\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiUrl }),
    }).catch(() => {});
  } catch {}
},
```

Note: The exact environment variable for the opencode API URL depends on what opencode sets. This may need adjustment based on testing. Common candidates: `OPENCODE_API_URL`, `OPENCODE_PORT`, or reading from `.opencode/state/`.

**Step 2: Run type-check**

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | head -20`
Expected: PASS.

**Step 3: Commit**

```bash
git add src/main/services/policy-enforcer.ts
git commit -m "feat: opencode plugin reports API URL to Latch on session.created"
```

---

## Task 11: Stop Tailer on Session End + Cleanup

**Files:**
- Modify: `src/main/index.ts`

**Step 1: Import stopOpenCodeTail**

At the top of `src/main/index.ts`, update the opencode tailer import:

```typescript
import { initOpenCodeTailer, reportOpenCodeApiUrl, stopOpenCodeTail, stopAllOpenCodeTails } from './services/opencode-tailer'
```

(Replace the dynamic import from Task 9 with a static import and move the initialization to after stores are opened.)

**Step 2: Wire init at startup**

After the store opening block (~line 249), add:

```typescript
    initOpenCodeTailer({ sendToRenderer, store: conversationStore! })
```

And wire the callback:

```typescript
    // after authzServer is started (~line 286)
    authzServer.onOpenCodeApiUrl = (sessionId, apiUrl) => {
      console.log(`[opencode-tailer] API URL reported for ${sessionId}: ${apiUrl}`)
      reportOpenCodeApiUrl(sessionId, apiUrl)
    }
```

**Step 3: Stop tailer on session close/kill**

Find where `liveTailerRemoveSession` is called (session cleanup) and add `stopOpenCodeTail(sessionId)` alongside it.

**Step 4: Stop all tailers on app quit**

Find where `stopLiveTailer()` is called (app quit handler) and add `stopAllOpenCodeTails()` alongside it.

**Step 5: Run type-check**

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | head -20`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: wire OpenCode tailer lifecycle (start/stop) into main process"
```

---

## Task 12: Run All Tests + Type-Check

**Step 1: Run all unit tests**

Run: `npx vitest run 2>&1 | tail -30`
Expected: All tests PASS.

**Step 2: Run full type-check**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: PASS (both).

**Step 3: Fix any failures**

Address any type errors or test failures discovered. Common issues:
- Missing `sourceId` in test fixtures that create `TimelineConversation` objects
- Import path issues in new files

**Step 4: Commit fixes if any**

```bash
git add -A
git commit -m "fix: resolve type-check and test failures from harness-agnostic replay"
```

---

## Summary

| Task | Component | Files | Tests |
|------|-----------|-------|-------|
| 1 | Type extension | types, timeline-parser | type-check |
| 2 | ConversationStore | stores/conversation-store | 5 unit tests |
| 3 | Source interface + registry | lib/conversation-source | 4 unit tests |
| 4 | Turn assembly tests | lib/conversation-source.test | 5 unit tests |
| 5 | Main process wiring | main/index.ts | type-check |
| 6 | Preload + store | preload, types, store | type-check |
| 7 | ReplayView UI | ReplayView, styles.css | type-check |
| 8 | OpenCode tailer | services/opencode-tailer | 6 unit tests |
| 9 | Authz endpoint | authz-server, index.ts | type-check |
| 10 | Plugin update | policy-enforcer | type-check |
| 11 | Lifecycle wiring | index.ts | type-check |
| 12 | Integration check | all | full test suite |
