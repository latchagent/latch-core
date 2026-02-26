---
name: adding-sqlite-stores
description: Creates new SQLite-backed data stores in the main process. Covers the store class pattern (static open, _init, CRUD), idempotent migrations, JSON serialization, column whitelisting, and wiring into the app lifecycle. Use when adding persistence for a new data domain.
---

# Adding SQLite Stores

All stores live in `src/main/stores/` and share the same class structure. The app uses a single `better-sqlite3` database (`latch.db` in userData).

## Store class template

```typescript
// src/main/stores/widget-store.ts

import type Database from 'better-sqlite3'

export class WidgetStore {
  db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  /** Factory — call this, not the constructor directly. */
  static open(db: Database.Database): WidgetStore {
    const store = new WidgetStore(db)
    store._init()
    return store
  }

  /** Create table + run idempotent migrations. */
  _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS widgets (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        config      TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `)

    // Migrations — each wrapped in try/catch so they're idempotent
    try { this.db.exec('ALTER TABLE widgets ADD COLUMN tags TEXT') } catch { /* already exists */ }
  }

  /** List all widgets. */
  listWidgets() {
    const rows = this.db.prepare('SELECT * FROM widgets ORDER BY name ASC').all() as any[]
    return {
      ok: true,
      widgets: rows.map((row) => ({
        id: row.id,
        name: row.name,
        config: row.config ? JSON.parse(row.config) : null,
        tags: row.tags ? JSON.parse(row.tags) : [],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    }
  }

  /** Get a single widget by ID. */
  getWidget(id: string) {
    const row = this.db.prepare('SELECT * FROM widgets WHERE id = ?').get(id) as any
    if (!row) return { ok: false, error: 'Widget not found.' }
    return {
      ok: true,
      widget: {
        id: row.id,
        name: row.name,
        config: row.config ? JSON.parse(row.config) : null,
      },
    }
  }

  /** Create or update a widget (upsert). */
  saveWidget(widget: { id: string; name: string; config?: object; tags?: string[] }) {
    if (!widget?.id) return { ok: false, error: 'Widget must have an id.' }
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO widgets (id, name, config, tags, created_at, updated_at)
      VALUES (@id, @name, @config, @tags, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        name = @name, config = @config, tags = @tags, updated_at = @now
    `).run({
      id: widget.id,
      name: widget.name,
      config: widget.config ? JSON.stringify(widget.config) : null,
      tags: widget.tags?.length ? JSON.stringify(widget.tags) : null,
      now,
    })
    return { ok: true }
  }

  /** Delete a widget. */
  deleteWidget(id: string) {
    this.db.prepare('DELETE FROM widgets WHERE id = ?').run(id)
    return { ok: true }
  }
}
```

## Key patterns

### JSON serialization
Store complex objects as JSON strings. Parse on read, stringify on write:
```typescript
config: row.config ? JSON.parse(row.config) : null
```
Wrap parsing in try/catch if the data could be corrupt.

### Column whitelist for dynamic updates
When accepting arbitrary update fields, whitelist allowed columns to prevent SQL injection:
```typescript
static readonly ALLOWED_COLUMNS = new Set(['name', 'status', 'config'])

updateWidget(id: string, updates: Record<string, any>) {
  const fields = Object.keys(updates).filter((k) => WidgetStore.ALLOWED_COLUMNS.has(k))
  if (!fields.length) return { ok: true }
  const assignments = fields.map((k) => `${k} = @${k}`).join(', ')
  this.db.prepare(`UPDATE widgets SET ${assignments} WHERE id = @id`)
    .run({ id, ...Object.fromEntries(fields.map((k) => [k, updates[k]])) })
  return { ok: true }
}
```

### Auto-pruning for high-volume tables
For tables that grow unbounded (activity logs, feed items), prune after every N inserts:
```typescript
private insertsSincePrune = 0

record(params: { ... }) {
  // ... insert ...
  this.insertsSincePrune++
  if (this.insertsSincePrune >= 100) {
    this.insertsSincePrune = 0
    this._prune()
  }
}

private _prune(): void {
  try {
    this.db.prepare(`
      DELETE FROM widgets WHERE rowid NOT IN (
        SELECT rowid FROM widgets ORDER BY created_at DESC LIMIT ?
      )
    `).run(10_000)
  } catch { /* non-fatal */ }
}
```

## Wiring into the app

In `src/main/index.ts` inside `app.whenReady()`:

```typescript
import { WidgetStore } from './stores/widget-store'

// After db is opened:
const widgetStore = WidgetStore.open(db)

// Register IPC handlers:
ipcMain.handle('latch:widget-list', async () => widgetStore.listWidgets())
ipcMain.handle('latch:widget-save', async (_event: any, widget: any) => widgetStore.saveWidget(widget))
ipcMain.handle('latch:widget-delete', async (_event: any, { id }: any) => widgetStore.deleteWidget(id))
```

If the database fails to open, provide a fallback stub so IPC handlers don't crash:

```typescript
} catch (err: any) {
  widgetStore = {
    listWidgets:  () => ({ ok: false, error: 'WidgetStore unavailable' }),
    saveWidget:   () => ({ ok: false, error: 'WidgetStore unavailable' }),
    deleteWidget: () => ({ ok: false, error: 'WidgetStore unavailable' }),
  }
}
```

## Checklist

1. Create `src/main/stores/<name>-store.ts` with the class pattern above
2. Add `static open(db)`, `_init()`, and CRUD methods
3. Use parameterized queries (`?` or `@param`) — never concatenate user input
4. Import and instantiate in `src/main/index.ts` inside `app.whenReady()`
5. Add fallback stub in the catch block
6. Register IPC handlers (see `adding-ipc-handlers` skill)
