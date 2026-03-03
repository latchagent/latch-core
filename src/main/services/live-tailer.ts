// src/main/services/live-tailer.ts

/**
 * @module live-tailer
 * @description Tails active Claude Code JSONL files in real-time, extracts
 * thinking summaries and tool call details, and emits unified LiveEvent
 * objects to the renderer. Works alongside usage-watcher (which handles
 * cost/token tracking) — this service focuses on the richer trace data.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import type { LiveEvent, LiveSessionStatus, LeakMatch } from '../../types'
import { scanForLeaks } from '../lib/leak-scanner'

// ── Configuration ───────────────────────────────────────────────────────────

const DEBOUNCE_MS = 80
const GAP_THRESHOLD_MS = 30_000
const IDLE_THRESHOLD_MS = 10_000

// ── State ───────────────────────────────────────────────────────────────────

interface TailState {
  filePath: string
  offset: number
  sessionId: string
  lastEventTs: number
  status: LiveSessionStatus
  turnIndex: number
}

const tails = new Map<string, TailState>()
const watchers = new Map<string, fs.FSWatcher>()
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

let _sendToRenderer: ((channel: string, payload: unknown) => void) | null = null
let _onLeakDetected: ((sessionId: string, leak: LeakMatch) => void) | null = null
let _onFileWrite: ((sessionId: string, filePath: string) => void) | null = null
let _onTurnUpdate: ((sessionId: string, turnIndex: number, thinkingSummary?: string) => void) | null = null
let _onPrompt: ((sessionId: string) => void) | null = null
let statusInterval: ReturnType<typeof setInterval> | null = null

// ── Helpers ─────────────────────────────────────────────────────────────────

function uid(): string {
  return `live-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
}

function emit(event: LiveEvent): void {
  _sendToRenderer?.('latch:live-event', event)
}

function claudeSlug(repoRoot: string): string {
  return repoRoot.replace(/[/.]/g, '-')
}

/**
 * Extract thinking summary from an assistant message's content blocks.
 */
function extractThinking(content: unknown[]): string | null {
  if (!Array.isArray(content)) return null
  for (const block of content) {
    const b = block as Record<string, unknown>
    if (b.type === 'thinking' && typeof b.thinking === 'string') {
      const text = (b.thinking as string).trim()
      if (text.length === 0) continue
      return text.length > 200 ? text.slice(0, 197) + '...' : text
    }
  }
  return null
}

/**
 * Extract tool call target (file path, command, pattern) from tool input.
 */
function extractTarget(toolName: string, toolInput: Record<string, unknown>): string | null {
  const fp = toolInput?.file_path ?? toolInput?.path
  if (fp && typeof fp === 'string') return fp
  const cmd = toolInput?.command
  if (cmd && typeof cmd === 'string') {
    return cmd.length > 100 ? cmd.slice(0, 97) + '...' : cmd
  }
  const pattern = toolInput?.pattern
  if (pattern && typeof pattern === 'string') return pattern
  const query = toolInput?.query
  if (query && typeof query === 'string') return query
  return null
}

// ── JSONL Parsing ───────────────────────────────────────────────────────────

/**
 * Process new bytes from a tailed JSONL file.
 */
function processNewData(state: TailState): void {
  let stat: fs.Stats
  try {
    stat = fs.statSync(state.filePath)
  } catch {
    return
  }
  if (stat.size <= state.offset) return

  const fd = fs.openSync(state.filePath, 'r')
  const buf = Buffer.alloc(stat.size - state.offset)
  fs.readSync(fd, buf, 0, buf.length, state.offset)
  fs.closeSync(fd)
  state.offset = stat.size

  const text = buf.toString('utf8')
  const lines = text.split('\n').filter(l => l.trim())

  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      processJsonlEntry(obj, state)
    } catch {
      // Skip malformed lines
    }
  }
}

/**
 * Process a single JSONL entry and emit LiveEvents.
 */
