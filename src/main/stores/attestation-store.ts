/**
 * @module attestation-store
 * @description Stores proxy audit events and session receipts.
 *
 * Audit events are hash-chained for tamper evidence. Session receipts
 * are signed JSON documents proving what policy was enforced.
 */

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { ProxyAuditEvent, SessionReceipt, MerkleProof } from '../../types'
import { computeLeafHash, buildMerkleRoot, buildInclusionProof } from '../lib/merkle'
import { canonicalJsonStringify } from '../lib/canonical-json'

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
    try {
      this.db.exec('ALTER TABLE proxy_audit_log ADD COLUMN leaf_index INTEGER')
    } catch {
      // Column already exists
    }
  }

  recordEvent(event: ProxyAuditEvent): void {
    const prevRow = this.db.prepare(
      'SELECT hash FROM proxy_audit_log WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(event.sessionId) as { hash: string } | undefined
    const prevHash = prevRow?.hash ?? ''

    const eventJson = canonicalJsonStringify(event)
    const hash = createHash('sha256').update(prevHash + eventJson).digest('hex')

    // Compute leaf_index as next sequential index for this session
    const countRow = this.db.prepare(
      'SELECT COUNT(*) as count FROM proxy_audit_log WHERE session_id = ?'
    ).get(event.sessionId) as { count: number }
    const leafIndex = countRow.count

    this.db.prepare(`
      INSERT INTO proxy_audit_log (id, session_id, event_json, prev_hash, hash, leaf_index, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(event.id, event.sessionId, eventJson, prevHash || null, hash, leafIndex, event.timestamp)
  }

  listEvents(sessionId: string, limit?: number): ProxyAuditEvent[] {
    const sql = limit
      ? 'SELECT event_json FROM proxy_audit_log WHERE session_id = ? ORDER BY created_at ASC LIMIT ?'
      : 'SELECT event_json FROM proxy_audit_log WHERE session_id = ? ORDER BY created_at ASC'
    const rows = limit
      ? this.db.prepare(sql).all(sessionId, limit) as { event_json: string }[]
      : this.db.prepare(sql).all(sessionId) as { event_json: string }[]
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

  /** Get ordered leaf hashes for Merkle tree computation. */
  getLeafHashes(sessionId: string): string[] {
    const rows = this.db.prepare(
      'SELECT event_json FROM proxy_audit_log WHERE session_id = ? ORDER BY leaf_index ASC'
    ).all(sessionId) as { event_json: string }[]
    return rows.map(r => computeLeafHash(r.event_json))
  }

  /** Compute the Merkle root over all audit events for a session. */
  getMerkleRoot(sessionId: string): string | null {
    const leaves = this.getLeafHashes(sessionId)
    return buildMerkleRoot(leaves)
  }

  /** Build an inclusion proof for a specific event. */
  getInclusionProof(sessionId: string, eventId: string): MerkleProof | null {
    const indexRow = this.db.prepare(
      'SELECT leaf_index FROM proxy_audit_log WHERE session_id = ? AND id = ?'
    ).get(sessionId, eventId) as { leaf_index: number } | undefined
    if (!indexRow) return null

    const leaves = this.getLeafHashes(sessionId)
    return buildInclusionProof(leaves, indexRow.leaf_index)
  }

  saveReceipt(receipt: SessionReceipt): void {
    this.db.prepare(`
      INSERT INTO session_receipts (session_id, receipt_json, created_at)
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
