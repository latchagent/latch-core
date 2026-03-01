/**
 * @module secret-store
 * @description Encrypted secrets vault backed by SQLite + safeStorage.
 *
 * All secret values are encrypted at rest using Electron's `safeStorage` API
 * (macOS Keychain, Windows DPAPI, Linux libsecret). The `list()` and `get()`
 * methods return metadata only — raw values never cross to the renderer.
 * Resolution methods (`resolve`, `resolveMany`, `allValues`) are main-process
 * only and return decrypted values for injection into child processes.
 *
 * Schema:
 *   id TEXT PK, name TEXT UNIQUE, key TEXT UNIQUE, value TEXT (encrypted hex),
 *   scope TEXT, tags TEXT (JSON), created_at TEXT, updated_at TEXT
 */

import { safeStorage } from 'electron'
import type Database from 'better-sqlite3'
import type { SecretRecord } from '../../types'

export class SecretStore {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  /** Open (or create) the secrets table on an existing database handle. */
  static open(db: Database.Database): SecretStore {
    const store = new SecretStore(db)
    store._init()
    return store
  }

  /** Create table if it doesn't exist. */
  private _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        key        TEXT NOT NULL UNIQUE,
        value      TEXT NOT NULL,
        scope      TEXT NOT NULL DEFAULT 'global',
        tags       TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)

    // Migration: add description column
    try { this.db.exec(`ALTER TABLE secrets ADD COLUMN description TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
  }

  // ── Metadata (safe to expose via IPC) ────────────────────────────────────

  /** List all secrets — metadata only, never raw values. */
  list(scope?: string): { ok: boolean; secrets: SecretRecord[] } {
    const rows = scope
      ? this.db.prepare('SELECT id, name, key, description, scope, tags, created_at, updated_at FROM secrets WHERE scope = ?').all(scope)
      : this.db.prepare('SELECT id, name, key, description, scope, tags, created_at, updated_at FROM secrets').all()
    return { ok: true, secrets: (rows as any[]).map(this._toRecord) }
  }

  /** Get secret metadata by id — no value. */
  get(id: string): { ok: boolean; secret?: SecretRecord; error?: string } {
    const row = this.db.prepare(
      'SELECT id, name, key, description, scope, tags, created_at, updated_at FROM secrets WHERE id = ?'
    ).get(id) as any | undefined
    if (!row) return { ok: false, error: 'Secret not found' }
    return { ok: true, secret: this._toRecord(row) }
  }

  /**
   * Save (upsert) a secret. The value is encrypted before storage.
   * If `value` is an empty string and the secret already exists, only
   * metadata (name, key, scope, tags) is updated — the existing encrypted
   * value is preserved.
   */
  save(params: {
    id: string
    name: string
    key: string
    value: string
    description?: string
    scope?: string
    tags?: string[]
  }): { ok: boolean; error?: string } {
    if (!params.id || !params.name?.trim() || !params.key?.trim()) {
      return { ok: false, error: 'id, name, and key are required' }
    }

    const now = new Date().toISOString()
    const scope = params.scope ?? 'global'
    const tags = JSON.stringify(params.tags ?? [])
    const description = params.description?.trim() ?? ''

    // Metadata-only update when value is empty and secret exists
    if (!params.value) {
      const exists = this.db.prepare('SELECT id FROM secrets WHERE id = ?').get(params.id)
      if (exists) {
        this.db.prepare(
          `UPDATE secrets SET name = ?, key = ?, description = ?, scope = ?, tags = ?, updated_at = ? WHERE id = ?`
        ).run(params.name.trim(), params.key.trim(), description, scope, tags, now, params.id)
        return { ok: true }
      }
      return { ok: false, error: 'Value is required for new secrets' }
    }

    // Encrypt the value — reject if platform encryption is unavailable
    let storedValue = params.value
    if (safeStorage.isEncryptionAvailable()) {
      storedValue = safeStorage.encryptString(params.value).toString('hex')
    } else {
      return { ok: false, error: 'Platform encryption (safeStorage) is unavailable. Cannot store secrets in plaintext.' }
    }

    this.db.prepare(
      `INSERT INTO secrets (id, name, key, description, value, scope, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, key = excluded.key, description = excluded.description,
         value = excluded.value, scope = excluded.scope, tags = excluded.tags,
         updated_at = excluded.updated_at`
    ).run(params.id, params.name.trim(), params.key.trim(), description, storedValue, scope, tags, now, now)

    return { ok: true }
  }

  /** Delete a secret by id. */
  delete(id: string): { ok: boolean } {
    this.db.prepare('DELETE FROM secrets WHERE id = ?').run(id)
    return { ok: true }
  }

  // ── Resolution (main-process only — never expose via IPC) ────────────────

  /** Resolve a secret key to its decrypted value. Returns null if not found. */
  resolve(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM secrets WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    if (!row) return null
    return this._decrypt(row.value)
  }

  /** Resolve multiple keys at once. Returns map of key → decrypted value. */
  resolveMany(keys: string[]): Map<string, string> {
    const result = new Map<string, string>()
    for (const key of keys) {
      const value = this.resolve(key)
      if (value !== null) result.set(key, value)
    }
    return result
  }

  /** Get all decrypted values. Used for terminal redaction patterns. */
  allValues(): string[] {
    const rows = this.db.prepare('SELECT value FROM secrets').all() as { value: string }[]
    const values: string[] = []
    for (const row of rows) {
      const v = this._decrypt(row.value)
      if (v) values.push(v)
    }
    return values
  }

  /** Get all secrets as key → decrypted value map. Used for PTY env injection. */
  allKeyValues(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM secrets').all() as { key: string; value: string }[]
    const result: Record<string, string> = {}
    for (const row of rows) {
      const v = this._decrypt(row.value)
      if (v) result[row.key] = v
    }
    return result
  }

  /** List secret keys and descriptions for agent discovery. No values. */
  listHints(): Array<{ key: string; description: string }> {
    const rows = this.db.prepare('SELECT key, description FROM secrets').all() as { key: string; description: string }[]
    return rows.map(r => ({ key: r.key, description: r.description ?? '' }))
  }

  /** Check if a key exists without decrypting. */
  has(key: string): boolean {
    const row = this.db.prepare('SELECT id FROM secrets WHERE key = ?').get(key)
    return !!row
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /** Decrypt a stored hex value via safeStorage. */
  private _decrypt(hex: string): string | null {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const buf = Buffer.from(hex, 'hex')
        return safeStorage.decryptString(buf)
      }
      // Fallback: if encryption wasn't available at write time, value is plaintext
      return hex
    } catch (err: unknown) {
      console.error('[SecretStore] Decryption failed:', err instanceof Error ? err.message : String(err))
      return null
    }
  }

  /** Convert a raw DB row to a SecretRecord (metadata only). */
  private _toRecord(row: any): SecretRecord {
    let tags: string[] = []
    try { tags = JSON.parse(row.tags ?? '[]') } catch { /* malformed tags JSON — default to empty */ }
    return {
      id: row.id,
      name: row.name,
      key: row.key,
      description: row.description ?? '',
      scope: row.scope ?? 'global',
      tags,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
