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
