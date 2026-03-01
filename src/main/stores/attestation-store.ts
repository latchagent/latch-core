/**
 * @module attestation-store
 * @description Stores proxy audit events and session receipts.
 *
 * Audit events are hash-chained for tamper evidence. Session receipts
 * are signed JSON documents proving what policy was enforced.
 */

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { ProxyAuditEvent, SessionReceipt } from '../../types'

export class AttestationStore {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  static open(db: Database.Database): AttestationStore {
    const store = new AttestationStore(db)
    store._init()
    return store
  }

  private _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proxy_audit_log (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        event_json  TEXT NOT NULL,
        prev_hash   TEXT,
        hash        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_receipts (
        session_id  TEXT PRIMARY KEY,
        receipt_json TEXT NOT NULL,
        created_at  TEXT NOT NULL
      )
    `)
  }

  recordEvent(event: ProxyAuditEvent): void {
    const prevRow = this.db.prepare(
      'SELECT hash FROM proxy_audit_log WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(event.sessionId) as { hash: string } | undefined
    const prevHash = prevRow?.hash ?? ''

    const eventJson = JSON.stringify(event)
    const hash = createHash('sha256').update(prevHash + eventJson).digest('hex')

    this.db.prepare(`
      INSERT INTO proxy_audit_log (id, session_id, event_json, prev_hash, hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(event.id, event.sessionId, eventJson, prevHash || null, hash, event.timestamp)
  }

  listEvents(sessionId: string, limit?: number): ProxyAuditEvent[] {
    const sql = limit
      ? 'SELECT event_json FROM proxy_audit_log WHERE session_id = ? ORDER BY created_at ASC LIMIT ?'
      : 'SELECT event_json FROM proxy_audit_log WHERE session_id = ? ORDER BY created_at ASC'
    const rows = limit
      ? this.db.prepare(sql).all(sessionId, limit) as any[]
      : this.db.prepare(sql).all(sessionId) as any[]
    return rows.map(r => JSON.parse(r.event_json))
  }

  getHashChain(sessionId: string): string | null {
    const row = this.db.prepare(
      'SELECT hash FROM proxy_audit_log WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(sessionId) as { hash: string } | undefined
    return row?.hash ?? null
  }

  getEventCount(sessionId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM proxy_audit_log WHERE session_id = ?'
    ).get(sessionId) as { count: number }
    return row.count
  }

  saveReceipt(receipt: SessionReceipt): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO session_receipts (session_id, receipt_json, created_at)
      VALUES (?, ?, ?)
    `).run(receipt.sessionId, JSON.stringify(receipt), new Date().toISOString())
  }

  getReceipt(sessionId: string): SessionReceipt | null {
    const row = this.db.prepare(
      'SELECT receipt_json FROM session_receipts WHERE session_id = ?'
    ).get(sessionId) as { receipt_json: string } | undefined
    if (!row) return null
    return JSON.parse(row.receipt_json)
  }
}
