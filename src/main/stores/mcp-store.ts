/**
 * @module mcp-store
 * @description SQLite-backed persistence for MCP server configurations.
 * Follows the SkillsStore pattern: static open(db), _init(), CRUD methods.
 */

import type Database from 'better-sqlite3'

export class McpStore {
  db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  static open(db: Database.Database): McpStore {
    const store = new McpStore(db)
    store._init()
    return store
  }

  _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        transport   TEXT NOT NULL,
        command     TEXT,
        args        TEXT,
        env         TEXT,
        url         TEXT,
        headers     TEXT,
        harnesses   TEXT,
        enabled     INTEGER NOT NULL DEFAULT 1,
        tags        TEXT,
        catalog_id  TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `)

    // Idempotent migration: add tools column
    try { this.db.exec('ALTER TABLE mcp_servers ADD COLUMN tools TEXT') } catch { /* already exists */ }
  }

  listServers() {
    const rows = this.db.prepare('SELECT * FROM mcp_servers ORDER BY name ASC').all() as any[]
    return { ok: true, servers: rows.map(this._deserialise) }
  }

  getServer(id: string) {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as any
    if (!row) return { ok: false, error: `MCP server '${id}' not found.` }
    return { ok: true, server: this._deserialise(row) }
  }

  saveServer(server: any) {
    if (!server?.id)   return { ok: false, error: 'MCP server must have an id.' }
    if (!server?.name) return { ok: false, error: 'MCP server must have a name.' }
    if (!server?.transport) return { ok: false, error: 'MCP server must have a transport.' }

    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO mcp_servers (id, name, description, transport, command, args, tools, env, url, headers, harnesses, enabled, tags, catalog_id, created_at, updated_at)
      VALUES (@id, @name, @description, @transport, @command, @args, @tools, @env, @url, @headers, @harnesses, @enabled, @tags, @catalog_id, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        name = @name, description = @description, transport = @transport,
        command = @command, args = @args, tools = @tools, env = @env,
        url = @url, headers = @headers, harnesses = @harnesses,
        enabled = @enabled, tags = @tags, catalog_id = @catalog_id,
        updated_at = @now
    `).run({
      id: server.id,
      name: server.name,
      description: server.description ?? null,
      transport: server.transport,
      command: server.command ?? null,
      args: server.args ? JSON.stringify(server.args) : null,
      tools: Array.isArray(server.tools) && server.tools.length ? JSON.stringify(server.tools) : null,
      env: server.env ? JSON.stringify(server.env) : null,
      url: server.url ?? null,
      headers: server.headers ? JSON.stringify(server.headers) : null,
      harnesses: server.harnesses ? JSON.stringify(server.harnesses) : null,
      enabled: server.enabled !== false ? 1 : 0,
      tags: Array.isArray(server.tags) ? server.tags.join(',') : (server.tags ?? null),
      catalog_id: server.catalogId ?? null,
      now,
    })

    return { ok: true }
  }

  deleteServer(id: string) {
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
    return { ok: true }
  }

  _deserialise(row: any) {
    let args: string[] | undefined
    if (row.args) {
      try { args = JSON.parse(row.args) } catch { /* fallback */ }
    }

    let tools: string[] = []
    if (row.tools) {
      try { tools = JSON.parse(row.tools) } catch { /* fallback */ }
    }

    let env: Record<string, string> | undefined
    if (row.env) {
      try { env = JSON.parse(row.env) } catch { /* fallback */ }
    }

    let headers: Record<string, string> | undefined
    if (row.headers) {
      try { headers = JSON.parse(row.headers) } catch { /* fallback */ }
    }

    let harnesses: string[] | null = null
    if (row.harnesses) {
      try { harnesses = JSON.parse(row.harnesses) } catch { /* fallback */ }
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description ?? '',
      transport: row.transport,
      command: row.command ?? undefined,
      args,
      tools,
      env,
      url: row.url ?? undefined,
      headers,
      harnesses,
      enabled: row.enabled === 1,
      tags: row.tags ? row.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [],
      catalogId: row.catalog_id ?? null,
    }
  }
}
