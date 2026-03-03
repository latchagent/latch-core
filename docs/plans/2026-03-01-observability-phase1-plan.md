# Observability Phase 1 — Cost & Token Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add real-time token/cost tracking by ingesting Claude Code and Codex JSONL logs, with a polished UsageView dashboard in the sidebar.

**Architecture:** A main-process `UsageWatcher` service watches harness JSONL log directories (`~/.claude/projects/`, `~/.codex/sessions/`), parses new lines, calculates costs via a `Pricing` engine, persists to a `UsageStore` (SQLite), and pushes events to the renderer. The renderer shows a `UsageView` with stat cards, sparkline, model mix bar, and session cost breakdown. The sidebar gets restructured with grouped section headers (OBSERVE / GOVERN / BUILD).

**Tech Stack:** TypeScript, Electron IPC, better-sqlite3, React 18, Zustand, Phosphor Icons, pure CSS visualizations

---

## Task 1: Pricing Engine

**Files:**
- Create: `src/main/lib/pricing.ts`

**Step 1: Create pricing module**

This is a pure utility with no dependencies — build it first so everything else can use it.

```typescript
// src/main/lib/pricing.ts

/**
 * @module pricing
 * @description Hardcoded model pricing table and cost calculator.
 * No network calls — pricing ships with the app.
 */

/** Per-million-token rates */
export interface ModelPricing {
  inputPerMTok: number
  outputPerMTok: number
  cacheWritePerMTok: number
  cacheReadPerMTok: number
}

/** Token counts extracted from a single assistant turn */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
}

// ── Pricing Table ───────────────────────────────────────────────────────────

const CLAUDE_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6':   { inputPerMTok: 5.00,  outputPerMTok: 25.00, cacheWritePerMTok: 10.00, cacheReadPerMTok: 0.50 },
  'claude-opus-4-5':   { inputPerMTok: 5.00,  outputPerMTok: 25.00, cacheWritePerMTok: 10.00, cacheReadPerMTok: 0.50 },
  'claude-opus-4-1':   { inputPerMTok: 15.00, outputPerMTok: 75.00, cacheWritePerMTok: 30.00, cacheReadPerMTok: 1.50 },
  'claude-opus-4':     { inputPerMTok: 15.00, outputPerMTok: 75.00, cacheWritePerMTok: 30.00, cacheReadPerMTok: 1.50 },
  'claude-sonnet-4-6': { inputPerMTok: 3.00,  outputPerMTok: 15.00, cacheWritePerMTok: 6.00,  cacheReadPerMTok: 0.30 },
  'claude-sonnet-4-5': { inputPerMTok: 3.00,  outputPerMTok: 15.00, cacheWritePerMTok: 6.00,  cacheReadPerMTok: 0.30 },
  'claude-sonnet-4':   { inputPerMTok: 3.00,  outputPerMTok: 15.00, cacheWritePerMTok: 6.00,  cacheReadPerMTok: 0.30 },
  'claude-haiku-4-5':  { inputPerMTok: 1.00,  outputPerMTok: 5.00,  cacheWritePerMTok: 2.00,  cacheReadPerMTok: 0.10 },
  'claude-haiku-3-5':  { inputPerMTok: 0.80,  outputPerMTok: 4.00,  cacheWritePerMTok: 1.60,  cacheReadPerMTok: 0.08 },
  'claude-haiku-3':    { inputPerMTok: 0.25,  outputPerMTok: 1.25,  cacheWritePerMTok: 0.50,  cacheReadPerMTok: 0.03 },
}

const OPENAI_PRICING: Record<string, ModelPricing> = {
  'gpt-5-codex':   { inputPerMTok: 1.25, outputPerMTok: 10.00, cacheWritePerMTok: 0, cacheReadPerMTok: 0.125 },
  'gpt-5.1-codex': { inputPerMTok: 1.25, outputPerMTok: 10.00, cacheWritePerMTok: 0, cacheReadPerMTok: 0.125 },
  'gpt-5':         { inputPerMTok: 1.25, outputPerMTok: 10.00, cacheWritePerMTok: 0, cacheReadPerMTok: 0.125 },
  'gpt-5.1':       { inputPerMTok: 1.25, outputPerMTok: 10.00, cacheWritePerMTok: 0, cacheReadPerMTok: 0.125 },
  'gpt-4.1':       { inputPerMTok: 2.00, outputPerMTok: 8.00,  cacheWritePerMTok: 0, cacheReadPerMTok: 0.50  },
  'gpt-4.1-mini':  { inputPerMTok: 0.40, outputPerMTok: 1.60,  cacheWritePerMTok: 0, cacheReadPerMTok: 0.10  },
  'gpt-4o':        { inputPerMTok: 2.50, outputPerMTok: 10.00, cacheWritePerMTok: 0, cacheReadPerMTok: 1.25  },
  'gpt-4o-mini':   { inputPerMTok: 0.15, outputPerMTok: 0.60,  cacheWritePerMTok: 0, cacheReadPerMTok: 0.075 },
  'o3':            { inputPerMTok: 2.00, outputPerMTok: 8.00,  cacheWritePerMTok: 0, cacheReadPerMTok: 0.50  },
  'o3-mini':       { inputPerMTok: 1.10, outputPerMTok: 4.40,  cacheWritePerMTok: 0, cacheReadPerMTok: 0.55  },
  'o4-mini':       { inputPerMTok: 1.10, outputPerMTok: 4.40,  cacheWritePerMTok: 0, cacheReadPerMTok: 0.275 },
}

/** Most expensive Claude rate — fallback for unknown Claude models */
const CLAUDE_FALLBACK = CLAUDE_PRICING['claude-opus-4-1']
/** Most expensive OpenAI rate — fallback for unknown OpenAI models */
const OPENAI_FALLBACK = OPENAI_PRICING['o3']

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Strip date suffix from model ID.
 * e.g. "claude-opus-4-6-20260101" → "claude-opus-4-6"
 */
export function normalizeModelId(raw: string): string {
  return raw.replace(/-\d{8}$/, '')
}

/**
 * Look up pricing for a model ID. Returns null if completely unknown.
 * Falls back to the most expensive model in the family for safety.
 */
export function getModelPricing(rawModelId: string): ModelPricing {
  const id = normalizeModelId(rawModelId)
  if (CLAUDE_PRICING[id]) return CLAUDE_PRICING[id]
  if (OPENAI_PRICING[id]) return OPENAI_PRICING[id]

  // Fuzzy family match
  if (id.startsWith('claude-')) {
    console.warn(`[pricing] Unknown Claude model "${id}", using opus-4-1 fallback`)
    return CLAUDE_FALLBACK
  }
  if (id.startsWith('gpt-') || id.startsWith('o3') || id.startsWith('o4')) {
    console.warn(`[pricing] Unknown OpenAI model "${id}", using o3 fallback`)
    return OPENAI_FALLBACK
  }

  console.warn(`[pricing] Unknown model family "${id}", using Claude opus fallback`)
  return CLAUDE_FALLBACK
}

/**
 * Calculate cost in USD for a single turn's token usage.
 */
export function calculateCost(usage: TokenUsage, rawModelId: string): number {
  const pricing = getModelPricing(rawModelId)
  const cost =
    (usage.inputTokens / 1_000_000) * pricing.inputPerMTok +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMTok +
    (usage.cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMTok +
    (usage.cacheReadTokens / 1_000_000) * pricing.cacheReadPerMTok
  return Math.round(cost * 1_000_000) / 1_000_000 // 6 decimal precision
}

/**
 * Detect harness family from model ID.
 */
export function harnessFromModel(rawModelId: string): 'claude' | 'codex' | 'unknown' {
  const id = normalizeModelId(rawModelId)
  if (id.startsWith('claude-')) return 'claude'
  if (id.startsWith('gpt-') || id.startsWith('o3') || id.startsWith('o4')) return 'codex'
  return 'unknown'
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit --project tsconfig.node.json 2>&1 | head -20`
Expected: No errors from pricing.ts

