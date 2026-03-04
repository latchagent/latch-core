/**
 * @module opencode-tailer
 * @description Subscribes to OpenCode's local SSE event stream and processes
 * events into the ConversationStore for replay + emits LiveEvents for the
 * renderer's live feed.
 *
 * Analogous to live-tailer.ts for Claude, but reads from SSE instead of JSONL.
 */

import crypto from 'node:crypto'
import type { LiveEvent, LiveSessionStatus } from '../../types'
import type { ConversationStore } from '../stores/conversation-store'

// ── Configuration ───────────────────────────────────────────────────────────

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const SUMMARIZE_MAX_LEN = 200

// ── Helpers ─────────────────────────────────────────────────────────────────

function uid(): string {
  return `oc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
}

function summarize(text: string | null | undefined, maxLen = SUMMARIZE_MAX_LEN): string | null {
  if (!text) return null
  const clean = text.trim()
  if (!clean) return null
  return clean.length > maxLen ? clean.slice(0, maxLen - 3) + '...' : clean
}

function extractToolInput(tool: string, input: Record<string, unknown>): string {
  const fp = input?.file_path ?? input?.path
  if (fp && typeof fp === 'string') return fp
  const cmd = input?.command
  if (cmd && typeof cmd === 'string') return summarize(cmd, 120) ?? ''
  const pattern = input?.pattern
  if (pattern && typeof pattern === 'string') return pattern
  return ''
}

// ── Event Processing ────────────────────────────────────────────────────────

export interface ProcessContext {
  sessionId: string
  store: ConversationStore
  emit: (event: LiveEvent) => void
  turnIndex: number
}

/**
 * Process a single OpenCode SSE event.
 * Exported for unit testing; the real tailer calls it internally.
 */
export function processOpenCodeEvent(event: any, ctx: ProcessContext): void {
  const type = event?.type as string
  if (!type) return

  const timestamp = new Date().toISOString()

  // ── message.updated — full message metadata (cost, tokens, model)
  if (type === 'message.updated') {
    const info = event.properties?.info
    if (!info) return

    if (info.role === 'assistant') {
      ctx.store.record({
        sessionId: ctx.sessionId,
        harnessId: 'opencode',
        timestamp,
        kind: 'step-finish',
        turnIndex: ctx.turnIndex,
        model: info.modelID ?? null,
        inputTokens: info.tokens?.input ?? null,
        outputTokens: info.tokens?.output ?? null,
        reasoningTokens: info.tokens?.reasoning ?? null,
        cacheReadTokens: info.tokens?.cache?.read ?? null,
        cacheWriteTokens: info.tokens?.cache?.write ?? null,
        costUsd: info.cost ?? null,
      })

      // Emit a tool-call LiveEvent with cost info — LiveEventKind has no
      // 'cost-update', so we piggyback on 'tool-call' with the model as target.
      ctx.emit({
        id: uid(),
        sessionId: ctx.sessionId,
        timestamp,
        kind: 'tool-call',
        toolName: 'step-finish',
        target: info.modelID ?? 'unknown',
        costUsd: info.cost ?? 0,
        inputTokens: info.tokens?.input ?? 0,
        outputTokens: info.tokens?.output ?? 0,
        status: 'success',
      })
    }
    // User messages don't need storage (we get text from parts)
    return
  }

  // ── message.part.updated — tool calls, text, reasoning
  if (type === 'message.part.updated') {
    const part = event.properties?.part
    if (!part) return

    const partType = part.type

    if (partType === 'tool') {
      const state = part.state
      if (!state) return
      // Only record completed or error tool calls
      if (state.status !== 'completed' && state.status !== 'error') return

      const toolName = part.tool ?? 'unknown'
      const input = state.input ?? {}
      const inputStr = extractToolInput(toolName, input)
      const isError = state.status === 'error'
      const result = isError ? (state.error ?? '') : (typeof state.output === 'string' ? state.output : JSON.stringify(state.output ?? ''))

      ctx.store.record({
        sessionId: ctx.sessionId,
        harnessId: 'opencode',
        timestamp,
        kind: 'tool-call',
        turnIndex: ctx.turnIndex,
        toolName,
        toolInput: inputStr,
        toolResult: summarize(result, 2000) ?? undefined,
        isError,
      })

      ctx.emit({
        id: uid(),
        sessionId: ctx.sessionId,
        timestamp,
        kind: 'tool-call',
        toolName,
        target: inputStr || undefined,
        status: isError ? 'error' : 'success',
      })
    } else if (partType === 'text') {
      const text = part.text
      if (!text) return

      ctx.store.record({
        sessionId: ctx.sessionId,
        harnessId: 'opencode',
        timestamp,
        kind: 'response',
        turnIndex: ctx.turnIndex,
        textContent: text,
      })
    } else if (partType === 'reasoning') {
      const text = part.text
      if (!text) return

      ctx.store.record({
        sessionId: ctx.sessionId,
        harnessId: 'opencode',
        timestamp,
        kind: 'thinking',
        turnIndex: ctx.turnIndex,
        textContent: text,
      })

      ctx.emit({
        id: uid(),
        sessionId: ctx.sessionId,
        timestamp,
        kind: 'thinking',
        thinkingSummary: summarize(text) ?? undefined,
      })
    }
    return
  }

  // ── session.status — idle/busy/retry
  if (type === 'session.status') {
    const status = event.properties?.status?.type as string | undefined
    if (!status) return

    // Map OpenCode statuses to LiveSessionStatus
    // LiveSessionStatus = 'active' | 'thinking' | 'idle' | 'rate-limited'
    const liveStatus: LiveSessionStatus =
      status === 'idle' ? 'idle' :
      status === 'busy' ? 'active' :
      status === 'retry' ? 'rate-limited' : 'idle'

    ctx.emit({
      id: uid(),
      sessionId: ctx.sessionId,
      timestamp,
      kind: 'status-change',
      sessionStatus: liveStatus,
    })
  }
}

// ── OpenCode Tailer Class ───────────────────────────────────────────────────

export class OpenCodeTailer {
  private store: ConversationStore
  private sendToRenderer: (channel: string, data: any) => void
  private apiUrl: string
  private sessionId: string
  private controller: AbortController | null = null
  private reconnectMs = RECONNECT_BASE_MS
  private turnIndex = 0
  private stopped = false

  constructor(opts: {
    store: ConversationStore
    sendToRenderer: (channel: string, data: any) => void
    apiUrl: string
    sessionId: string
  }) {
    this.store = opts.store
    this.sendToRenderer = opts.sendToRenderer
    this.apiUrl = opts.apiUrl.replace(/\/$/, '')
    this.sessionId = opts.sessionId
  }

  /** Start subscribing to the SSE event stream. */
  start(): void {
    this.stopped = false
    this.connect()
  }

  /** Stop the SSE connection. */
  stop(): void {
    this.stopped = true
    this.controller?.abort()
    this.controller = null
  }

  /** Increment turn index (call on session.idle to mark turn boundaries). */
  nextTurn(): void {
    this.turnIndex++
  }

  private async connect(): Promise<void> {
    if (this.stopped) return

    this.controller = new AbortController()
    const url = `${this.apiUrl}/event`

    try {
      const response = await fetch(url, {
        headers: { Accept: 'text/event-stream' },
        signal: this.controller.signal,
      })

      if (!response.ok || !response.body) {
        console.warn(`[opencode-tailer] SSE connection failed: ${response.status}`)
        this.scheduleReconnect()
        return
      }

      // Reset reconnect backoff on successful connection
      this.reconnectMs = RECONNECT_BASE_MS

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (!this.stopped) {
        const { value, done } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Process complete SSE messages (double newline delimited)
        const messages = buffer.split('\n\n')
        buffer = messages.pop() ?? ''

        for (const message of messages) {
          if (!message.trim()) continue
          this.processSSEMessage(message)
        }
      }
    } catch (err: unknown) {
      if (this.stopped) return
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('abort')) {
        console.warn(`[opencode-tailer] SSE error: ${msg}`)
      }
    }

    if (!this.stopped) {
      this.scheduleReconnect()
    }
  }

  private processSSEMessage(raw: string): void {
    let eventType = 'message'
    let data = ''

    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        data += line.slice(5).trim()
      }
    }

    if (!data) return

    try {
      const parsed = JSON.parse(data)

      // If the SSE event type gives us a hint, use it
      if (!parsed.type && eventType !== 'message') {
        parsed.type = eventType
      }

      const ctx: ProcessContext = {
        sessionId: this.sessionId,
        store: this.store,
        emit: (event) => this.sendToRenderer('latch:live-event', event),
        turnIndex: this.turnIndex,
      }

      processOpenCodeEvent(parsed, ctx)

      // Auto-advance turn on session idle
      if (parsed.type === 'session.status' && parsed.properties?.status?.type === 'idle') {
        this.nextTurn()
      }
    } catch {
      // Malformed JSON — skip with warning
      console.warn('[opencode-tailer] Failed to parse SSE data')
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    setTimeout(() => this.connect(), this.reconnectMs)
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS)
  }
}
