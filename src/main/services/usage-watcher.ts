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
import { calculateCost, normalizeModelId } from '../lib/pricing'

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
  return repoRoot.replace(/\//g, '-')
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
function parseClaudeLine(line: string): {
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
      inputTokens: Math.max((info.input_tokens ?? 0) - (info.cached_input_tokens ?? 0), 0),
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

type LineParseFn = (line: string) => ReturnType<typeof parseClaudeLine>

/**
 * Read new bytes from a file since last offset, parse lines, record events.
 */
function processNewLines(
  filePath: string,
  parseFn: LineParseFn,
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

  // Parse all lines and keep only the LAST entry per requestId —
  // Claude Code writes multiple streaming chunks per request, and
  // the final chunk has the complete output token count.
  const parsed: NonNullable<ReturnType<LineParseFn>>[] = []
  const seenReqIdx = new Map<string, number>()
  for (const line of lines) {
    const p = parseFn(line)
    if (!p) continue
    if (p.requestId) {
      const prev = seenReqIdx.get(p.requestId)
      if (prev !== undefined) {
        parsed[prev] = p // overwrite earlier chunk with later (more complete) one
        continue
      }
      seenReqIdx.set(p.requestId, parsed.length)
    }
    parsed.push(p)
  }

  let stored = 0
  for (const p of parsed) {
    // Dedup against DB (across file reads)
    if (p.requestId && store.isDuplicate(filePath, p.requestId)) continue
    stored++

    const normalizedModel = normalizeModelId(p.model)
    const costUsd = calculateCost({
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      cacheWriteTokens: p.cacheWriteTokens,
      cacheReadTokens: p.cacheReadTokens,
    }, p.model)

    const event = store.record({
      sessionId,
      harnessId,
      model: normalizedModel,
      timestamp: p.timestamp,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      cacheWriteTokens: p.cacheWriteTokens,
      cacheReadTokens: p.cacheReadTokens,
      costUsd,
      toolName: p.toolName,
      sourceFile: filePath,
      requestId: p.requestId,
    })

    sendToRenderer('latch:usage-event', event)
  }
  if (stored > 0) {
    console.log(`[usage-watcher] ${filePath}: stored ${stored} events from ${lines.length} lines`)
  }
}

/**
 * Scan a directory for .jsonl files and process them.
 */
function scanDirectory(
  dirPath: string,
  parseFn: LineParseFn,
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
  try {
    _startUsageWatcher(store, opts)
  } catch (err) {
    console.error('[usage-watcher] Fatal error during startup:', err)
  }
}

function _startUsageWatcher(store: UsageStore, opts: WatcherOptions): void {
  const claudeBase = path.join(os.homedir(), '.claude', 'projects')
  const codexBase = path.join(os.homedir(), '.codex', 'sessions')
  console.log(`[usage-watcher] Starting — claudeBase=${claudeBase}, exists=${fs.existsSync(claudeBase)}`)

  // Initial backfill — scan all existing JSONL files
  backfill(store, opts, claudeBase, codexBase)

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
          const projectSlug = path.basename(dirName)
          const sessionId = projectToSession.get(dirName) ?? `project:${projectSlug}`
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
function backfill(store: UsageStore, opts: WatcherOptions, claudeBase: string, codexBase: string): void {
  let projectToSession: Map<string, string>
  try {
    projectToSession = buildProjectToSessionMap(opts.getSessionMap)
  } catch (err) {
    console.error('[usage-watcher] Failed to build session map:', err)
    projectToSession = new Map()
  }

  // Claude projects
  if (fs.existsSync(claudeBase)) {
    try {
      const projectDirs = fs.readdirSync(claudeBase)
      let processed = 0
      const total = projectDirs.length
      console.log(`[usage-watcher] Backfilling ${total} Claude project dirs from ${claudeBase}`)
      for (const dir of projectDirs) {
        const dirPath = path.join(claudeBase, dir)
        try {
          if (!fs.statSync(dirPath).isDirectory()) continue
        } catch { continue }
        const sessionId = projectToSession.get(dirPath) ?? `project:${dir}`
        scanDirectory(dirPath, parseClaudeLine, store, sessionId, 'claude', opts.sendToRenderer)
        processed++
        if (processed % 5 === 0) {
          opts.sendToRenderer('latch:usage-backfill-progress', { current: processed, total })
        }
      }
      console.log(`[usage-watcher] Backfill complete: processed ${processed} project dirs`)
    } catch (err) {
      console.warn('[usage-watcher] Backfill error:', err)
    }
  } else {
    console.log(`[usage-watcher] Claude base dir not found: ${claudeBase}`)
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