**Step 3: Commit**

```bash
git add src/main/lib/pricing.ts
git commit -m "feat(observability): add pricing engine with hardcoded model rates"
```

---

## Task 2: Types

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Add UsageEvent and UsageSummary types**

Find the `AppView` type (line 619) and add `'usage'` to the union. Then add the new interfaces after the existing `FeedItem` interface (around line 595).

Add `'usage'` to `AppView`:
```typescript
// In the AppView type union, add 'usage':
export type AppView = 'home' | 'policies' | 'agents' | 'mcp' | 'create-policy' | 'edit-policy' | 'create-service' | 'settings' | 'feed' | 'radar' | 'docs' | 'services' | 'gateway' | 'usage';
```

Add new interfaces after `FeedItem` (after line ~595):
```typescript
// ── Usage / Observability ─────────────────────────────────────────────────

export interface UsageEvent {
  id: string
  sessionId: string | null
  harnessId: string
  model: string
  timestamp: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  costUsd: number
  toolName: string | null
  sourceFile: string
  requestId: string | null
}

export interface UsageDaySummary {
  date: string
  harnessId: string
  model: string
  totalInput: number
  totalOutput: number
  totalCacheWrite: number
  totalCacheRead: number
  totalCostUsd: number
  eventCount: number
}

export interface UsageSessionSummary {
  sessionId: string | null
  sessionName: string | null
  harnessId: string
  totalInput: number
  totalOutput: number
  totalCacheWrite: number
  totalCacheRead: number
  totalCostUsd: number
  eventCount: number
  models: string[]
  firstEvent: string
  lastEvent: string
}

export interface UsageModelSummary {
  model: string
  totalCostUsd: number
  eventCount: number
}

export interface UsageSummary {
  todayCostUsd: number
  todayInputTokens: number
  todayOutputTokens: number
  cacheEfficiency: number
  dailySummaries: UsageDaySummary[]
  sessionSummaries: UsageSessionSummary[]
  modelSummaries: UsageModelSummary[]
}
```

Add to the `LatchAPI` interface (after the feed methods, around line ~798):
```typescript
  // ── Usage / Observability ───────────────────────────────────────────────
  listUsage(payload?: { sessionId?: string; limit?: number; offset?: number }): Promise<{ ok: boolean; events: UsageEvent[]; total: number }>
  getUsageSummary(payload?: { days?: number; sessionId?: string }): Promise<{ ok: boolean; summary: UsageSummary }>
  clearUsage(payload?: { sessionId?: string }): Promise<{ ok: boolean }>
  exportUsage(payload?: { sessionId?: string; format?: 'json' | 'csv' }): Promise<{ ok: boolean; filePath?: string; count?: number; error?: string }>
  onUsageEvent(callback: (event: UsageEvent) => void): () => void
  onUsageBackfillProgress(callback: (progress: { current: number; total: number }) => void): () => void
```

**Step 2: Verify it compiles**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit --project tsconfig.node.json 2>&1 | head -20`
Expected: No errors from types

**Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(observability): add UsageEvent, UsageSummary types and LatchAPI methods"
```

---

## Task 3: Usage Store

**Files:**
- Create: `src/main/stores/usage-store.ts`

**Step 1: Create the store class**

Follow the exact `ActivityStore` pattern: constructor, static `open()`, `_init()`, `record()`, `list()`, `clear()`, auto-pruning.

