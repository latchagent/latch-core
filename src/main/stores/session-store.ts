/**
 * @module session-store
 * @description SQLite-backed persistence for Latch session records.
 */

import path from 'node:path'
import type Database from 'better-sqlite3'

class SessionStore {
  db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  static openWithDb(db: Database.Database): SessionStore {
    const store = new SessionStore(db)
    store._init()
    return store
  }

  static open(baseDir: string): SessionStore {
    const Db = require('better-sqlite3')
    const db = new Db(path.join(baseDir, 'latch.db'))
    return SessionStore.openWithDb(db)
  }

  _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        status          TEXT NOT NULL,
        repo_root       TEXT,
        worktree_path   TEXT,
        branch_ref      TEXT,
        policy_set      TEXT,
        harness_id      TEXT,
        harness_command TEXT,
        goal            TEXT
      );
    `)

    const migrations = [
      'ALTER TABLE sessions ADD COLUMN harness_id      TEXT',
      'ALTER TABLE sessions ADD COLUMN harness_command TEXT',
      'ALTER TABLE sessions ADD COLUMN goal            TEXT',
      'ALTER TABLE sessions ADD COLUMN policy_override TEXT',
      'ALTER TABLE sessions ADD COLUMN docker_config   TEXT',
      'ALTER TABLE sessions ADD COLUMN project_dir     TEXT',
      'ALTER TABLE sessions ADD COLUMN mcp_server_ids  TEXT'
    ]

    migrations.forEach((sql) => {
      try { this.db.exec(sql) } catch { /* column already exists */ }
    })
  }

  listSessions() {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY created_at DESC')
      .all()
    return { ok: true, sessions: rows }
  }

  createSession(session: any) {
    try {
      this.db.prepare(`
        INSERT INTO sessions
          (id, name, created_at, status, repo_root, worktree_path, branch_ref,
           policy_set, harness_id, harness_command, goal, docker_config, project_dir)
        VALUES
          (@id, @name, @created_at, @status, @repo_root, @worktree_path, @branch_ref,
           @policy_set, @harness_id, @harness_command, @goal, @docker_config, @project_dir)
      `).run({
        harness_id:      null,
        harness_command: null,
        goal:            null,
        docker_config:   null,
        project_dir:     null,
        ...session
      })
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)) || 'Failed to create session.' }
    }
  }

  /** Columns that may be updated via updateSession(). Prevents SQL injection via key names. */
  static readonly ALLOWED_COLUMNS = new Set([
    'name', 'status', 'repo_root', 'worktree_path', 'branch_ref',
    'policy_set', 'harness_id', 'harness_command', 'goal',
    'policy_override', 'docker_config', 'project_dir', 'mcp_server_ids'
  ])

  updateSession(id: string, updates: Record<string, any>) {
    const fields = Object.keys(updates || {}).filter((k) => SessionStore.ALLOWED_COLUMNS.has(k))
    if (!fields.length) return { ok: true }

    const assignments = fields.map((k) => `${k} = @${k}`).join(', ')
    const safeUpdates = Object.fromEntries(fields.map((k) => [k, updates[k]]))
    try {
      this.db.prepare(`
        UPDATE sessions SET ${assignments} WHERE id = @id
      `).run({ id, ...safeUpdates })
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)) || 'Failed to update session.' }
    }
  }

  setOverride(id: string, override: object | null) {
    return this.updateSession(id, {
      policy_override: override ? JSON.stringify(override) : null
    })
  }

  deleteSession(id: string) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)) || 'Failed to delete session.' }
    }
  }
}

export default SessionStore
