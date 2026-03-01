/**
 * @module service-store
 * @description CRUD for service definitions and session grants.
 *
 * Service definitions (ServiceDefinition) are stored as JSON blobs.
 * Credential values are stored separately via SecretStore (never in this table).
 * Session grants track which services are available to which sessions.
 */

import type Database from 'better-sqlite3'
import type { ServiceDefinition, ServiceRecord } from '../../types'

export class ServiceStore {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  static open(db: Database.Database): ServiceStore {
    const store = new ServiceStore(db)
    store._init()
    return store
  }

  private _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS services (
        id            TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL,
        name          TEXT NOT NULL,
        category      TEXT NOT NULL,
        protocol      TEXT NOT NULL DEFAULT 'http',
        body          TEXT NOT NULL,
        has_credential INTEGER NOT NULL DEFAULT 0,
        expires_at    TEXT,
        last_used     TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS service_grants (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id  TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        granted_at  TEXT NOT NULL,
        UNIQUE(service_id, session_id)
      )
    `)
  }

  /** Save or update a service definition. */
  save(definition: ServiceDefinition): { ok: boolean; error?: string } {
    if (!definition.id || !definition.name) {
      return { ok: false, error: 'Service must have an id and name.' }
    }
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO services (id, definition_id, name, category, protocol, body, created_at, updated_at)
      VALUES (@id, @definitionId, @name, @category, @protocol, @body, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        definition_id = @definitionId, name = @name, category = @category,
        protocol = @protocol, body = @body, updated_at = @now
    `).run({
      id: definition.id,
      definitionId: definition.id,
      name: definition.name,
      category: definition.category,
      protocol: definition.protocol,
      body: JSON.stringify(definition),
      now,
    })
    return { ok: true }
  }

  /** List all registered services. */
  list(): { ok: boolean; services: ServiceRecord[] } {
    const rows = this.db.prepare('SELECT * FROM services ORDER BY name ASC').all() as any[]
    return { ok: true, services: rows.map(r => this._toRecord(r)) }
  }

  /** Get a single service by id. */
  get(id: string): { ok: boolean; service?: ServiceRecord; error?: string } {
    const row = this.db.prepare('SELECT * FROM services WHERE id = ?').get(id) as any
    if (!row) return { ok: false, error: `Service '${id}' not found.` }
    return { ok: true, service: this._toRecord(row) }
  }

  /** Delete a service and its grants. */
  delete(id: string): { ok: boolean } {
    this.db.prepare('DELETE FROM service_grants WHERE service_id = ?').run(id)
    this.db.prepare('DELETE FROM services WHERE id = ?').run(id)
    return { ok: true }
  }

  /** Mark that a credential has been stored for this service. */
  markCredentialStored(id: string): void {
    this.db.prepare('UPDATE services SET has_credential = 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id)
  }

  /** Update last-used timestamp. */
  touchLastUsed(id: string): void {
    this.db.prepare('UPDATE services SET last_used = ?, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), new Date().toISOString(), id)
  }

  /** Grant a service to a session. */
  grantToSession(serviceId: string, sessionId: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO service_grants (service_id, session_id, granted_at)
      VALUES (?, ?, ?)
    `).run(serviceId, sessionId, new Date().toISOString())
  }

  /** Revoke a service from a session. */
  revokeFromSession(serviceId: string, sessionId: string): void {
    this.db.prepare('DELETE FROM service_grants WHERE service_id = ? AND session_id = ?')
      .run(serviceId, sessionId)
  }

  /** List services granted to a specific session. */
  listForSession(sessionId: string): ServiceRecord[] {
    const rows = this.db.prepare(`
      SELECT s.* FROM services s
      JOIN service_grants g ON s.id = g.service_id
      WHERE g.session_id = ?
      ORDER BY s.name ASC
    `).all(sessionId) as any[]
    return rows.map(r => this._toRecord(r))
  }

  private _toRecord(row: any): ServiceRecord {
    let definition: ServiceDefinition
    try {
      definition = JSON.parse(row.body)
    } catch {
      definition = { id: row.id, name: row.name } as any
    }
    return {
      id: row.id,
      definitionId: row.definition_id,
      name: row.name,
      category: row.category,
      protocol: row.protocol,
      definition,
      hasCredential: !!row.has_credential,
      expiresAt: row.expires_at,
      lastUsed: row.last_used,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