```typescript
// src/main/stores/usage-store.ts

/**
 * @module usage-store
 * @description SQLite-backed persistence for token usage events.
 * Follows the ActivityStore pattern with auto-pruning and daily rollups.
 */

import type Database from 'better-sqlite3'
import crypto from 'node:crypto'
import type { UsageEvent, UsageDaySummary, UsageSessionSummary, UsageModelSummary, UsageSummary } from '../../types'

const MAX_ROWS = 50_000
const PRUNE_EVERY = 500

let idCounter = 0

export class UsageStore {
  db: Database.Database
  private insertsSincePrune = 0

  constructor(db: Database.Database) {
    this.db = db
  }

  static open(db: Database.Database): UsageStore {
    const store = new UsageStore(db)
    store._init()
    return store
  }

  _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id                TEXT PRIMARY KEY,
        session_id        TEXT,
        harness_id        TEXT NOT NULL,
        model             TEXT NOT NULL,
        timestamp         TEXT NOT NULL,
        input_tokens      INTEGER NOT NULL DEFAULT 0,
        output_tokens     INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd          REAL NOT NULL DEFAULT 0.0,
        tool_name         TEXT,
        source_file       TEXT,
        request_id        TEXT
      );
    `)

    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_session_ts ON usage_events (session_id, timestamp DESC);`)
    } catch { /* index exists */ }
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events (timestamp DESC);`)
    } catch { /* index exists */ }
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_source_req ON usage_events (source_file, request_id);`)
    } catch { /* index exists */ }

    // Daily rollup table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_daily (
        date              TEXT NOT NULL,
        harness_id        TEXT NOT NULL,
        model             TEXT NOT NULL,
        total_input       INTEGER NOT NULL DEFAULT 0,
        total_output      INTEGER NOT NULL DEFAULT 0,
        total_cache_write INTEGER NOT NULL DEFAULT 0,
        total_cache_read  INTEGER NOT NULL DEFAULT 0,
        total_cost_usd    REAL NOT NULL DEFAULT 0.0,
        event_count       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, harness_id, model)
      );
    `)
  }

  /**
   * Check if a (source_file, request_id) pair already exists — for dedup.
   */
  isDuplicate(sourceFile: string, requestId: string): boolean {
    if (!requestId) return false
    const row = this.db.prepare(
      `SELECT 1 FROM usage_events WHERE source_file = ? AND request_id = ? LIMIT 1`
    ).get(sourceFile, requestId)
    return !!row
  }

  /**
   * Record a single usage event. Returns the hydrated UsageEvent.
   */
  record(params: {
    sessionId: string | null
    harnessId: string
    model: string
    timestamp: string
    inputTokens: number
    outputTokens: number
    cacheWriteTokens: number
    cacheReadTokens: number
    costUsd: number
    toolName: string | null
    sourceFile: string
    requestId: string | null
  }): UsageEvent {
    const id = `usg-${Date.now()}-${++idCounter}`

    this.db.prepare(`
      INSERT INTO usage_events
        (id, session_id, harness_id, model, timestamp, input_tokens, output_tokens,
         cache_write_tokens, cache_read_tokens, cost_usd, tool_name, source_file, request_id)
      VALUES (@id, @session_id, @harness_id, @model, @timestamp, @input_tokens, @output_tokens,
              @cache_write_tokens, @cache_read_tokens, @cost_usd, @tool_name, @source_file, @request_id)
    `).run({
      id,
      session_id: params.sessionId,
      harness_id: params.harnessId,
      model: params.model,
      timestamp: params.timestamp,
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
      cache_write_tokens: params.cacheWriteTokens,
      cache_read_tokens: params.cacheReadTokens,
      cost_usd: params.costUsd,
      tool_name: params.toolName,
      source_file: params.sourceFile,
      request_id: params.requestId,
    })

    // Update daily rollup
    const date = params.timestamp.slice(0, 10) // YYYY-MM-DD
    this.db.prepare(`
      INSERT INTO usage_daily (date, harness_id, model, total_input, total_output, total_cache_write, total_cache_read, total_cost_usd, event_count)
      VALUES (@date, @harness_id, @model, @input, @output, @cw, @cr, @cost, 1)
      ON CONFLICT (date, harness_id, model) DO UPDATE SET
        total_input = total_input + @input,
        total_output = total_output + @output,
        total_cache_write = total_cache_write + @cw,
        total_cache_read = total_cache_read + @cr,
        total_cost_usd = total_cost_usd + @cost,
        event_count = event_count + 1
    `).run({
      date,
      harness_id: params.harnessId,
      model: params.model,
      input: params.inputTokens,
      output: params.outputTokens,
      cw: params.cacheWriteTokens,
      cr: params.cacheReadTokens,
      cost: params.costUsd,
    })

    // Auto-prune
    if (++this.insertsSincePrune >= PRUNE_EVERY) {
      this.insertsSincePrune = 0
      this._prune()
    }

    return {
      id,
      sessionId: params.sessionId,
      harnessId: params.harnessId,
      model: params.model,
      timestamp: params.timestamp,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cacheWriteTokens: params.cacheWriteTokens,
      cacheReadTokens: params.cacheReadTokens,
      costUsd: params.costUsd,
      toolName: params.toolName,
      sourceFile: params.sourceFile,
      requestId: params.requestId,
    }
  }

  private _prune(): void {
    const count = (this.db.prepare('SELECT COUNT(*) as cnt FROM usage_events').get() as any)?.cnt ?? 0
    if (count > MAX_ROWS) {
      this.db.prepare(`
        DELETE FROM usage_events WHERE id IN (
          SELECT id FROM usage_events ORDER BY timestamp ASC LIMIT ?
        )
      `).run(count - MAX_ROWS)
    }
  }

  /**
   * Paginated list of usage events.
   */
  list(opts?: { sessionId?: string; limit?: number; offset?: number }): { events: UsageEvent[]; total: number } {
    const sessionId = opts?.sessionId
    const limit = opts?.limit ?? 200
    const offset = opts?.offset ?? 0

    const where = sessionId ? 'WHERE session_id = ?' : ''
    const params: any[] = sessionId ? [sessionId] : []

    const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM usage_events ${where}`).get(...params) as any
    const total = countRow?.cnt ?? 0

    const rows = this.db.prepare(
      `SELECT * FROM usage_events ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[]

    return {
      total,
      events: rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        harnessId: r.harness_id,
        model: r.model,
        timestamp: r.timestamp,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheWriteTokens: r.cache_write_tokens,
        cacheReadTokens: r.cache_read_tokens,
        costUsd: r.cost_usd,
        toolName: r.tool_name,
        sourceFile: r.source_file,
        requestId: r.request_id,
      })),
    }
  }

  /**
   * Build summary for the dashboard.
   */
  getSummary(opts?: { days?: number; sessionId?: string }): UsageSummary {
    const days = opts?.days ?? 30
    const today = new Date().toISOString().slice(0, 10)
    const sinceDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

    // Today's totals
    const todayRow = this.db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as cost,
             COALESCE(SUM(input_tokens), 0) as input,
             COALESCE(SUM(output_tokens), 0) as output,
             COALESCE(SUM(cache_read_tokens), 0) as cache_read,
             COALESCE(SUM(cache_write_tokens), 0) as cache_write
      FROM usage_events WHERE timestamp >= ?
    `).get(today + 'T00:00:00.000Z') as any

    const totalTokens = (todayRow?.input ?? 0) + (todayRow?.cache_write ?? 0) + (todayRow?.cache_read ?? 0)
    const cacheEfficiency = totalTokens > 0 ? (todayRow?.cache_read ?? 0) / totalTokens : 0

    // Daily summaries from rollup table
    const dailyRows = this.db.prepare(`
      SELECT * FROM usage_daily WHERE date >= ? ORDER BY date DESC
    `).all(sinceDate) as any[]

    const dailySummaries: UsageDaySummary[] = dailyRows.map((r) => ({
      date: r.date,
      harnessId: r.harness_id,
      model: r.model,
      totalInput: r.total_input,
      totalOutput: r.total_output,
      totalCacheWrite: r.total_cache_write,
      totalCacheRead: r.total_cache_read,
      totalCostUsd: r.total_cost_usd,
      eventCount: r.event_count,
    }))

    // Session summaries
    const sessionFilter = opts?.sessionId ? 'AND ue.session_id = ?' : ''
    const sessionParams: any[] = opts?.sessionId ? [sinceDate + 'T00:00:00.000Z', opts.sessionId] : [sinceDate + 'T00:00:00.000Z']

    const sessionRows = this.db.prepare(`
      SELECT ue.session_id,
             ue.harness_id,
             COALESCE(SUM(ue.input_tokens), 0) as total_input,
             COALESCE(SUM(ue.output_tokens), 0) as total_output,
             COALESCE(SUM(ue.cache_write_tokens), 0) as total_cache_write,
             COALESCE(SUM(ue.cache_read_tokens), 0) as total_cache_read,
             COALESCE(SUM(ue.cost_usd), 0) as total_cost,
             COUNT(*) as event_count,
             GROUP_CONCAT(DISTINCT ue.model) as models,
             MIN(ue.timestamp) as first_event,
             MAX(ue.timestamp) as last_event
      FROM usage_events ue
      WHERE ue.timestamp >= ? ${sessionFilter}
      GROUP BY ue.session_id, ue.harness_id
      ORDER BY total_cost DESC
    `).all(...sessionParams) as any[]

    const sessionSummaries: UsageSessionSummary[] = sessionRows.map((r) => ({
      sessionId: r.session_id,
      sessionName: null, // Resolved in renderer from sessions map
      harnessId: r.harness_id,
      totalInput: r.total_input,
      totalOutput: r.total_output,
      totalCacheWrite: r.total_cache_write,
      totalCacheRead: r.total_cache_read,
      totalCostUsd: r.total_cost,
      eventCount: r.event_count,
      models: r.models ? r.models.split(',') : [],
      firstEvent: r.first_event,
      lastEvent: r.last_event,
    }))

    // Model summaries
    const modelRows = this.db.prepare(`
      SELECT model,
             COALESCE(SUM(total_cost_usd), 0) as total_cost,
             COALESCE(SUM(event_count), 0) as event_count
      FROM usage_daily WHERE date >= ?
      GROUP BY model ORDER BY total_cost DESC
    `).all(sinceDate) as any[]

    const modelSummaries: UsageModelSummary[] = modelRows.map((r) => ({
      model: r.model,
      totalCostUsd: r.total_cost,
      eventCount: r.event_count,
    }))

    return {
      todayCostUsd: todayRow?.cost ?? 0,
      todayInputTokens: todayRow?.input ?? 0,
      todayOutputTokens: todayRow?.output ?? 0,
      cacheEfficiency,
      dailySummaries,
      sessionSummaries,
      modelSummaries,
    }
  }

  /**
   * Export all events, optionally filtered by session.
   */
  exportAll(sessionId?: string): UsageEvent[] {
    const where = sessionId ? 'WHERE session_id = ?' : ''
    const params: any[] = sessionId ? [sessionId] : []
    const rows = this.db.prepare(`SELECT * FROM usage_events ${where} ORDER BY timestamp DESC`).all(...params) as any[]
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      harnessId: r.harness_id,
      model: r.model,
      timestamp: r.timestamp,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      cacheReadTokens: r.cache_read_tokens,
      costUsd: r.cost_usd,
      toolName: r.tool_name,
      sourceFile: r.source_file,
      requestId: r.request_id,
    }))
  }

  /**
   * Clear usage data — optionally scoped to a session.
   */
  clear(sessionId?: string): void {
    if (sessionId) {
      this.db.prepare('DELETE FROM usage_events WHERE session_id = ?').run(sessionId)
    } else {
      this.db.exec('DELETE FROM usage_events')
      this.db.exec('DELETE FROM usage_daily')
    }
  }
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit --project tsconfig.node.json 2>&1 | head -20`
Expected: No errors

**Step 3: Commit**

```bash
git add src/main/stores/usage-store.ts
git commit -m "feat(observability): add UsageStore with SQLite persistence and daily rollups"
```

---

## Task 4: Usage Watcher Service

**Files:**
- Create: `src/main/services/usage-watcher.ts`

**Step 1: Create the watcher service**

This is the core ingestion engine. It watches harness JSONL directories, parses new lines, calculates costs, and records to the store.

```typescript
// src/main/services/usage-watcher.ts

/**
 * @module usage-watcher
 * @description Watches Claude Code and Codex JSONL log directories for new
 * assistant messages. Extracts token usage, calculates costs via the pricing
 * engine, persists to UsageStore, and pushes real-time events to the renderer.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { UsageStore } from '../stores/usage-store'
import { calculateCost, normalizeModelId, harnessFromModel } from '../lib/pricing'
import type { UsageEvent } from '../../types'

interface WatcherOptions {
  /** Map of Latch session IDs to their repo_root paths */
  getSessionMap: () => Map<string, string>
  /** Push events to renderer */
  sendToRenderer: (channel: string, payload: unknown) => void
}

/** In-memory offset tracker for tailing files */
const fileOffsets = new Map<string, number>()

/** Debounce timers per directory */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Active fs.watch handles for cleanup */
const watchers: fs.FSWatcher[] = []

/**
 * Compute the Claude project slug from a repo root path.
 * e.g. /Users/foo/code/myproject → -Users-foo-code-myproject
 */
function claudeSlug(repoRoot: string): string {
  return repoRoot.replace(/\//g, '-').replace(/^-/, '-')
}

/**
 * Build a reverse map: Claude project dir → Latch session ID.
 */
function buildProjectToSessionMap(getSessionMap: () => Map<string, string>): Map<string, string> {
  const result = new Map<string, string>()
  const claudeBase = path.join(os.homedir(), '.claude', 'projects')
  for (const [sessionId, repoRoot] of getSessionMap()) {
    const slug = claudeSlug(repoRoot)
    const projectDir = path.join(claudeBase, slug)
    result.set(projectDir, sessionId)
  }
  return result
}

/**
 * Parse a single JSONL line from a Claude Code log.
 * Returns extracted usage data or null if not an assistant message with usage.
 */
function parseClaudeLine(line: string, sourceFile: string): {
  model: string
  timestamp: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  toolName: string | null
  requestId: string | null
} | null {
  try {
    const obj = JSON.parse(line)
    if (obj.type !== 'assistant') return null
    if (!obj.message?.usage) return null

    const usage = obj.message.usage
    const model = obj.message?.model
    if (!model) return null

    // Extract tool name from content blocks
    let toolName: string | null = null
    if (Array.isArray(obj.message?.content)) {
      const toolBlock = obj.message.content.find((b: any) => b.type === 'tool_use')
      if (toolBlock) toolName = toolBlock.name ?? null
    }

    return {
      model,
      timestamp: obj.timestamp ?? new Date().toISOString(),
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      toolName,
      requestId: obj.requestId ?? null,
    }
  } catch {
    return null
  }
}

/**
 * Parse a single JSONL line from a Codex CLI log.
 */
function parseCodexLine(line: string): {
  model: string
  timestamp: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  toolName: string | null
  requestId: string | null
} | null {
  try {
    const obj = JSON.parse(line)
    if (obj?.payload?.type !== 'token_count') return null
    const info = obj.payload?.info?.last_token_usage ?? obj.payload?.info?.total_token_usage
    if (!info) return null

    const model = obj.turn_context?.model ?? 'gpt-5-codex'

    return {
      model,
      timestamp: obj.timestamp ?? new Date().toISOString(),
      inputTokens: (info.input_tokens ?? 0) - (info.cached_input_tokens ?? 0),
      outputTokens: info.output_tokens ?? 0,
      cacheWriteTokens: 0,
      cacheReadTokens: info.cached_input_tokens ?? info.cache_read_input_tokens ?? 0,
      toolName: null,
      requestId: null,
    }
  } catch {
    return null
  }
}

/**
 * Read new bytes from a file since last offset, parse lines, record events.
 */
function processNewLines(
  filePath: string,
  parseFn: (line: string, file: string) => ReturnType<typeof parseClaudeLine>,
  store: UsageStore,
  sessionId: string | null,
  harnessId: string,
  sendToRenderer: (channel: string, payload: unknown) => void,
): void {
  let offset = fileOffsets.get(filePath) ?? 0
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    return
  }
  if (stat.size <= offset) return

  const fd = fs.openSync(filePath, 'r')
  const buf = Buffer.alloc(stat.size - offset)
  fs.readSync(fd, buf, 0, buf.length, offset)
  fs.closeSync(fd)
  fileOffsets.set(filePath, stat.size)

  const text = buf.toString('utf8')
  const lines = text.split('\n').filter((l) => l.trim())

  for (const line of lines) {
    const parsed = parseFn(line, filePath)
    if (!parsed) continue

    // Dedup by requestId
    if (parsed.requestId && store.isDuplicate(filePath, parsed.requestId)) continue

    const normalizedModel = normalizeModelId(parsed.model)
    const costUsd = calculateCost({
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      cacheWriteTokens: parsed.cacheWriteTokens,
      cacheReadTokens: parsed.cacheReadTokens,
    }, parsed.model)

    const event = store.record({
      sessionId,
      harnessId,
      model: normalizedModel,
      timestamp: parsed.timestamp,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      cacheWriteTokens: parsed.cacheWriteTokens,
      cacheReadTokens: parsed.cacheReadTokens,
      costUsd,
      toolName: parsed.toolName,
      sourceFile: filePath,
      requestId: parsed.requestId,
    })

    sendToRenderer('latch:usage-event', event)
  }
}

/**
 * Scan a directory for .jsonl files and process them.
 */
function scanDirectory(
  dirPath: string,
  parseFn: (line: string, file: string) => ReturnType<typeof parseClaudeLine>,
  store: UsageStore,
  sessionId: string | null,
  harnessId: string,
  sendToRenderer: (channel: string, payload: unknown) => void,
): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(dirPath)
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue
    const filePath = path.join(dirPath, entry)
    processNewLines(filePath, parseFn, store, sessionId, harnessId, sendToRenderer)
  }

  // Also check subagent directories
  for (const entry of entries) {
    const subDir = path.join(dirPath, entry, 'subagents')
    try {
      if (fs.statSync(subDir).isDirectory()) {
        const subFiles = fs.readdirSync(subDir).filter((f) => f.endsWith('.jsonl'))
        for (const sf of subFiles) {
          processNewLines(path.join(subDir, sf), parseFn, store, sessionId, harnessId, sendToRenderer)
        }
      }
    } catch { /* no subagents dir */ }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Start watching harness log directories. Call once from app.whenReady().
 */
export function startUsageWatcher(store: UsageStore, opts: WatcherOptions): void {
  const claudeBase = path.join(os.homedir(), '.claude', 'projects')
  const codexBase = path.join(os.homedir(), '.codex', 'sessions')

  // Initial backfill — scan all existing JSONL files
  backfill(store, opts)

  // Watch Claude projects directory
  if (fs.existsSync(claudeBase)) {
    try {
      const watcher = fs.watch(claudeBase, { recursive: true }, (_eventType, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return
        const key = `claude:${filename}`
        if (debounceTimers.has(key)) clearTimeout(debounceTimers.get(key)!)
        debounceTimers.set(key, setTimeout(() => {
          debounceTimers.delete(key)
          const filePath = path.join(claudeBase, filename)
          const dirName = path.dirname(filePath)
          const projectToSession = buildProjectToSessionMap(opts.getSessionMap)
          const sessionId = projectToSession.get(dirName) ?? null
          processNewLines(filePath, parseClaudeLine, store, sessionId, 'claude', opts.sendToRenderer)
        }, 100))
      })
      watchers.push(watcher)
    } catch (err) {
      console.warn('[usage-watcher] Failed to watch Claude projects:', err)
    }
  }

  // Watch Codex sessions directory
  if (fs.existsSync(codexBase)) {
    try {
      const watcher = fs.watch(codexBase, { recursive: true }, (_eventType, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return
        const key = `codex:${filename}`
        if (debounceTimers.has(key)) clearTimeout(debounceTimers.get(key)!)
        debounceTimers.set(key, setTimeout(() => {
          debounceTimers.delete(key)
          const filePath = path.join(codexBase, filename)
          processNewLines(filePath, parseCodexLine, store, null, 'codex', opts.sendToRenderer)
        }, 100))
      })
      watchers.push(watcher)
    } catch (err) {
      console.warn('[usage-watcher] Failed to watch Codex sessions:', err)
    }
  }
}

/**
 * Backfill existing JSONL files on first launch.
 */
function backfill(store: UsageStore, opts: WatcherOptions): void {
  const claudeBase = path.join(os.homedir(), '.claude', 'projects')
  const codexBase = path.join(os.homedir(), '.codex', 'sessions')
  const projectToSession = buildProjectToSessionMap(opts.getSessionMap)

  // Claude projects
  if (fs.existsSync(claudeBase)) {
    try {
      const projectDirs = fs.readdirSync(claudeBase)
      let processed = 0
      const total = projectDirs.length
      for (const dir of projectDirs) {
        const dirPath = path.join(claudeBase, dir)
        try {
          if (!fs.statSync(dirPath).isDirectory()) continue
        } catch { continue }
        const sessionId = projectToSession.get(dirPath) ?? null
        scanDirectory(dirPath, parseClaudeLine, store, sessionId, 'claude', opts.sendToRenderer)
        processed++
        if (processed % 5 === 0) {
          opts.sendToRenderer('latch:usage-backfill-progress', { current: processed, total })
        }
      }
    } catch { /* dir doesn't exist */ }
  }

  // Codex sessions
  if (fs.existsSync(codexBase)) {
    scanDirectory(codexBase, parseCodexLine, store, null, 'codex', opts.sendToRenderer)
  }
}

/**
 * Stop all file watchers. Call on app quit.
 */
export function stopUsageWatcher(): void {
  for (const w of watchers) {
    try { w.close() } catch { /* already closed */ }
  }
  watchers.length = 0
  for (const timer of debounceTimers.values()) clearTimeout(timer)
  debounceTimers.clear()
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit --project tsconfig.node.json 2>&1 | head -20`
Expected: No errors

**Step 3: Commit**

```bash
git add src/main/services/usage-watcher.ts
git commit -m "feat(observability): add UsageWatcher service for JSONL ingestion"
```

---

## Task 5: Wire Main Process — IPC Handlers & Initialization

**Files:**
- Modify: `src/main/index.ts`

**Step 1: Add store singleton and imports**

At the top of `src/main/index.ts`, add the import alongside the existing store imports:

```typescript
import { UsageStore } from './stores/usage-store'
import { startUsageWatcher, stopUsageWatcher } from './services/usage-watcher'
```

Near line ~90 (where other store singletons are declared), add:

```typescript
let usageStore: UsageStore | null = null
```

**Step 2: Initialize store in app.whenReady()**

Near line ~210 (after `serviceStore = ServiceStore.open(db)`), add:

```typescript
usageStore = UsageStore.open(db)
```

**Step 3: Start watcher after services are wired**

Near line ~254 (after supervisor/radar wiring), add:

```typescript
// Start usage watcher for JSONL ingestion
if (usageStore) {
  startUsageWatcher(usageStore, {
    getSessionMap: () => {
      const sessions = sessionStore.list()
      const map = new Map<string, string>()
      for (const s of sessions) {
        if (s.repo_root) map.set(s.id, s.repo_root)
      }
      return map
    },
    sendToRenderer,
  })
}
```

**Step 4: Add IPC handlers**

After the existing feed IPC handlers (around line ~797), add:

```typescript
// ── Usage / Observability ─────────────────────────────────────────────────

ipcMain.handle('latch:usage-list', async (_event: any, payload: any = {}) => {
  if (!usageStore) return { ok: false, events: [], total: 0 }
  const result = usageStore.list(payload)
  return { ok: true, ...result }
})

ipcMain.handle('latch:usage-summary', async (_event: any, payload: any = {}) => {
  if (!usageStore) return { ok: false, summary: null }
  const summary = usageStore.getSummary(payload)
  return { ok: true, summary }
})

ipcMain.handle('latch:usage-clear', async (_event: any, payload: any = {}) => {
  if (!usageStore) return { ok: false }
  usageStore.clear(payload?.sessionId)
  return { ok: true }
})

ipcMain.handle('latch:usage-export', async (_event: any, payload: any = {}) => {
  if (!usageStore) return { ok: false, error: 'Usage store unavailable' }
  const { dialog } = await import('electron')
  const format = payload?.format === 'csv' ? 'csv' : 'json'
  const events = usageStore.exportAll(payload?.sessionId)

  const { filePath, canceled } = await dialog.showSaveDialog({
    defaultPath: `latch-usage-export.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  })
  if (canceled || !filePath) return { ok: false, error: 'Cancelled' }

  let content: string
  if (format === 'csv') {
    const header = 'id,session_id,harness_id,model,timestamp,input_tokens,output_tokens,cache_write_tokens,cache_read_tokens,cost_usd,tool_name\n'
    const rows = events.map((e) =>
      `${e.id},${e.sessionId ?? ''},${e.harnessId},${e.model},${e.timestamp},${e.inputTokens},${e.outputTokens},${e.cacheWriteTokens},${e.cacheReadTokens},${e.costUsd},${e.toolName ?? ''}`
    ).join('\n')
    content = header + rows
  } else {
    content = JSON.stringify(events, null, 2)
  }

  await fs.promises.writeFile(filePath, content, 'utf8')
  return { ok: true, filePath, count: events.length }
})
```

**Step 5: Add cleanup on quit**

In the `app.on('will-quit')` handler (or `app.on('before-quit')`), add:

```typescript
stopUsageWatcher()
```

**Step 6: Verify it compiles**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit --project tsconfig.node.json 2>&1 | head -20`
Expected: No errors

