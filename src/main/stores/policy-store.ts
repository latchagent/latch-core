import type Database from 'better-sqlite3'

export class PolicyStore {
  db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  static open(db: Database.Database): PolicyStore {
    const store = new PolicyStore(db)
    store._init()
    return store
  }

  _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS policies (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        body        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `)

    // (No default policy seeded — users create policies explicitly.)
  }

  _upsert(policy: any): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO policies (id, name, description, body, created_at, updated_at)
      VALUES (@id, @name, @description, @body, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        name = @name, description = @description, body = @body, updated_at = @now
    `).run({
      id: policy.id, name: policy.name, description: policy.description ?? null,
      body: JSON.stringify(policy), now
    })
  }

  listPolicies() {
    const rows = this.db.prepare('SELECT * FROM policies ORDER BY name ASC').all() as any[]
    const policies: any[] = []
    for (const row of rows) {
      try {
        policies.push({ ...JSON.parse(row.body), id: row.id, name: row.name, updatedAt: row.updated_at })
      } catch (err: unknown) {
        console.warn('[PolicyStore] Skipping row with corrupt JSON body:', row.id, err instanceof Error ? err.message : String(err))
      }
    }
    return { ok: true, policies }
  }

  getPolicy(id: string) {
    const row = this.db.prepare('SELECT * FROM policies WHERE id = ?').get(id) as any
    if (!row) return { ok: false, error: `Policy '${id}' not found.` }
    try {
      return {
        ok: true,
        policy: { ...JSON.parse(row.body), id: row.id, name: row.name, updatedAt: row.updated_at }
      }
    } catch (err: unknown) {
      console.warn('[PolicyStore] Corrupt policy data for id:', id, err instanceof Error ? err.message : String(err))
      return { ok: false, error: 'Corrupt policy data' }
    }
  }

  savePolicy(policy: any) {
    if (!policy?.id) return { ok: false, error: 'Policy must have an id.' }
    if (!policy?.name) return { ok: false, error: 'Policy must have a name.' }

    const merged = {
      ...policy,
      permissions: {
        allowBash: true, allowNetwork: true, allowFileWrite: true,
        confirmDestructive: true, blockedGlobs: [],
        ...policy.permissions
      },
      harnesses: policy.harnesses ?? {}
    }

    this._upsert(merged)
    return { ok: true }
  }

  deletePolicy(id: string) {
    this.db.prepare('DELETE FROM policies WHERE id = ?').run(id)
    return { ok: true }
  }
}

