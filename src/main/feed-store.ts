/**
 * @module feed-store
 * @description SQLite-backed persistence for agent status-update feed items.
 * Follows the same pattern as ActivityStore.
 */

import type Database from 'better-sqlite3'
import type { FeedItem } from '../types'

let idCounter = 0

/** Maximum rows to retain. Pruning runs after every 50 inserts. */
const MAX_ROWS = 5_000

export class FeedStore {
  db: Database.Database
  private insertsSincePrune = 0

  constructor(db: Database.Database) {
    this.db = db
  }

  /** Open the feed store on an existing database handle. */
  static open(db: Database.Database): FeedStore {
    const store = new FeedStore(db)
    store._init()
    return store
  }

  _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feed (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        timestamp   TEXT NOT NULL,
        message     TEXT NOT NULL,
        harness_id  TEXT NOT NULL
      );
    `)

    try {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_feed_session_ts
          ON feed (session_id, timestamp DESC);
      `)
    } catch {
      // Index already exists
    }
  }

  /** Record a new feed item and return the hydrated record. */
  record(params: {
    sessionId: string
    message: string
    harnessId: string
  }): FeedItem {
    const id = `feed-${Date.now()}-${++idCounter}`
    const timestamp = new Date().toISOString()

    this.db.prepare(`
      INSERT INTO feed (id, session_id, timestamp, message, harness_id)
      VALUES (@id, @session_id, @timestamp, @message, @harness_id)
    `).run({
      id,
      session_id: params.sessionId,
      timestamp,
      message: params.message,
      harness_id: params.harnessId,
    })

    this.insertsSincePrune++
    if (this.insertsSincePrune >= 50) {
      this.insertsSincePrune = 0
      this._prune()
    }

    return {
      id,
      sessionId: params.sessionId,
      timestamp,
      message: params.message,
      harnessId: params.harnessId,
    }
  }

  /** Delete oldest rows beyond MAX_ROWS. */
  private _prune(): void {
    try {
      this.db.prepare(`
        DELETE FROM feed WHERE rowid NOT IN (
          SELECT rowid FROM feed ORDER BY timestamp DESC LIMIT ?
        )
      `).run(MAX_ROWS)
    } catch {
      // Non-fatal — pruning is best-effort
    }
  }

  /** List feed items, newest first. Optionally scoped to a session. */
  list(opts?: { sessionId?: string; limit?: number }): { items: FeedItem[]; total: number } {
    const sessionId = opts?.sessionId
    const limit = opts?.limit ?? 200

    const whereClause = sessionId ? 'WHERE session_id = ?' : ''
    const params: any[] = sessionId ? [sessionId] : []

    const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM feed ${whereClause}`).get(...params) as any
    const total = countRow?.cnt ?? 0

    const rows = this.db.prepare(
      `SELECT * FROM feed ${whereClause} ORDER BY timestamp DESC LIMIT ?`
    ).all(...params, limit) as any[]

    return {
      total,
      items: rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        timestamp: row.timestamp,
        message: row.message,
        harnessId: row.harness_id,
      })),
    }
  }

  /** Delete feed items. If sessionId is provided, deletes only that session's items. */
  clear(sessionId?: string): void {
    if (sessionId) {
      this.db.prepare('DELETE FROM feed WHERE session_id = ?').run(sessionId)
    } else {
      this.db.exec('DELETE FROM feed')
    }
  }
}