**Step 7: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(observability): wire UsageStore + UsageWatcher + IPC handlers in main process"
```

---

## Task 6: Preload Bridge

**Files:**
- Modify: `src/preload/index.ts`

**Step 1: Add usage methods to contextBridge**

After the existing feed methods (around line ~366), add:

```typescript
// ── Usage / Observability ───────────────────────────────────────────────
listUsage: (payload?: { sessionId?: string; limit?: number; offset?: number }) =>
  ipcRenderer.invoke('latch:usage-list', payload),

getUsageSummary: (payload?: { days?: number; sessionId?: string }) =>
  ipcRenderer.invoke('latch:usage-summary', payload),

clearUsage: (payload?: { sessionId?: string }) =>
  ipcRenderer.invoke('latch:usage-clear', payload),

exportUsage: (payload?: { sessionId?: string; format?: 'json' | 'csv' }) =>
  ipcRenderer.invoke('latch:usage-export', payload),

onUsageEvent: (callback: (event: any) => void) => {
  const handler = (_event: any, payload: any) => callback(payload)
  ipcRenderer.on('latch:usage-event', handler)
  return () => { ipcRenderer.removeListener('latch:usage-event', handler) }
},

onUsageBackfillProgress: (callback: (progress: { current: number; total: number }) => void) => {
  const handler = (_event: any, payload: any) => callback(payload)
  ipcRenderer.on('latch:usage-backfill-progress', handler)
  return () => { ipcRenderer.removeListener('latch:usage-backfill-progress', handler) }
},
```

**Step 2: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(observability): expose usage IPC methods via preload bridge"
```