function processJsonlEntry(obj: Record<string, unknown>, state: TailState): void {
  const type = obj.type as string
  const timestamp = (obj.timestamp as string) ?? new Date().toISOString()
  const now = Date.now()

  // Check for rate-limit gap
  if (state.lastEventTs > 0) {
    const gap = now - state.lastEventTs
    if (gap >= GAP_THRESHOLD_MS && state.status !== 'rate-limited') {
      state.status = 'rate-limited'
      emit({
        id: uid(),
        sessionId: state.sessionId,
        timestamp,
        kind: 'status-change',
        sessionStatus: 'rate-limited',
      })
      emit({
        id: uid(),
        sessionId: state.sessionId,
        timestamp,
        kind: 'anomaly',
        anomalyKind: 'rate-limit',
        anomalyMessage: `${Math.round(gap / 1000)}s gap — possible rate limiting`,
      })
    }
  }
  state.lastEventTs = now

  // ── Human message = new turn
  if (type === 'human') {
    state.turnIndex++
    // Flush any pending checkpoint so previous work is captured before the new prompt
    _onPrompt?.(state.sessionId)
    if (state.status !== 'active') {
      state.status = 'active'
      emit({
        id: uid(),
        sessionId: state.sessionId,
        timestamp,
        kind: 'status-change',
        sessionStatus: 'active',
      })
    }
    return
  }

  // ── Assistant message = thinking + tool calls
  if (type === 'assistant') {
    const message = obj.message as Record<string, unknown> | undefined
    if (!message) return

    const content = message.content as unknown[]
    if (!Array.isArray(content)) return

    // Extract thinking
    const thinking = extractThinking(content)
    if (thinking) {
      emit({
        id: uid(),
        sessionId: state.sessionId,
        timestamp,
        kind: 'thinking',
        thinkingSummary: thinking,
      })
    }

    // Extract tool calls
    for (const block of content) {
      const b = block as Record<string, unknown>
      if (b.type !== 'tool_use') continue

      const toolName = (b.name as string) ?? 'unknown'
      const toolInput = (b.input as Record<string, unknown>) ?? {}
      const target = extractTarget(toolName, toolInput)

      emit({
        id: uid(),
        sessionId: state.sessionId,
        timestamp,
        kind: 'tool-call',
        toolName,
        target: target ?? undefined,
        status: 'running',
      })

      // Scan Write/Edit content for credential leaks
      const toolNameLower = toolName.toLowerCase()
      if (toolNameLower === 'write' || toolNameLower === 'edit') {
        const fileContent = (toolInput.content ?? toolInput.new_string ?? '') as string
        const filePath = (toolInput.file_path ?? toolInput.path ?? '') as string
        if (fileContent) {
          const leaks = scanForLeaks(fileContent, filePath || undefined)
          for (const leak of leaks) {
            emit({
              id: uid(),
              sessionId: state.sessionId,
              timestamp,
              kind: 'anomaly',
              anomalyKind: 'credential-leak',
              anomalyMessage: `Credential detected (${leak.kind}): ${leak.preview}${leak.filePath ? ` in ${leak.filePath}` : ''}`,
            })
            _onLeakDetected?.(state.sessionId, leak)
          }
        }
        // Notify checkpoint engine of file write + current turn index
        _onFileWrite?.(state.sessionId, filePath || toolName)
        _onTurnUpdate?.(state.sessionId, state.turnIndex, thinking ?? undefined)
      }
    }

    // Mark active
    if (state.status !== 'active') {
      state.status = 'active'
      emit({
        id: uid(),
        sessionId: state.sessionId,
        timestamp,
        kind: 'status-change',
        sessionStatus: 'active',
      })
    }
    return
  }

  // ── Tool result = completion
  if (type === 'tool_result') {
    const toolName = (obj.tool_name as string) ?? null
    const isError = obj.is_error === true

    if (toolName) {
      emit({
        id: uid(),
        sessionId: state.sessionId,
        timestamp,
        kind: 'tool-call',
        toolName,
        status: isError ? 'error' : 'success',
      })
    }
    return
  }
}

// ── Session Management ──────────────────────────────────────────────────────

/**
 * Find the most recent JSONL file in a Claude project directory.
 */
