/**
 * @module activity-store
 * @description SQLite-backed persistence for tool-call activity events.
 * Follows the same pattern as PolicyStore / SkillsStore.
 */

import type Database from 'better-sqlite3'
import type { ActivityEvent, ActionClass, RiskLevel, AuthzDecision } from '../types'

let idCounter = 0

/** Maximum rows to retain. Pruning runs after every insert. */
const MAX_ROWS = 10_000

export class ActivityStore {
  db: Database.Database
  private insertsSincePrune = 0

  constructor(db: Database.Database) {
    this.db = db
  }

  /** Open the activity store on an existing database handle. */
  static open(db: Database.Database): ActivityStore {
    const store = new ActivityStore(db)
    store._init()
    return store
  }

  _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS activity (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        timestamp   TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        action_class TEXT NOT NULL,
        risk        TEXT NOT NULL,
        decision    TEXT NOT NULL,
        reason      TEXT,
        harness_id  TEXT NOT NULL
      );
    `)

    // Index for efficient session-scoped queries
    try {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_activity_session_ts
          ON activity (session_id, timestamp DESC);
      `)
    } catch {
      // Index already exists
    }
  }

  /** Record a new activity event and return the hydrated record. */
  record(params: {
    sessionId: string
    toolName: string
    actionClass: ActionClass
    risk: RiskLevel
    decision: AuthzDecision
    reason: string | null
    harnessId: string
  }): ActivityEvent {
    const id = `evt-${Date.now()}-${++idCounter}`
    const timestamp = new Date().toISOString()

    this.db.prepare(`
      INSERT INTO activity (id, session_id, timestamp, tool_name, action_class, risk, decision, reason, harness_id)
      VALUES (@id, @session_id, @timestamp, @tool_name, @action_class, @risk, @decision, @reason, @harness_id)
    `).run({
      id,
      session_id: params.sessionId,
      timestamp,
      tool_name: params.toolName,
      action_class: params.actionClass,
      risk: params.risk,
      decision: params.decision,
      reason: params.reason ?? null,
      harness_id: params.harnessId,
    })

    // Prune old rows every 100 inserts to bound table growth
    this.insertsSincePrune++
    if (this.insertsSincePrune >= 100) {
      this.insertsSincePrune = 0
      this._prune()
    }

    return {
      id,
      sessionId: params.sessionId,
      timestamp,
      toolName: params.toolName,
      actionClass: params.actionClass,
      risk: params.risk,
      decision: params.decision,
      reason: params.reason,
      harnessId: params.harnessId,
    }
  }

  /** Delete oldest rows beyond MAX_ROWS. */
  private _prune(): void {
    try {
      this.db.prepare(`
        DELETE FROM activity WHERE rowid NOT IN (
          SELECT rowid FROM activity ORDER BY timestamp DESC LIMIT ?
        )
      `).run(MAX_ROWS)
    } catch {
      // Non-fatal — pruning is best-effort
    }
  }

  /** List events, newest first. Optionally scoped to a session. */
  list(opts?: { sessionId?: string; limit?: number; offset?: number }): { events: ActivityEvent[]; total: number } {
    const sessionId = opts?.sessionId
    const limit  = opts?.limit  ?? 200
    const offset = opts?.offset ?? 0

    const whereClause = sessionId ? 'WHERE session_id = ?' : ''
    const params: any[] = sessionId ? [sessionId] : []

    const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM activity ${whereClause}`).get(...params) as any
    const total = countRow?.cnt ?? 0

    const rows = this.db.prepare(
      `SELECT * FROM activity ${whereClause} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[]

    return {
      total,
      events: rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        timestamp: row.timestamp,
        toolName: row.tool_name,
        actionClass: row.action_class as ActionClass,
        risk: row.risk as RiskLevel,
        decision: row.decision as AuthzDecision,
        reason: row.reason ?? null,
        harnessId: row.harness_id,
      })),
    }
  }

  /** Get events within a recent time range (for radar baseline). */
  getRecent(sinceMs: number): ActivityEvent[] {
    const since = new Date(Date.now() - sinceMs).toISOString()
    const rows = this.db.prepare(
      `SELECT * FROM activity WHERE timestamp >= ? ORDER BY timestamp ASC`
    ).all(since) as any[]

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      timestamp: row.timestamp,
      toolName: row.tool_name,
      actionClass: row.action_class as ActionClass,
      risk: row.risk as RiskLevel,
      decision: row.decision as AuthzDecision,
      reason: row.reason ?? null,
      harnessId: row.harness_id,
    }))
  }

  /** Export all events as an array (for CSV/JSON export). */
  exportAll(sessionId?: string): ActivityEvent[] {
    const whereClause = sessionId ? 'WHERE session_id = ?' : ''
    const params: unknown[] = sessionId ? [sessionId] : []

    const rows = this.db.prepare(
      `SELECT * FROM activity ${whereClause} ORDER BY timestamp ASC`
    ).all(...params) as any[]

    return rows.map((row: any) => ({
      id: row.id,
      sessionId: row.session_id,
      timestamp: row.timestamp,
      toolName: row.tool_name,
      actionClass: row.action_class as ActionClass,
      risk: row.risk as RiskLevel,
      decision: row.decision as AuthzDecision,
      reason: row.reason ?? null,
      harnessId: row.harness_id,
    }))
  }

  /** Delete events. If sessionId is provided, deletes only that session's events. */
  clear(sessionId?: string): void {
    if (sessionId) {
      this.db.prepare('DELETE FROM activity WHERE session_id = ?').run(sessionId)
    } else {
      this.db.exec('DELETE FROM activity')
    }
  }
}