---

## Task 7: Zustand Store

**Files:**
- Modify: `src/renderer/store/useAppStore.ts`

**Step 1: Add state fields**

In the state interface (near line ~161, after the feed fields), add:

```typescript
// Usage / Observability
usageEvents: UsageEvent[]
usageSummary: UsageSummary | null
usageLoading: boolean
```

**Step 2: Add action method signatures**

In the action methods section (near line ~279, after feed actions), add:

```typescript
loadUsageView: () => Promise<void>
handleUsageEvent: (event: UsageEvent) => void
clearUsage: () => Promise<void>
exportUsage: () => Promise<void>
```

**Step 3: Add initial state values**

In the initial state (near line ~323, after feed initializers), add:

```typescript
usageEvents: [],
usageSummary: null,
usageLoading: false,
```

**Step 4: Add action implementations**

After the existing `clearFeed` implementation (near line ~1375), add:

```typescript
// ── Usage / Observability ───────────────────────────────────────────────

loadUsageView: async () => {
  set({ usageLoading: true })
  const [listResult, summaryResult] = await Promise.all([
    window.latch?.listUsage?.({ limit: 200 }),
    window.latch?.getUsageSummary?.({ days: 30 }),
  ])
  set({
    usageEvents: listResult?.events ?? [],
    usageSummary: summaryResult?.summary ?? null,
    usageLoading: false,
  })
},

handleUsageEvent: (event) => {
  set((s) => {
    // Prepend event, cap at 500
    const usageEvents = [event, ...s.usageEvents].slice(0, 500)

    // Incrementally update summary if loaded
    let usageSummary = s.usageSummary
    if (usageSummary) {
      usageSummary = {
        ...usageSummary,
        todayCostUsd: usageSummary.todayCostUsd + event.costUsd,
        todayInputTokens: usageSummary.todayInputTokens + event.inputTokens,
        todayOutputTokens: usageSummary.todayOutputTokens + event.outputTokens,
      }
    }

    return { usageEvents, usageSummary }
  })
},

clearUsage: async () => {
  await window.latch?.clearUsage?.()
  set({ usageEvents: [], usageSummary: null })
},

exportUsage: async () => {
  await window.latch?.exportUsage?.({ format: 'json' })
},
```

