/**
 * @module opencode-db-source
 * @description ConversationSource that reads directly from OpenCode's own SQLite
 * database at ~/.local/share/opencode/opencode.db. This gives instant replay of
 * all OpenCode sessions without needing SSE or plugin hooks.
 *
 * OpenCode DB schema (relevant tables):
 *   session: id, title, directory, time_created, time_updated
 *   message: id, session_id, data (JSON with role, cost, tokens, modelID, etc.)
 *   part:    id, message_id, session_id, data (JSON with type, tool, state, text)
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { classifyAction } from './timeline-classifier'
import type { ConversationSource } from './conversation-source'
import type {
  TimelineConversation,
  TimelineData,
  TimelineTurn,
  TimelineToolCall,
  TimelineActionType,
} from '../../types'

// ── DB Path ─────────────────────────────────────────────────────────────────

const OPENCODE_DB_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')

// ── Helpers ─────────────────────────────────────────────────────────────────

function summarize(text: string | null | undefined, maxLen = 140): string | null {
  if (!text) return null
  const clean = text.trim()
  if (!clean) return null
  return clean.length > maxLen ? clean.slice(0, maxLen) + '\u2026' : clean
}

/** Capitalize first letter to match classifier tool name sets (Read, Write, Bash). */
function normalizeToolName(name: string): string {
  if (!name) return 'unknown'
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function extractToolInputSummary(tool: string, input: Record<string, unknown>): string {
  const fp = input?.filePath ?? input?.file_path ?? input?.path
  if (fp && typeof fp === 'string') return fp
  const cmd = input?.command
  if (cmd && typeof cmd === 'string') return summarize(cmd, 120) ?? ''
  const pattern = input?.pattern
  if (pattern && typeof pattern === 'string') return pattern
  return ''
}

// ── OpenCode DB types ───────────────────────────────────────────────────────

interface OcSession {
  id: string
  title: string
  directory: string
  time_created: number
  time_updated: number
}

interface OcMessage {
  id: string
  session_id: string
  time_created: number
  data: string // JSON
}

interface OcPart {
  id: string
  message_id: string
  session_id: string
  time_created: number
  data: string // JSON
}

// Parsed message data
interface OcMessageData {
  role: 'user' | 'assistant'
  modelID?: string
  providerID?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  time?: { created?: number; completed?: number }
  finish?: string
}

// Parsed part data
interface OcPartData {
  type: 'text' | 'tool' | 'reasoning' | 'step-start' | 'step-finish' | 'patch'
  text?: string
  tool?: string
  callID?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    output?: string
    error?: string
    time?: { start?: number; end?: number }
  }
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  reason?: string
}

// ── Source Implementation ────────────────────────────────────────────────────

