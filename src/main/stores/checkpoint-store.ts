// src/main/stores/checkpoint-store.ts

/**
 * @module checkpoint-store
 * @description SQLite-backed store for agent rewind checkpoints.
 * Each checkpoint maps to a git commit created automatically after
 * agent file writes.
 */

import type Database from 'better-sqlite3'
import type { Checkpoint } from '../../types'

let idCounter = 0

export class CheckpointStore {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  static open(db: Database.Database): CheckpointStore {
    const store = new CheckpointStore(db)
    store._init()
    return store
  }

  private _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        number      INTEGER NOT NULL,
        commit_hash TEXT NOT NULL,
        turn_start  INTEGER NOT NULL,
        turn_end    INTEGER NOT NULL,
        summary     TEXT NOT NULL,
        files       TEXT NOT NULL,
        cost_usd    REAL NOT NULL DEFAULT 0,
        timestamp   TEXT NOT NULL
      )
    `)

    try {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_checkpoints_session
          ON checkpoints (session_id, number DESC)
      `)
    } catch { /* already exists */ }
  }

  record(params: {
    sessionId: string
    number: number
    commitHash: string
    turnStart: number
    turnEnd: number
    summary: string
    filesChanged: string[]
    costUsd: number
  }): Checkpoint {
    const id = `ckpt-${Date.now()}-${++idCounter}`
    const timestamp = new Date().toISOString()

    this.db.prepare(`
      INSERT INTO checkpoints (id, session_id, number, commit_hash, turn_start, turn_end, summary, files, cost_usd, timestamp)
      VALUES (@id, @session_id, @number, @commit_hash, @turn_start, @turn_end, @summary, @files, @cost_usd, @timestamp)
    `).run({
      id,
      session_id: params.sessionId,
      number: params.number,
      commit_hash: params.commitHash,
      turn_start: params.turnStart,
      turn_end: params.turnEnd,
      summary: params.summary,
      files: JSON.stringify(params.filesChanged),
      cost_usd: params.costUsd,
      timestamp,
    })

    return {
      id,
      sessionId: params.sessionId,
      number: params.number,
      commitHash: params.commitHash,
      turnStart: params.turnStart,
      turnEnd: params.turnEnd,
      summary: params.summary,
      filesChanged: params.filesChanged,
      costUsd: params.costUsd,
      timestamp,
    }
  }

  list(sessionId: string): Checkpoint[] {
    const rows = this.db.prepare(
      'SELECT * FROM checkpoints WHERE session_id = ? ORDER BY number DESC'
    ).all(sessionId) as any[]

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      number: row.number,
      commitHash: row.commit_hash,
      turnStart: row.turn_start,
      turnEnd: row.turn_end,
      summary: row.summary,
      filesChanged: JSON.parse(row.files),
      costUsd: row.cost_usd,
      timestamp: row.timestamp,
    }))
  }

  search(query: string, sessionId?: string): Checkpoint[] {
    const pattern = `%${query}%`
    const sql = sessionId
      ? 'SELECT * FROM checkpoints WHERE session_id = ? AND (summary LIKE ? OR files LIKE ?) ORDER BY number DESC'
      : 'SELECT * FROM checkpoints WHERE summary LIKE ? OR files LIKE ? ORDER BY number DESC'
    const params = sessionId ? [sessionId, pattern, pattern] : [pattern, pattern]

    const rows = this.db.prepare(sql).all(...params) as any[]

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      number: row.number,
      commitHash: row.commit_hash,
      turnStart: row.turn_start,
      turnEnd: row.turn_end,
      summary: row.summary,
      filesChanged: JSON.parse(row.files),
      costUsd: row.cost_usd,
      timestamp: row.timestamp,
    }))
  }

  /** Delete all checkpoints after a given number for a session (used during rewind). */
  invalidateAfter(sessionId: string, afterNumber: number): void {
    this.db.prepare(
      'DELETE FROM checkpoints WHERE session_id = ? AND number > ?'
    ).run(sessionId, afterNumber)
  }

  /** Get the latest checkpoint number for a session. */
  latestNumber(sessionId: string): number {
    const row = this.db.prepare(
      'SELECT MAX(number) as max_num FROM checkpoints WHERE session_id = ?'
    ).get(sessionId) as any
    return row?.max_num ?? 0
  }

  /** Get a single checkpoint by ID. */
  get(id: string): Checkpoint | null {
    const row = this.db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id) as any
    if (!row) return null
    return {
      id: row.id,
      sessionId: row.session_id,
      number: row.number,
      commitHash: row.commit_hash,
      turnStart: row.turn_start,
      turnEnd: row.turn_end,
      summary: row.summary,
      filesChanged: JSON.parse(row.files),
      costUsd: row.cost_usd,
      timestamp: row.timestamp,
    }
  }

  clear(sessionId?: string): void {
    if (sessionId) {
      this.db.prepare('DELETE FROM checkpoints WHERE session_id = ?').run(sessionId)
    } else {
      this.db.exec('DELETE FROM checkpoints')
    }
  }
}
