/**
 * @module settings-store
 * @description Encrypted key-value store backed by SQLite.
 *
 * Sensitive values (API keys, tokens) are encrypted at rest using Electron's
 * `safeStorage` API, which delegates to the platform keychain (macOS Keychain,
 * Windows DPAPI, Linux libsecret). Non-sensitive values are stored as plaintext.
 *
 * Schema:
 *   key TEXT PK, value TEXT, encrypted INTEGER, updated_at TEXT
 */

import { safeStorage } from 'electron'
import type Database from 'better-sqlite3'

export class SettingsStore {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  /**
   * Open (or create) the settings table on an existing database handle.
   */
  static open(db: Database.Database): SettingsStore {
    const store = new SettingsStore(db)
    store._init()
    return store
  }

  /** Create table if it doesn't exist. */
  private _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        encrypted  INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `)
  }

  /**
   * Get a setting value. Automatically decrypts if the value was stored encrypted.
   * Returns `null` if the key does not exist.
   */
  get(key: string): string | null {
    const row = this.db.prepare('SELECT value, encrypted FROM settings WHERE key = ?').get(key) as
      | { value: string; encrypted: number }
      | undefined
    if (!row) return null

    if (row.encrypted) {
      try {
        const buf = Buffer.from(row.value, 'hex')
        return safeStorage.decryptString(buf)
      } catch (err: unknown) {
        console.error(`[SettingsStore] Failed to decrypt key "${key}":`, err instanceof Error ? err.message : String(err))
        return null
      }
    }

    return row.value
  }

  /**
   * Store a setting. When `sensitive` is true the value is encrypted via
   * safeStorage before persisting. Falls back to plaintext with a console
   * warning if platform encryption is unavailable.
   */
  set(key: string, value: string, sensitive = false): void {
    let storedValue = value
    let encrypted = 0

    if (sensitive) {
      if (safeStorage.isEncryptionAvailable()) {
        storedValue = safeStorage.encryptString(value).toString('hex')
        encrypted = 1
      } else {
        throw new Error('Platform encryption (safeStorage) is unavailable. Cannot store sensitive value in plaintext.')
      }
    }

    const now = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO settings (key, value, encrypted, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted, updated_at = excluded.updated_at`
    ).run(key, storedValue, encrypted, now)
  }

  /** Delete a setting by key. */
  delete(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  /** Check whether a key exists without decrypting. */
  has(key: string): { exists: boolean; encrypted: boolean } {
    const row = this.db.prepare('SELECT encrypted FROM settings WHERE key = ?').get(key) as
      | { encrypted: number }
      | undefined
    return { exists: !!row, encrypted: !!row && row.encrypted === 1 }
  }
}
