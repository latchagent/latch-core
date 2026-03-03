/**
 * @module issue-store
 * @description SQLite-backed persistence for GitHub/Linear/Latch issue tracking.
 * Links issues to Latch sessions for bidirectional sync.
 * Also serves as the native Latch task tracker.
 */

import type Database from 'better-sqlite3'
import type { Issue } from '../../types'

export class IssueStore {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  /** Open the issue store on an existing database handle. */
  static open(db: Database.Database): IssueStore {
    const store = new IssueStore(db)
    store._init()
    return store
  }

  private _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        id           TEXT PRIMARY KEY,
        provider     TEXT NOT NULL,
        ref          TEXT NOT NULL,
        title        TEXT NOT NULL,
        body         TEXT,
        status       TEXT NOT NULL DEFAULT 'open',
        labels       TEXT DEFAULT '[]',
        assignee     TEXT,
        url          TEXT,
        repo         TEXT,
        priority     TEXT,
        project_dir  TEXT,
        branch_name  TEXT,
        session_id   TEXT,
        synced_at    TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      )
    `)

    try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_session ON issues (session_id)`) } catch { /* exists */ }
    try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_provider ON issues (provider, repo)`) } catch { /* exists */ }
  }

  /** Generate next LATCH-N ref. */
  nextLatchRef(): string {
    const row = this.db.prepare(
      `SELECT MAX(CAST(REPLACE(ref, 'LATCH-', '') AS INTEGER)) as maxNum FROM issues WHERE provider = 'latch'`
    ).get() as any
    const next = (row?.maxNum || 0) + 1
    return `LATCH-${next}`
  }

  /** Create a native Latch task. */
  create(params: { title: string; body?: string; projectDir?: string; branchName?: string; labels?: string[] }): Issue {
    const ref = this.nextLatchRef()
    const id = `latch:${ref}`
    const now = new Date().toISOString()
    const issue: Issue = {
      id,
      provider: 'latch',
      ref,
      title: params.title,
      body: params.body || '',
      status: 'open',
      labels: params.labels || [],
      assignee: null,
      url: '',
      repo: params.projectDir || '',
      projectDir: params.projectDir || undefined,
      branchName: params.branchName || undefined,
      createdAt: now,
      updatedAt: now,
    }
    this.save(issue)
    return issue
  }

  /** Save or update an issue from any provider. */
  save(issue: Issue): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO issues (id, provider, ref, title, body, status, labels, assignee, url, repo, priority, project_dir, branch_name, session_id, synced_at, created_at, updated_at)
      VALUES (@id, @provider, @ref, @title, @body, @status, @labels, @assignee, @url, @repo, @priority, @projectDir, @branchName, @sessionId, @syncedAt, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        title = @title, body = @body, status = @status, labels = @labels,
        assignee = @assignee, priority = @priority, project_dir = @projectDir,
        branch_name = @branchName, synced_at = @syncedAt, updated_at = @now
    `).run({
      id: issue.id,
      provider: issue.provider,
      ref: issue.ref,
      title: issue.title,
      body: issue.body || '',
      status: issue.status,
      labels: JSON.stringify(issue.labels),
      assignee: issue.assignee,
      url: issue.url || '',
      repo: issue.repo,
      priority: issue.priority || null,
      projectDir: issue.projectDir || null,
      branchName: issue.branchName || null,
      sessionId: issue.sessionId || null,
      syncedAt: issue.syncedAt || now,
      now,
    })
  }

  /** Update specific fields on a native Latch task. */
  update(id: string, fields: Partial<Pick<Issue, 'title' | 'body' | 'status' | 'projectDir' | 'branchName'>>): void {
    const sets: string[] = []
    const params: any = { id }
    if (fields.title !== undefined)      { sets.push('title = @title'); params.title = fields.title }
    if (fields.body !== undefined)       { sets.push('body = @body'); params.body = fields.body }
    if (fields.status !== undefined)     { sets.push('status = @status'); params.status = fields.status }
    if (fields.projectDir !== undefined) { sets.push('project_dir = @projectDir'); params.projectDir = fields.projectDir }
    if (fields.branchName !== undefined) { sets.push('branch_name = @branchName'); params.branchName = fields.branchName }
    if (sets.length === 0) return
    sets.push('updated_at = @now')
    params.now = new Date().toISOString()
    this.db.prepare(`UPDATE issues SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }

  /** List issues, optionally filtered. */
  list(opts?: { provider?: string; repo?: string; status?: string }): Issue[] {
    let sql = 'SELECT * FROM issues WHERE 1=1'
    const params: any[] = []
    if (opts?.provider) { sql += ' AND provider = ?'; params.push(opts.provider) }
    if (opts?.repo)     { sql += ' AND repo = ?'; params.push(opts.repo) }
    if (opts?.status)   { sql += ' AND status = ?'; params.push(opts.status) }
    sql += ' ORDER BY updated_at DESC'
    const rows = this.db.prepare(sql).all(...params) as any[]
    return rows.map(r => this._toIssue(r))
  }

  /** Get a single issue by id. */
  get(id: string): Issue | null {
    const row = this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as any
    return row ? this._toIssue(row) : null
  }

  /** Link an issue to a session. */
  linkSession(issueId: string, sessionId: string): void {
    this.db.prepare('UPDATE issues SET session_id = ?, updated_at = ? WHERE id = ?')
      .run(sessionId, new Date().toISOString(), issueId)
  }

  /** Unlink an issue from its session. */
  unlinkSession(issueId: string): void {
    this.db.prepare('UPDATE issues SET session_id = NULL, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), issueId)
  }

  /** Update an issue's status. */
  updateStatus(issueId: string, status: string): void {
    this.db.prepare('UPDATE issues SET status = ?, synced_at = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), new Date().toISOString(), issueId)
  }

  /** List all issues linked to sessions. */
  listLinked(): Issue[] {
    const rows = this.db.prepare('SELECT * FROM issues WHERE session_id IS NOT NULL ORDER BY updated_at DESC').all() as any[]
    return rows.map(r => this._toIssue(r))
  }

  /** Find issue linked to a specific session. */
  findBySession(sessionId: string): Issue | null {
    const row = this.db.prepare('SELECT * FROM issues WHERE session_id = ?').get(sessionId) as any
    return row ? this._toIssue(row) : null
  }

  /** List distinct project dirs used by Latch tasks (for the "repos" dropdown). */
  listLatchProjectDirs(): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT project_dir FROM issues WHERE provider = 'latch' AND project_dir IS NOT NULL AND project_dir != '' ORDER BY project_dir`
    ).all() as any[]
    return rows.map(r => r.project_dir)
  }

  /** Delete an issue. */
  delete(id: string): void {
    this.db.prepare('DELETE FROM issues WHERE id = ?').run(id)
  }

  private _toIssue(row: any): Issue {
    let labels: string[] = []
    try { labels = JSON.parse(row.labels) } catch { /* default empty */ }
    return {
      id: row.id,
      provider: row.provider,
      ref: row.ref,
      title: row.title,
      body: row.body || '',
      status: row.status,
      labels,
      assignee: row.assignee,
      url: row.url,
      repo: row.repo,
      priority: row.priority,
      projectDir: row.project_dir || undefined,
      branchName: row.branch_name || undefined,
      sessionId: row.session_id,
      syncedAt: row.synced_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