export class OpenCodeDbSource implements ConversationSource {
  readonly id = 'opencode-db'
  private dbPath: string

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? OPENCODE_DB_PATH
  }

  private openDb(): any | null {
    if (!fs.existsSync(this.dbPath)) return null
    try {
      // Dynamic import to avoid loading if not needed
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3')
      return new Database(this.dbPath, { readonly: true, fileMustExist: true })
    } catch {
      return null
    }
  }

  listConversations(_projectSlug?: string): TimelineConversation[] {
    const db = this.openDb()
    if (!db) return []

    try {
      const sessions = db.prepare(`
        SELECT
          s.id, s.title, s.directory, s.time_created, s.time_updated,
          COUNT(DISTINCT m.id) as msg_count,
          (SELECT json_extract(p2.data, '$.text')
           FROM part p2
           WHERE p2.session_id = s.id
             AND json_extract(p2.data, '$.type') = 'text'
           ORDER BY p2.time_created ASC LIMIT 1) as first_text
        FROM session s
        LEFT JOIN message m ON m.session_id = s.id
        GROUP BY s.id
        ORDER BY s.time_updated DESC
        LIMIT 200
      `).all() as any[]

      return sessions.map((s: any) => ({
        id: s.id,
        filePath: s.id,
        projectSlug: s.directory ? path.basename(s.directory) : s.id,
        projectName: s.title || 'OpenCode Session',
        lastModified: new Date(s.time_updated).toISOString(),
        sizeBytes: 0,
        promptPreview: summarize(s.first_text ?? s.title),
        totalCostUsd: 0, // calculated on full load
        totalTokens: 0,
        turnCount: s.msg_count ?? 0,
        sourceId: this.id,
        harnessId: 'opencode',
      }))
    } catch (err) {
      console.warn('[opencode-db] Failed to list conversations:', err)
      return []
    } finally {
      db.close()
    }
  }

  loadConversation(sessionId: string): TimelineData | null {
    const db = this.openDb()
    if (!db) return null

    try {
      // Get session
      const session = db.prepare('SELECT * FROM session WHERE id = ?').get(sessionId) as OcSession | undefined
      if (!session) return null

      // Get messages ordered by time
      const messages = db.prepare(
        'SELECT * FROM message WHERE session_id = ? ORDER BY time_created ASC'
      ).all(sessionId) as OcMessage[]

      // Get parts ordered by time
      const parts = db.prepare(
        'SELECT * FROM part WHERE session_id = ? ORDER BY time_created ASC'
      ).all(sessionId) as OcPart[]

      return this.assembleTimeline(session, messages, parts)
    } catch (err) {
      console.warn('[opencode-db] Failed to load conversation:', err)
      return null
    } finally {
      db.close()
    }
  }

  private assembleTimeline(
    session: OcSession,
    messages: OcMessage[],
    parts: OcPart[],
  ): TimelineData {
    // Group parts by message_id
    const partsByMessage = new Map<string, OcPart[]>()
    for (const part of parts) {
      let group = partsByMessage.get(part.message_id)
      if (!group) {
        group = []
        partsByMessage.set(part.message_id, group)
      }
      group.push(part)
    }

    const turns: TimelineTurn[] = []
    let totalCost = 0
    const modelsSet = new Set<string>()

    for (const msg of messages) {
      let msgData: OcMessageData
      try {
        msgData = JSON.parse(msg.data)
      } catch { continue }

      const msgParts = partsByMessage.get(msg.id) ?? []
      const timestamp = new Date(msg.time_created).toISOString()

      if (msgData.role === 'user') {
        // User message — find text parts for prompt
        const textContent = this.extractText(msgParts)
        turns.push({
          index: turns.length,
          requestId: msg.id,
          timestamp,
          durationMs: null,
          model: '',
          stopReason: null,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingSummary: null,
          textSummary: summarize(textContent),
          toolCalls: [],
          actionType: 'prompt',
        })
        continue
      }

      // Assistant message
      const toolCalls = this.extractToolCalls(msgParts)
      const thinkingText = this.extractThinking(msgParts)
      const responseText = this.extractText(msgParts)
      const stepFinish = this.extractStepFinish(msgParts)

      // Cost/tokens — prefer step-finish aggregates, fall back to message-level
      const cost = stepFinish.cost || (msgData.cost ?? 0)
      const inputTokens = stepFinish.inputTokens || (msgData.tokens?.input ?? 0)
      const outputTokens = stepFinish.outputTokens || (msgData.tokens?.output ?? 0)
      const cacheRead = stepFinish.cacheRead || (msgData.tokens?.cache?.read ?? 0)
      const cacheWrite = stepFinish.cacheWrite || (msgData.tokens?.cache?.write ?? 0)
      const model = msgData.modelID ?? ''

      totalCost += cost
      if (model) modelsSet.add(model)

      // Duration from message timing
      let durationMs: number | null = null
      if (msgData.time?.created && msgData.time?.completed) {
        durationMs = msgData.time.completed - msgData.time.created
      }

      const primaryTool = toolCalls[0]
      const hasError = toolCalls.some((tc) => tc.isError)
      const actionType: TimelineActionType = toolCalls.length > 0
        ? classifyAction(normalizeToolName(primaryTool?.name ?? ''), hasError)
        : 'respond'

      turns.push({
        index: turns.length,
        requestId: msg.id,
        timestamp,
        durationMs,
        model,
        stopReason: msgData.finish ?? null,
        costUsd: cost,
        inputTokens,
        outputTokens,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        thinkingSummary: summarize(thinkingText, 500),
        textSummary: summarize(responseText),
        toolCalls,
        actionType,
      })
    }

    // Calculate total duration
    let totalDurationMs = 0
    if (turns.length >= 2) {
      const first = new Date(turns[0].timestamp).getTime()
      const last = new Date(turns[turns.length - 1].timestamp).getTime()
      totalDurationMs = last - first
    }

    const totalTokens = turns.reduce(
      (s, t) => s + t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens,
      0,
    )

    return {
      conversation: {
        id: session.id,
        filePath: session.id,
        projectSlug: path.basename(session.directory || session.id),
        projectName: session.title || 'OpenCode Session',
        lastModified: new Date(session.time_updated).toISOString(),
        sizeBytes: 0,
        promptPreview: turns.find(t => t.actionType === 'prompt')?.textSummary ?? null,
        totalCostUsd: totalCost,
        totalTokens,
        turnCount: turns.length,
        sourceId: this.id,
        harnessId: 'opencode',
      },
      turns,
      totalCostUsd: totalCost,
      totalDurationMs,
      turnCount: turns.length,
      models: Array.from(modelsSet),
    }
  }

  private extractText(parts: OcPart[]): string | null {
    const texts: string[] = []
    for (const part of parts) {
      try {
        const data: OcPartData = JSON.parse(part.data)
        if (data.type === 'text' && data.text) {
          texts.push(data.text)
        }
      } catch { continue }
    }
    return texts.length > 0 ? texts.join('\n') : null
  }

  private extractThinking(parts: OcPart[]): string | null {
    const texts: string[] = []
    for (const part of parts) {
      try {
        const data: OcPartData = JSON.parse(part.data)
        if (data.type === 'reasoning' && data.text) {
          texts.push(data.text)
        }
      } catch { continue }
    }
    return texts.length > 0 ? texts.join('\n') : null
  }

  private extractToolCalls(parts: OcPart[]): TimelineToolCall[] {
    const calls: TimelineToolCall[] = []
    for (const part of parts) {
      try {
        const data: OcPartData = JSON.parse(part.data)
        if (data.type !== 'tool' || !data.state) continue

        // Skip non-terminal states
        if (data.state.status !== 'completed' && data.state.status !== 'error') continue

        const toolName = data.tool ?? 'unknown'
        const isError = data.state.status === 'error'
        const input = data.state.input ?? {}
        const result = isError
          ? (data.state.error ?? 'Error')
          : (data.state.output ?? '')

        calls.push({
          name: toolName,
          id: data.callID ?? part.id,
          inputSummary: extractToolInputSummary(toolName, input),
          resultSummary: summarize(result, 2000),
          isError,
        })
      } catch { continue }
    }
    return calls
  }

  private extractStepFinish(parts: OcPart[]): {
    cost: number; inputTokens: number; outputTokens: number
    cacheRead: number; cacheWrite: number
  } {
    let cost = 0, inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheWrite = 0
    for (const part of parts) {
      try {
        const data: OcPartData = JSON.parse(part.data)
        if (data.type !== 'step-finish') continue
        cost += data.cost ?? 0
        inputTokens += data.tokens?.input ?? 0
        outputTokens += data.tokens?.output ?? 0
        cacheRead += data.tokens?.cache?.read ?? 0
        cacheWrite += data.tokens?.cache?.write ?? 0
      } catch { continue }
    }
    return { cost, inputTokens, outputTokens, cacheRead, cacheWrite }
  }
}