**Step 5: Add import for UsageEvent and UsageSummary**

Ensure the import at the top of useAppStore.ts includes the new types:

```typescript
import type { ..., UsageEvent, UsageSummary } from '../../types'
```

**Step 6: Commit**

```bash
git add src/renderer/store/useAppStore.ts
git commit -m "feat(observability): add usage state and actions to Zustand store"
```

---

## Task 8: App.tsx — Event Listener + Route

**Files:**
- Modify: `src/renderer/App.tsx`

**Step 1: Add import**

At the top with the other view imports (around line ~26), add:

```typescript
import UsageView from './components/UsageView'
```

**Step 2: Add handleUsageEvent to destructured store**

In the `useAppStore()` destructure (around line ~58), add `handleUsageEvent`:

```typescript
const {
  // ... existing
  handleUsageEvent,
} = useAppStore()
```

**Step 3: Register usage event listener**

In the `useEffect` boot block (around line ~107, after the feed listener), add:

```typescript
// Register usage event listener
const disposeUsageEvent = window.latch?.onUsageEvent?.((event) => {
  handleUsageEvent(event)
})
```

And in the cleanup return (around line ~130), add:

```typescript
disposeUsageEvent?.()
```

**Step 4: Add view routing**

In the view routing block (around line ~226, after the `radar` route), add:

```typescript
} else if (activeView === 'usage') {
  mainContent = <UsageView />
```

**Step 5: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat(observability): wire UsageView route and usage event listener in App.tsx"
```

---

## Task 9: Sidebar Restructure

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`
- Modify: `src/renderer/styles.css`

**Step 1: Add ChartBar import to Sidebar.tsx**

Update the Phosphor icons import (line 2):

```typescript
import { Terminal, Broadcast, Lock, Robot, HardDrives, Gear, BookOpenText, Target, Plugs, ShieldCheck, ChartBar } from '@phosphor-icons/react'
```

**Step 2: Replace the nav section with grouped sections**

Replace the `<nav className="sidebar-nav">` block (lines 79-142) with:

```tsx
<nav className="sidebar-nav">
  {/* ── Home ─────────────────────────────── */}
  <button
    className={`sidebar-nav-item${activeView === 'home' && !activeSessionId ? ' is-active' : ''}`}
    onClick={() => setActiveView('home')}
  >
    <Terminal className="sidebar-nav-icon" weight="light" />
    Home
  </button>
  <button
    className={`sidebar-nav-item${activeView === 'feed' ? ' is-active' : ''}`}
    onClick={() => setActiveView('feed')}
  >
    <Broadcast className="sidebar-nav-icon" weight="light" />
    Feed
    {feedUnread > 0 && <span className="sidebar-badge">{feedUnread > 99 ? '99+' : feedUnread}</span>}
  </button>

  {/* ── Observe ──────────────────────────── */}
  <div className="sidebar-nav-group-label">Observe</div>
  <button
    className={`sidebar-nav-item${activeView === 'usage' ? ' is-active' : ''}`}
    onClick={() => setActiveView('usage')}
  >
    <ChartBar className="sidebar-nav-icon" weight="light" />
    Usage
  </button>
  <button
    className={`sidebar-nav-item${activeView === 'radar' ? ' is-active' : ''}`}
    onClick={() => setActiveView('radar')}
  >
    <Target className="sidebar-nav-icon" weight="light" />
    Radar
    {radarSignals.length > 0 && (
      <span className={`sidebar-badge${radarSignals.some((s) => s.level === 'high') ? ' is-alert' : ''}`}>
        {radarSignals.length}
      </span>
    )}
  </button>

  {/* ── Govern ───────────────────────────── */}
  <div className="sidebar-nav-group-label">Govern</div>
  <button
    className={`sidebar-nav-item${activeView === 'policies' ? ' is-active' : ''}`}
    onClick={() => setActiveView('policies')}
  >
    <Lock className="sidebar-nav-icon" weight="light" />
    Policies
  </button>
  <button
    className={`sidebar-nav-item${activeView === 'gateway' ? ' is-active' : ''}`}
    onClick={() => setActiveView('gateway')}
  >
    <ShieldCheck className="sidebar-nav-icon" weight="light" />
    Gateway
  </button>
  <button
    className={`sidebar-nav-item${activeView === 'services' ? ' is-active' : ''}`}
    onClick={() => setActiveView('services')}
  >
    <Plugs className="sidebar-nav-icon" weight="light" />
    Services
  </button>

  {/* ── Build ────────────────────────────── */}
  <div className="sidebar-nav-group-label">Build</div>
  <button
    className={`sidebar-nav-item${activeView === 'agents' ? ' is-active' : ''}`}
    onClick={() => setActiveView('agents')}
  >
    <Robot className="sidebar-nav-icon" weight="light" />
    Agents
  </button>
  <button
    className={`sidebar-nav-item${activeView === 'mcp' ? ' is-active' : ''}`}
    onClick={() => setActiveView('mcp')}
  >
    <HardDrives className="sidebar-nav-icon" weight="light" />
    MCP
  </button>
</nav>
```

**Step 3: Add sidebar group label CSS**

In `src/renderer/styles.css`, after the `.sidebar-nav-item:hover .sidebar-nav-icon` rule (around line ~2777), add:

```css
/* ── Sidebar group labels ──────────────────────────────────────────────── */

.sidebar-nav-group-label {
  font-size: 10px;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--text-tertiary);
  padding: 12px 10px 4px;
  margin-top: 4px;
  user-select: none;
}
```

**Step 4: Commit**

```bash
git add src/renderer/components/Sidebar.tsx src/renderer/styles.css
git commit -m "feat(observability): restructure sidebar with Observe/Govern/Build groups + Usage nav item"
```

---

## Task 10: UsageView Component

**Files:**
- Create: `src/renderer/components/UsageView.tsx`
- Modify: `src/renderer/styles.css`

**Step 1: Create the UsageView component**

```tsx
// src/renderer/components/UsageView.tsx

/**
 * @module UsageView
 * @description Token cost and usage dashboard — the observability hero view.
 * Shows stat cards, daily spend sparkline, model mix bar, and session breakdown.
 */

import React, { useEffect, useMemo } from 'react'
import { ChartBar } from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  return `$${usd.toFixed(2)}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

function formatPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

function cacheColor(ratio: number): string {
  if (ratio >= 0.7) return 'var(--success)'
  if (ratio >= 0.4) return 'var(--warning)'
  return 'var(--error)'
}

