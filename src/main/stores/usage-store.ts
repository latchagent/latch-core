/**
 * @module usage-store
 * @description SQLite-backed persistence for token usage events.
 * Follows the ActivityStore pattern with auto-pruning and daily rollups.
 */

import type Database from 'better-sqlite3'
import type { UsageEvent, UsageDaySummary, UsageSessionSummary, UsageModelSummary, UsageSummary } from '../../types'

const MAX_ROWS = 50_000
const PRUNE_EVERY = 500

let idCounter = 0

export class UsageStore {
  db: Database.Database
  private insertsSincePrune = 0

  constructor(db: Database.Database) {
    this.db = db
  }

  static open(db: Database.Database): UsageStore {
    const store = new UsageStore(db)
    store._init()
    return store
  }

  _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id                TEXT PRIMARY KEY,
        session_id        TEXT,
        harness_id        TEXT NOT NULL,
        model             TEXT NOT NULL,
        timestamp         TEXT NOT NULL,
        input_tokens      INTEGER NOT NULL DEFAULT 0,
        output_tokens     INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd          REAL NOT NULL DEFAULT 0.0,
        tool_name         TEXT,
        source_file       TEXT,
        request_id        TEXT
      );
    `)

    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_session_ts ON usage_events (session_id, timestamp DESC);`)
    } catch { /* index exists */ }
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events (timestamp DESC);`)
    } catch { /* index exists */ }
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_source_req ON usage_events (source_file, request_id);`)
    } catch { /* index exists */ }

    // Daily rollup table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_daily (
        date              TEXT NOT NULL,
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
    `)
  }

  /**
   * Check if a (source_file, request_id) pair already exists — for dedup.
   */
  isDuplicate(sourceFile: string, requestId: string): boolean {
    if (!requestId) return false
    const row = this.db.prepare(
      `SELECT 1 FROM usage_events WHERE source_file = ? AND request_id = ? LIMIT 1`
    ).get(sourceFile, requestId)
    return !!row
  }

  /**
   * Record a single usage event. Returns the hydrated UsageEvent.
   */
  record(params: {
    sessionId: string | null
    harnessId: string
    model: string
    timestamp: string
    inputTokens: number
    outputTokens: number
    cacheWriteTokens: number
    cacheReadTokens: number
    costUsd: number
    toolName: string | null
    sourceFile: string
    requestId: string | null
  }): UsageEvent {
    const id = `usg-${Date.now()}-${++idCounter}`

    this.db.prepare(`
      INSERT INTO usage_events
        (id, session_id, harness_id, model, timestamp, input_tokens, output_tokens,
         cache_write_tokens, cache_read_tokens, cost_usd, tool_name, source_file, request_id)
      VALUES (@id, @session_id, @harness_id, @model, @timestamp, @input_tokens, @output_tokens,
              @cache_write_tokens, @cache_read_tokens, @cost_usd, @tool_name, @source_file, @request_id)
    `).run({
      id,
      session_id: params.sessionId,
      harness_id: params.harnessId,
      model: params.model,
      timestamp: params.timestamp,
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
      cache_write_tokens: params.cacheWriteTokens,
      cache_read_tokens: params.cacheReadTokens,
      cost_usd: params.costUsd,
      tool_name: params.toolName,
      source_file: params.sourceFile,
      request_id: params.requestId,
    })

    // Update daily rollup
    const date = params.timestamp.slice(0, 10) // YYYY-MM-DD
    this.db.prepare(`
      INSERT INTO usage_daily (date, harness_id, model, total_input, total_output, total_cache_write, total_cache_read, total_cost_usd, event_count)
      VALUES (@date, @harness_id, @model, @input, @output, @cw, @cr, @cost, 1)
      ON CONFLICT (date, harness_id, model) DO UPDATE SET
        total_input = total_input + @input,
        total_output = total_output + @output,
        total_cache_write = total_cache_write + @cw,
        total_cache_read = total_cache_read + @cr,
        total_cost_usd = total_cost_usd + @cost,
        event_count = event_count + 1
    `).run({
      date,
      harness_id: params.harnessId,
      model: params.model,
      input: params.inputTokens,
      output: params.outputTokens,
      cw: params.cacheWriteTokens,
      cr: params.cacheReadTokens,
      cost: params.costUsd,
    })

    // Auto-prune
    if (++this.insertsSincePrune >= PRUNE_EVERY) {
      this.insertsSincePrune = 0
      this._prune()
    }

    return {
      id,
      sessionId: params.sessionId,
      harnessId: params.harnessId,
      model: params.model,
      timestamp: params.timestamp,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cacheWriteTokens: params.cacheWriteTokens,
      cacheReadTokens: params.cacheReadTokens,
      costUsd: params.costUsd,
      toolName: params.toolName,
      sourceFile: params.sourceFile,
      requestId: params.requestId,
    }
  }

  private _prune(): void {
    const count = (this.db.prepare('SELECT COUNT(*) as cnt FROM usage_events').get() as any)?.cnt ?? 0
    if (count > MAX_ROWS) {
      this.db.prepare(`
        DELETE FROM usage_events WHERE id IN (
          SELECT id FROM usage_events ORDER BY timestamp ASC LIMIT ?
        )
      `).run(count - MAX_ROWS)
    }
  }

  /**
   * Paginated list of usage events.
   */
  list(opts?: { sessionId?: string; limit?: number; offset?: number }): { events: UsageEvent[]; total: number } {
    const sessionId = opts?.sessionId
    const limit = opts?.limit ?? 200
    const offset = opts?.offset ?? 0

    const where = sessionId ? 'WHERE session_id = ?' : ''
    const params: any[] = sessionId ? [sessionId] : []

    const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM usage_events ${where}`).get(...params) as any
    const total = countRow?.cnt ?? 0

    const rows = this.db.prepare(
      `SELECT * FROM usage_events ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[]

    return {
      total,
      events: rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        harnessId: r.harness_id,
        model: r.model,
        timestamp: r.timestamp,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheWriteTokens: r.cache_write_tokens,
        cacheReadTokens: r.cache_read_tokens,
        costUsd: r.cost_usd,
        toolName: r.tool_name,
        sourceFile: r.source_file,
        requestId: r.request_id,
      })),
    }
  }

  /**
   * Build summary for the dashboard.
   */
  getSummary(opts?: { days?: number; sessionId?: string }): UsageSummary {
    const days = opts?.days ?? 30
    const today = new Date().toISOString().slice(0, 10)
    const sinceDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

    // Today's totals
    const todayRow = this.db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as cost,
             COALESCE(SUM(input_tokens), 0) as input,
             COALESCE(SUM(output_tokens), 0) as output,
             COALESCE(SUM(cache_read_tokens), 0) as cache_read,
             COALESCE(SUM(cache_write_tokens), 0) as cache_write
      FROM usage_events WHERE timestamp >= ?
    `).get(today + 'T00:00:00.000Z') as any

    const totalTokens = (todayRow?.input ?? 0) + (todayRow?.cache_write ?? 0) + (todayRow?.cache_read ?? 0)
    const cacheEfficiency = totalTokens > 0 ? (todayRow?.cache_read ?? 0) / totalTokens : 0

    // Daily summaries from rollup table
    const dailyRows = this.db.prepare(`
      SELECT * FROM usage_daily WHERE date >= ? ORDER BY date DESC
    `).all(sinceDate) as any[]

    const dailySummaries: UsageDaySummary[] = dailyRows.map((r) => ({
      date: r.date,
      harnessId: r.harness_id,
      model: r.model,
      totalInput: r.total_input,
      totalOutput: r.total_output,
      totalCacheWrite: r.total_cache_write,
      totalCacheRead: r.total_cache_read,
      totalCostUsd: r.total_cost_usd,
      eventCount: r.event_count,
    }))

    // Session summaries
    const sessionFilter = opts?.sessionId ? 'AND session_id = ?' : ''
    const sessionParams: any[] = opts?.sessionId ? [sinceDate + 'T00:00:00.000Z', opts.sessionId] : [sinceDate + 'T00:00:00.000Z']

    const sessionRows = this.db.prepare(`
      SELECT session_id,
             harness_id,
             COALESCE(SUM(input_tokens), 0) as total_input,
             COALESCE(SUM(output_tokens), 0) as total_output,
             COALESCE(SUM(cache_write_tokens), 0) as total_cache_write,
             COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
             COALESCE(SUM(cost_usd), 0) as total_cost,
             COUNT(*) as event_count,
             GROUP_CONCAT(DISTINCT model) as models,
             MIN(timestamp) as first_event,
             MAX(timestamp) as last_event
      FROM usage_events
      WHERE timestamp >= ? ${sessionFilter}
      GROUP BY session_id, harness_id
      ORDER BY total_cost DESC
    `).all(...sessionParams) as any[]

    const sessionSummaries: UsageSessionSummary[] = sessionRows.map((r) => ({
      sessionId: r.session_id,
      sessionName: null,
      harnessId: r.harness_id,
      totalInput: r.total_input,
      totalOutput: r.total_output,
      totalCacheWrite: r.total_cache_write,
      totalCacheRead: r.total_cache_read,
      totalCostUsd: r.total_cost,
      eventCount: r.event_count,
      models: r.models ? r.models.split(',') : [],
      firstEvent: r.first_event,
      lastEvent: r.last_event,
    }))

    // Model summaries
    const modelRows = this.db.prepare(`
      SELECT model,
             COALESCE(SUM(total_cost_usd), 0) as total_cost,
             COALESCE(SUM(event_count), 0) as event_count
      FROM usage_daily WHERE date >= ?
      GROUP BY model ORDER BY total_cost DESC
    `).all(sinceDate) as any[]

    const modelSummaries: UsageModelSummary[] = modelRows.map((r) => ({
      model: r.model,
      totalCostUsd: r.total_cost,
      eventCount: r.event_count,
    }))

    return {
      todayCostUsd: todayRow?.cost ?? 0,
      todayInputTokens: todayRow?.input ?? 0,
      todayOutputTokens: todayRow?.output ?? 0,
      cacheEfficiency,
      dailySummaries,
      sessionSummaries,
      modelSummaries,
    }
  }

  /**
   * Export all events, optionally filtered by session.
   */
  exportAll(sessionId?: string): UsageEvent[] {
    const where = sessionId ? 'WHERE session_id = ?' : ''
    const params: any[] = sessionId ? [sessionId] : []
    const rows = this.db.prepare(`SELECT * FROM usage_events ${where} ORDER BY timestamp DESC`).all(...params) as any[]
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      harnessId: r.harness_id,
      model: r.model,
      timestamp: r.timestamp,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      cacheReadTokens: r.cache_read_tokens,
      costUsd: r.cost_usd,
      toolName: r.tool_name,
      sourceFile: r.source_file,
      requestId: r.request_id,
    }))
  }

  /**
   * Clear usage data — optionally scoped to a session.
   */
  clear(sessionId?: string): void {
    if (sessionId) {
      this.db.prepare('DELETE FROM usage_events WHERE session_id = ?').run(sessionId)
    } else {
      this.db.exec('DELETE FROM usage_events')
      this.db.exec('DELETE FROM usage_daily')
    }
  }
}