function findActiveJsonl(projectDir: string): string | null {
  try {
    const entries = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        path: path.join(projectDir, f),
        mtime: fs.statSync(path.join(projectDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)

    return entries.length > 0 ? entries[0].path : null
  } catch {
    return null
  }
}

/**
 * Start tailing a session's JSONL file.
 */
function startTail(sessionId: string, repoRoot: string): void {
  const slug = claudeSlug(repoRoot)
  const projectDir = path.join(os.homedir(), '.claude', 'projects', slug)

  // The project directory may not exist yet — Claude Code creates it on first
  // launch. If it's missing, watch the parent directory for it to appear.
  if (!fs.existsSync(projectDir)) {
    const parentDir = path.dirname(projectDir)
    try {
      const parentWatcher = fs.watch(parentDir, (_eventType, filename) => {
        if (filename === path.basename(projectDir) && fs.existsSync(projectDir)) {
          parentWatcher.close()
          startTail(sessionId, repoRoot)
        }
      })
      // Store so we can clean up
      watchers.set(`parent:${sessionId}`, parentWatcher)
    } catch { /* parent dir doesn't exist either — give up */ }
    return
  }

  const jsonlPath = findActiveJsonl(projectDir)

  // Skip to end of file if one exists (we only want new data)
  let offset = 0
  if (jsonlPath) {
    try {
      offset = fs.statSync(jsonlPath).size
    } catch { /* start from 0 */ }
  }

  const state: TailState = {
    filePath: jsonlPath ?? '',
    offset,
    sessionId,
    lastEventTs: Date.now(),
    status: 'active',
    turnIndex: 0,
  }
  tails.set(sessionId, state)

  // Watch the project directory for changes (including new JSONL files)
  try {
    const watcher = fs.watch(projectDir, { recursive: true }, (_eventType, filename) => {
      if (!filename?.endsWith('.jsonl')) return

      const key = `live:${sessionId}`
      if (debounceTimers.has(key)) clearTimeout(debounceTimers.get(key)!)
      debounceTimers.set(key, setTimeout(() => {
        debounceTimers.delete(key)

        // Pick up a new JSONL file or detect file change
        const currentActive = findActiveJsonl(projectDir)
        if (currentActive && currentActive !== state.filePath) {
          state.filePath = currentActive
          state.offset = 0
          state.turnIndex = 0
        }

        if (state.filePath) processNewData(state)
      }, DEBOUNCE_MS))
    })
    watchers.set(sessionId, watcher)
  } catch (err) {
    console.warn(`[live-tailer] Failed to watch ${projectDir}:`, err)
  }

  // Emit initial status
  emit({
    id: uid(),
    sessionId,
    timestamp: new Date().toISOString(),
    kind: 'status-change',
    sessionStatus: 'active',
  })
}

/**
 * Stop tailing a session.
 */
function stopTail(sessionId: string): void {
  tails.delete(sessionId)
  for (const key of [sessionId, `parent:${sessionId}`]) {
    const watcher = watchers.get(key)
    if (watcher) {
      try { watcher.close() } catch { /* already closed */ }
      watchers.delete(key)
    }
  }
  const key = `live:${sessionId}`
  if (debounceTimers.has(key)) {
    clearTimeout(debounceTimers.get(key)!)
    debounceTimers.delete(key)
  }
}

// ── Status Polling ──────────────────────────────────────────────────────────

/**
 * Periodically check for idle sessions (no events for IDLE_THRESHOLD_MS).
 */
function checkIdleStatus(): void {
  const now = Date.now()
  for (const [sessionId, state] of tails) {
    if (state.status === 'idle' || state.status === 'rate-limited') continue
    if (now - state.lastEventTs >= IDLE_THRESHOLD_MS) {
      state.status = 'idle'
      emit({
        id: uid(),
        sessionId,
        timestamp: new Date().toISOString(),
        kind: 'status-change',
        sessionStatus: 'idle',
      })
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface LiveTailerOptions {
  sendToRenderer: (channel: string, payload: unknown) => void
  getSessionMap: () => Map<string, string>
  onLeakDetected?: (sessionId: string, leak: LeakMatch) => void
  onFileWrite?: (sessionId: string, filePath: string) => void
  onTurnUpdate?: (sessionId: string, turnIndex: number, thinkingSummary?: string) => void
  onPrompt?: (sessionId: string) => void
}

/**
 * Initialize the live tailer. Call once from app.whenReady().
 */
export function startLiveTailer(opts: LiveTailerOptions): void {
  _sendToRenderer = opts.sendToRenderer
  _onLeakDetected = opts.onLeakDetected ?? null
  _onFileWrite = opts.onFileWrite ?? null
  _onTurnUpdate = opts.onTurnUpdate ?? null
  _onPrompt = opts.onPrompt ?? null

  // Start tailing all current sessions
  for (const [sessionId, repoRoot] of opts.getSessionMap()) {
    startTail(sessionId, repoRoot)
  }

  // Idle-check interval
  statusInterval = setInterval(checkIdleStatus, 5_000)

  console.log(`[live-tailer] Started, tailing ${tails.size} sessions`)
}

/**
 * Start tailing a new session (call when a session is created).
 */
export function liveTailerAddSession(sessionId: string, repoRoot: string): void {
  if (tails.has(sessionId)) return
  startTail(sessionId, repoRoot)
}

/**
 * Stop tailing a session (call when a session is closed).
 */
export function liveTailerRemoveSession(sessionId: string): void {
  stopTail(sessionId)
}

/**
 * Clean up all watchers. Call on app quit.
 */
export function stopLiveTailer(): void {
  if (statusInterval) {
    clearInterval(statusInterval)
    statusInterval = null
  }
  for (const sessionId of [...tails.keys()]) {
    stopTail(sessionId)
  }
  console.log('[live-tailer] Stopped')
}