const MODEL_COLORS: Record<string, string> = {
  opus: 'rgb(var(--d-blue))',
  sonnet: 'rgb(var(--d-green))',
  haiku: 'rgba(255,255,255,0.35)',
  gpt: 'rgb(var(--d-yellow))',
  o3: 'rgb(var(--d-yellow))',
  o4: 'rgb(var(--d-yellow))',
}

function modelColor(model: string): string {
  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (model.includes(key)) return color
  }
  return 'rgba(255,255,255,0.2)'
}

function modelShortName(model: string): string {
  return model
    .replace('claude-', '')
    .replace('gpt-', '')
    .replace('-codex', '')
}

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

// ── Component ───────────────────────────────────────────────────────────────

export default function UsageView() {
  const {
    usageSummary,
    usageLoading,
    loadUsageView,
    clearUsage,
    exportUsage,
    sessions,
  } = useAppStore()

  useEffect(() => {
    loadUsageView()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived data ──────────────────────────────────────────────────────

  // Aggregate daily summaries by date for sparkline (last 7 days)
  const dailyBars = useMemo(() => {
    if (!usageSummary) return []
    const byDate = new Map<string, number>()
    for (const ds of usageSummary.dailySummaries) {
      byDate.set(ds.date, (byDate.get(ds.date) ?? 0) + ds.totalCostUsd)
    }

    const bars: { date: string; cost: number; dayLabel: string }[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000)
      const dateStr = d.toISOString().slice(0, 10)
      bars.push({
        date: dateStr,
        cost: byDate.get(dateStr) ?? 0,
        dayLabel: DAY_LABELS[d.getDay()],
      })
    }
    return bars
  }, [usageSummary])

  const weekTotal = useMemo(() => dailyBars.reduce((s, b) => s + b.cost, 0), [dailyBars])
  const maxDayCost = useMemo(() => Math.max(...dailyBars.map((b) => b.cost), 0.01), [dailyBars])

  // Model mix
  const modelMix = useMemo(() => {
    if (!usageSummary) return []
    const total = usageSummary.modelSummaries.reduce((s, m) => s + m.totalCostUsd, 0)
    if (total === 0) return []
    return usageSummary.modelSummaries.map((m) => ({
      ...m,
      pct: m.totalCostUsd / total,
      color: modelColor(m.model),
      shortName: modelShortName(m.model),
    }))
  }, [usageSummary])

  // Session summaries with names resolved
  const sessionCards = useMemo(() => {
    if (!usageSummary) return []
    const maxCost = Math.max(...usageSummary.sessionSummaries.map((s) => s.totalCostUsd), 0.01)
    return usageSummary.sessionSummaries.map((s) => {
      let name = s.sessionName
      if (!name && s.sessionId) {
        const session = sessions.get(s.sessionId)
        name = session?.name ?? null
      }
      return {
        ...s,
        displayName: name ?? s.sessionId ?? 'Untracked',
        costRatio: s.totalCostUsd / maxCost,
        isUntracked: !s.sessionId,
      }
    })
  }, [usageSummary, sessions])

  const trackedSessions = useMemo(() => sessionCards.filter((s) => !s.isUntracked), [sessionCards])
  const untrackedSessions = useMemo(() => sessionCards.filter((s) => s.isUntracked), [sessionCards])

  // ── Render ────────────────────────────────────────────────────────────

  if (usageLoading && !usageSummary) {
    return (
      <div className="view-container">
        <div className="view-header">
          <h1 className="view-title">Usage</h1>
        </div>
        <div className="usage-empty">
          <span className="usage-empty-text">Loading usage data...</span>
        </div>
      </div>
    )
  }

  const summary = usageSummary

  return (
    <div className="view-container">
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="view-header">
        <h1 className="view-title">Usage</h1>
        <div className="view-header-actions">
          <button className="view-action-btn" onClick={exportUsage}>Export</button>
          <button className="view-action-btn" onClick={clearUsage}>Clear</button>
        </div>
      </div>

      {!summary || (summary.todayCostUsd === 0 && summary.sessionSummaries.length === 0) ? (
        <div className="usage-empty">
          <ChartBar size={48} weight="light" className="usage-empty-icon" />
          <span className="usage-empty-text">No usage data yet</span>
          <span className="usage-empty-hint">
            Start a session with Claude Code or Codex and usage will appear here automatically.
          </span>
        </div>
      ) : (
        <>
          {/* ── Stat cards ──────────────────────────────────────── */}
          <div className="usage-stats-grid">
            <div className="usage-stat-card">
              <div className="usage-stat-value">{formatCost(summary.todayCostUsd)}</div>
              <div className="usage-stat-label">Today</div>
            </div>
            <div className="usage-stat-card">
              <div className="usage-stat-value">{formatTokens(summary.todayInputTokens)}</div>
              <div className="usage-stat-label">Input</div>
            </div>
            <div className="usage-stat-card">
              <div className="usage-stat-value">{formatTokens(summary.todayOutputTokens)}</div>
              <div className="usage-stat-label">Output</div>
            </div>
            <div className="usage-stat-card">
              <div className="usage-stat-value" style={{ color: cacheColor(summary.cacheEfficiency) }}>
                {formatPct(summary.cacheEfficiency)}
              </div>
              <div className="usage-stat-label">Cache</div>
            </div>
          </div>

          {/* ── Daily sparkline ─────────────────────────────────── */}
          <div className="usage-section">
            <div className="view-section-label">Daily Spend</div>
            <div className="usage-sparkline-container">
              <div className="usage-sparkline">
                {dailyBars.map((bar) => (
                  <div key={bar.date} className="usage-spark-col" title={`${bar.date}: ${formatCost(bar.cost)}`}>
                    <div
                      className="usage-spark-bar"
                      style={{
                        height: `${Math.max((bar.cost / maxDayCost) * 100, 2)}%`,
                        opacity: bar.cost > 0 ? 0.4 + (bar.cost / maxDayCost) * 0.6 : 0.15,
                      }}
                    />
                    <span className="usage-spark-label">{bar.dayLabel}</span>
                  </div>
                ))}
              </div>
              <div className="usage-sparkline-total">
                <span className="usage-sparkline-total-value">{formatCost(weekTotal)}</span>
                <span className="usage-sparkline-total-label">this week</span>
              </div>
            </div>
          </div>

          {/* ── Model mix ──────────────────────────────────────── */}
          {modelMix.length > 0 && (
            <div className="usage-section">
              <div className="view-section-label">Model Mix</div>
              <div className="usage-model-bar">
                {modelMix.map((m) => (
                  <div
                    key={m.model}
                    className="usage-model-segment"
                    style={{ width: `${m.pct * 100}%`, background: m.color }}
                    title={`${m.shortName}: ${formatCost(m.totalCostUsd)}`}
                  />
                ))}
              </div>
              <div className="usage-model-legend">
                {modelMix.map((m) => (
                  <span key={m.model} className="usage-model-legend-item">
                    <span className="usage-model-dot" style={{ background: m.color }} />
                    {m.shortName} {formatCost(m.totalCostUsd)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* ── Session breakdown ──────────────────────────────── */}
          {trackedSessions.length > 0 && (
            <div className="usage-section">
              <div className="view-section-label">Sessions</div>
              <div className="usage-session-list">
                {trackedSessions.map((s) => (
                  <div key={`${s.sessionId}-${s.harnessId}`} className="usage-session-card">
                    <div className="usage-session-header">
                      <span className="usage-session-name">{s.displayName}</span>
                      <span className={`usage-session-harness is-${s.harnessId}`}>
                        <span className="usage-harness-dot" />
                        {s.harnessId}
                      </span>
                    </div>
                    <div className="usage-session-bar-row">
                      <div className="usage-session-bar-track">
                        <div
                          className="usage-session-bar-fill"
                          style={{ width: `${s.costRatio * 100}%` }}
                        />
                      </div>
                      <span className="usage-session-cost">{formatCost(s.totalCostUsd)}</span>
                    </div>
                    <div className="usage-session-meta">
                      <span>{formatTokens(s.totalInput)} in</span>
                      <span>{formatTokens(s.totalOutput)} out</span>
                      {s.totalCacheRead > 0 && (
                        <span>
                          {formatPct(s.totalCacheRead / Math.max(s.totalInput + s.totalCacheWrite + s.totalCacheRead, 1))} cache
                        </span>
                      )}
                      <span>{s.models.map(modelShortName).join(', ')}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Untracked ──────────────────────────────────────── */}
          {untrackedSessions.length > 0 && (
            <div className="usage-section">
              <div className="view-section-label">
                Untracked Sessions
                <span className="usage-untracked-count">{untrackedSessions.length}</span>
              </div>
              <div className="usage-session-list">
                {untrackedSessions.map((s, i) => (
                  <div key={i} className="usage-session-card is-untracked">
                    <div className="usage-session-header">
                      <span className="usage-session-name">{s.displayName}</span>
                      <span className={`usage-session-harness is-${s.harnessId}`}>
                        <span className="usage-harness-dot" />
                        {s.harnessId}
                      </span>
                    </div>
                    <div className="usage-session-bar-row">
                      <div className="usage-session-bar-track">
                        <div
                          className="usage-session-bar-fill"
                          style={{ width: `${s.costRatio * 100}%` }}
                        />
                      </div>
                      <span className="usage-session-cost">{formatCost(s.totalCostUsd)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
```

**Step 2: Add CSS styles**

At the end of `src/renderer/styles.css`, add the usage view styles:

```css
/* ── Usage View ────────────────────────────────────────────────────────────── */

.usage-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 80px 0;
  text-align: center;
}

.usage-empty-icon {
  color: var(--text-tertiary);
  margin-bottom: 8px;
}

.usage-empty-text {
  font-size: 14px;
  color: var(--text-secondary);
}

.usage-empty-hint {
  font-size: 12px;
  color: var(--text-tertiary);
  max-width: 320px;
  line-height: 1.5;
}

/* ── Stat cards ──────────────────────────────────────────────────────────── */

.usage-stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 24px;
}

.usage-stat-card {
  padding: 16px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-card);
  text-align: center;
  transition: background 120ms ease;
}

.usage-stat-value {
  font-size: 28px;
  font-weight: 400;
  font-family: var(--font-pixel-square);
  color: var(--text-primary);
  line-height: 1.2;
  transition: color 200ms ease;
}

.usage-stat-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-tertiary);
  margin-top: 4px;
  font-family: var(--font-mono);
}

/* ── Section ─────────────────────────────────────────────────────────────── */

.usage-section {
  margin-bottom: 24px;
}

/* ── Sparkline ───────────────────────────────────────────────────────────── */

.usage-sparkline-container {
  display: flex;
  align-items: flex-end;
  gap: 20px;
  padding: 16px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-card);
}

.usage-sparkline {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  flex: 1;
  height: 64px;
}

.usage-spark-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  justify-content: flex-end;
  gap: 4px;
  cursor: default;
}

.usage-spark-bar {
  width: 100%;
  background: var(--text-primary);
  border-radius: 2px 2px 0 0;
  min-height: 2px;
  transition: height 300ms ease, opacity 300ms ease;
}

.usage-spark-label {
  font-size: 9px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  text-transform: uppercase;
}

.usage-sparkline-total {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex-shrink: 0;
}

.usage-sparkline-total-value {
  font-size: 20px;
  font-family: var(--font-pixel-square);
  color: var(--text-primary);
}

.usage-sparkline-total-label {
  font-size: 9px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

/* ── Model mix bar ───────────────────────────────────────────────────────── */

.usage-model-bar {
  display: flex;
  height: 8px;
  border-radius: 4px;
  overflow: hidden;
  background: rgba(255,255,255,0.05);
}

.usage-model-segment {
  transition: width 400ms ease;
  min-width: 2px;
}

.usage-model-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 10px;
}

.usage-model-legend-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-secondary);
}

.usage-model-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

/* ── Session cards ───────────────────────────────────────────────────────── */

.usage-session-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  overflow: hidden;
}

.usage-session-card {
  padding: 12px 16px;
  background: var(--bg-card);
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: background 120ms ease;
}

.usage-session-card:hover {
  background: var(--bg-card-hover);
}

.usage-session-card.is-untracked {
  opacity: 0.7;
}

.usage-session-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.usage-session-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-session-harness {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  flex-shrink: 0;
}

.usage-harness-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-tertiary);
}

.usage-session-harness.is-claude .usage-harness-dot { background: rgb(var(--d-blue)); }
.usage-session-harness.is-codex .usage-harness-dot { background: rgb(var(--d-yellow)); }
.usage-session-harness.is-openclaw .usage-harness-dot { background: rgb(var(--d-green)); }

.usage-session-bar-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.usage-session-bar-track {
  flex: 1;
  height: 4px;
  background: rgba(255,255,255,0.05);
  border-radius: 2px;
  overflow: hidden;
}

.usage-session-bar-fill {
  height: 100%;
  background: var(--text-primary);
  border-radius: 2px;
  opacity: 0.5;
  transition: width 400ms ease;
}

.usage-session-cost {
  font-size: 13px;
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--text-primary);
  flex-shrink: 0;
  min-width: 56px;
  text-align: right;
}

.usage-session-meta {
  display: flex;
  gap: 10px;
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
}

.usage-untracked-count {
  margin-left: 8px;
  font-size: 10px;
  font-weight: 700;
  min-width: 18px;
  height: 18px;
  line-height: 18px;
  text-align: center;
  border-radius: 9px;
  background: rgba(255,255,255,0.08);
  color: var(--text-tertiary);
  padding: 0 5px;
  display: inline-block;
}
```

**Step 3: Commit**

```bash
git add src/renderer/components/UsageView.tsx src/renderer/styles.css
git commit -m "feat(observability): add UsageView component with stat cards, sparkline, model mix, session breakdown"
```

---

## Task 11: Smoke Test

**Step 1: Run the type checker**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit 2>&1 | head -40`
Expected: No errors

**Step 2: Launch the app in dev mode**

Run: `cd /Users/cbryant/code/latch-core && npm run dev`

**Step 3: Manual verification checklist**

- [ ] Sidebar shows grouped sections: Observe (Usage, Radar), Govern (Policies, Gateway, Services), Build (Agents, MCP)
- [ ] Clicking "Usage" in the sidebar opens the UsageView
- [ ] If you have existing Claude Code JSONL data in `~/.claude/projects/`, the backfill should populate data
- [ ] Stat cards show today's cost, input tokens, output tokens, cache efficiency
- [ ] Daily sparkline shows last 7 days
- [ ] Model mix bar shows model breakdown with colors
- [ ] Session cards show cost bars and token breakdowns
- [ ] Export button opens a file save dialog
- [ ] Clear button clears all data
- [ ] Starting a new Claude Code session and working generates real-time usage events

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(observability): smoke test fixes"
```

---

## Summary

| Task | Component | Files | Estimated Effort |
|------|-----------|-------|-----------------|
| 1 | Pricing Engine | `src/main/lib/pricing.ts` | Small |
| 2 | Types | `src/types/index.ts` | Small |
| 3 | Usage Store | `src/main/stores/usage-store.ts` | Medium |
| 4 | Usage Watcher | `src/main/services/usage-watcher.ts` | Large |
| 5 | Main Process Wiring | `src/main/index.ts` | Medium |
| 6 | Preload Bridge | `src/preload/index.ts` | Small |
| 7 | Zustand Store | `src/renderer/store/useAppStore.ts` | Small |
| 8 | App.tsx Route | `src/renderer/App.tsx` | Small |
| 9 | Sidebar Restructure | `Sidebar.tsx` + `styles.css` | Medium |
| 10 | UsageView Component | `UsageView.tsx` + `styles.css` | Large |
| 11 | Smoke Test | All | Medium |

**Total: 11 tasks, 4 new files, 7 modified files.**
