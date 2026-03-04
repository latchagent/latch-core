/**
 * @module conversation-source
 * @description Harness-agnostic conversation source abstraction. Each source
 * (Claude JSONL, OpenCode SSE, etc.) implements ConversationSource and is
 * registered with a ConversationRegistry. The registry merges listings from
 * all sources and routes load requests to the correct source.
 */

import { listConversations as listClaudeConversations, parseTimeline } from './timeline-parser'
import { classifyAction } from './timeline-classifier'
import type { ConversationStore, ConversationEventRecord, ConversationSummaryRow } from '../stores/conversation-store'
import type {
  TimelineConversation,
  TimelineData,
  TimelineTurn,
  TimelineToolCall,
  TimelineActionType,
} from '../../types'

// ── ConversationSource interface ─────────────────────────────────────────────

/**
 * A pluggable source of conversation data. Each harness adapter implements
 * this interface so the registry can list and load conversations uniformly.
 */
export interface ConversationSource {
  /** Unique source identifier, e.g. 'claude-jsonl' or 'opencode-sse'. */
  readonly id: string

  /** List available conversations, optionally filtered by project slug. */
  listConversations(projectSlug?: string): TimelineConversation[]

  /** Load full timeline data for a conversation. Returns null if not found. */
  loadConversation(conversationId: string): TimelineData | null
}

// ── ConversationRegistry ─────────────────────────────────────────────────────

/**
 * Merges conversations from all registered sources and routes load requests.
 */
export class ConversationRegistry {
  private sources = new Map<string, ConversationSource>()

  /** Register a conversation source. */
  register(source: ConversationSource): void {
    this.sources.set(source.id, source)
  }

  /** List conversations from all sources, sorted by lastModified descending. */
  listAll(projectSlug?: string): TimelineConversation[] {
    const all: TimelineConversation[] = []
    for (const source of this.sources.values()) {
      all.push(...source.listConversations(projectSlug))
    }
    all.sort((a, b) => b.lastModified.localeCompare(a.lastModified))
    return all
  }

  /** Load a conversation from a specific source. Returns null if source not found. */
  load(conversationId: string, sourceId: string): TimelineData | null {
    const source = this.sources.get(sourceId)
    if (!source) return null
    return source.loadConversation(conversationId)
  }
}

// ── ClaudeConversationSource ─────────────────────────────────────────────────

/**
 * Conversation source backed by Claude Code JSONL files on disk.
 * Wraps the existing timeline-parser functions.
 */
export class ClaudeConversationSource implements ConversationSource {
  readonly id = 'claude-jsonl'

  listConversations(projectSlug?: string): TimelineConversation[] {
    return listClaudeConversations(projectSlug)
  }

  loadConversation(conversationId: string): TimelineData | null {
    // Find the conversation to get its filePath
    const conversations = listClaudeConversations()
    const convo = conversations.find((c) => c.id === conversationId)
    if (!convo) return null
    return parseTimeline(convo.filePath)
  }
}

// ── PluginConversationSource ─────────────────────────────────────────────────

/** Session metadata for plugin source conversations. */
interface SessionMeta {
  projectSlug: string
  projectName: string
  projectDir: string | null
}

/**
 * Conversation source backed by the ConversationStore (SQLite).
 * Used for OpenCode SSE events and future non-Claude harnesses.
 *
 * Events are stored flat and assembled into TimelineTurn[] on load.
 */
export class PluginConversationSource implements ConversationSource {
  readonly id = 'opencode-sse'
  private store: ConversationStore
  private sessionMeta = new Map<string, SessionMeta>()

  constructor(store: ConversationStore) {
    this.store = store
  }

  /**
   * Set metadata for a session so listing can populate project info.
   * Called when the main process starts tailing a session.
   */
  setSessionMeta(sessionId: string, meta: SessionMeta): void {
    this.sessionMeta.set(sessionId, meta)
  }

  listConversations(projectSlug?: string): TimelineConversation[] {
    const summaries = this.store.listConversations()
    const conversations: TimelineConversation[] = []

    for (const row of summaries) {
      const meta = this.sessionMeta.get(row.sessionId)

      // If projectSlug filter is set and doesn't match, skip
      if (projectSlug && meta?.projectSlug !== projectSlug) continue

      conversations.push(this._summaryToConversation(row, meta))
    }

    conversations.sort((a, b) => b.lastModified.localeCompare(a.lastModified))
    return conversations
  }

  loadConversation(conversationId: string): TimelineData | null {
    const events = this.store.listBySession(conversationId)
    if (events.length === 0) return null

    const turns = this.assembleTimeline(events)
    const meta = this.sessionMeta.get(conversationId)

    const totalCost = turns.reduce((s, t) => s + t.costUsd, 0)
    const modelsSet = new Set<string>()
    for (const t of turns) {
      if (t.model) modelsSet.add(t.model)
    }

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

    const firstEvent = events[0]
    const lastEvent = events[events.length - 1]

    return {
      conversation: {
        id: conversationId,
        filePath: `plugin://${this.id}/${conversationId}`,
        projectSlug: meta?.projectSlug ?? 'unknown',
        projectName: meta?.projectName ?? 'Unknown',
        lastModified: lastEvent.timestamp,
        sizeBytes: 0,
        promptPreview: this._findPromptPreview(events),
        totalCostUsd: totalCost,
        totalTokens,
        turnCount: turns.length,
        sourceId: this.id,
        harnessId: firstEvent.harnessId,
      },
      turns,
      totalCostUsd: totalCost,
      totalDurationMs,
      turnCount: turns.length,
      models: Array.from(modelsSet),
    }
  }

  /**
   * Assemble flat ConversationEventRecords into structured TimelineTurn[].
   * Events are grouped by turn_index. Within each group:
   * - 'prompt' events → prompt turn (actionType='prompt')
   * - 'tool-call' events → TimelineToolCall[]
   * - 'thinking' events → thinkingSummary
   * - 'response'/'step-finish' events → model, tokens, cost aggregation
   */
  assembleTimeline(events: ConversationEventRecord[]): TimelineTurn[] {
    // Group events by turn_index
    const groups = new Map<number, ConversationEventRecord[]>()
    for (const ev of events) {
      const idx = ev.turnIndex ?? 0
      let group = groups.get(idx)
      if (!group) {
        group = []
        groups.set(idx, group)
      }
      group.push(ev)
    }

    // Sort groups by turn index
    const sortedIndices = Array.from(groups.keys()).sort((a, b) => a - b)
    const turns: TimelineTurn[] = []

    for (const idx of sortedIndices) {
      const group = groups.get(idx)!
      const turn = this._buildTurnFromGroup(idx, group)
      turns.push(turn)
    }

    // Calculate durations from timestamp gaps between consecutive turns
    for (let i = 0; i < turns.length; i++) {
      if (i < turns.length - 1) {
        const thisTs = new Date(turns[i].timestamp).getTime()
        const nextTs = new Date(turns[i + 1].timestamp).getTime()
        const gap = nextTs - thisTs
        turns[i].durationMs = gap >= 0 ? gap : null
      } else {
        turns[i].durationMs = null
      }
    }

    return turns
  }

  private _buildTurnFromGroup(index: number, events: ConversationEventRecord[]): TimelineTurn {
    // Find earliest timestamp in the group
    let timestamp = events[0].timestamp
    for (const ev of events) {
      if (ev.timestamp < timestamp) timestamp = ev.timestamp
    }

    // Check for prompt events — if all events are prompts, this is a prompt turn
    const promptEvents = events.filter((e) => e.kind === 'prompt')
    if (promptEvents.length > 0 && promptEvents.length === events.length) {
      return {
        index,
        requestId: null,
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
        textSummary: promptEvents[0].textContent ?? null,
        toolCalls: [],
        actionType: 'prompt',
      }
    }

    // Collect tool calls
    const toolCallEvents = events.filter((e) => e.kind === 'tool-call')
    const toolCalls: TimelineToolCall[] = toolCallEvents.map((ev) => ({
      name: ev.toolName ?? 'unknown',
      id: ev.id,
      inputSummary: ev.toolInput ?? '',
      resultSummary: ev.toolResult ?? null,
      isError: ev.isError,
    }))

    // Collect thinking summary
    const thinkingEvents = events.filter((e) => e.kind === 'thinking')
    const thinkingSummary = thinkingEvents.length > 0
      ? thinkingEvents.map((e) => e.textContent).filter(Boolean).join('\n') || null
      : null

    // Aggregate model, tokens, cost from response/step-finish events
    const metaEvents = events.filter((e) => e.kind === 'response' || e.kind === 'step-finish')
    let model = ''
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let costUsd = 0
    let stopReason: string | null = null
    let textSummary: string | null = null

    for (const ev of metaEvents) {
      if (ev.model) model = ev.model
      inputTokens += ev.inputTokens ?? 0
      outputTokens += ev.outputTokens ?? 0
      cacheReadTokens += ev.cacheReadTokens ?? 0
      cacheWriteTokens += ev.cacheWriteTokens ?? 0
      costUsd += ev.costUsd ?? 0
      if (ev.textContent) textSummary = ev.textContent
    }

    // If no meta events had model info, try tool call events
    if (!model) {
      for (const ev of events) {
        if (ev.model) { model = ev.model; break }
      }
    }

    // Determine action type from primary tool
    const primaryTool = toolCalls[0]
    const hasError = toolCalls.some((tc) => tc.isError)
    const actionType: TimelineActionType = classifyAction(
      primaryTool?.name ?? null,
      hasError,
    )

    return {
      index,
      requestId: null,
      timestamp,
      durationMs: null,
      model,
      stopReason,
      costUsd,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      thinkingSummary,
      textSummary,
      toolCalls,
      actionType,
    }
  }

  private _summaryToConversation(
    row: ConversationSummaryRow,
    meta?: SessionMeta,
  ): TimelineConversation {
    return {
      id: row.sessionId,
      filePath: `plugin://${this.id}/${row.sessionId}`,
      projectSlug: meta?.projectSlug ?? 'unknown',
      projectName: meta?.projectName ?? 'Unknown',
      lastModified: row.lastTimestamp,
      sizeBytes: 0,
      promptPreview: row.promptPreview,
      totalCostUsd: row.totalCostUsd,
      totalTokens: 0,
      turnCount: row.turnCount,
      sourceId: this.id,
      harnessId: row.harnessId,
    }
  }

  private _findPromptPreview(events: ConversationEventRecord[]): string | null {
    for (const ev of events) {
      if (ev.kind === 'prompt' && ev.textContent) {
        const text = ev.textContent.trim()
        if (text.length > 140) return text.slice(0, 140) + '\u2026'
        return text
      }
    }
    return null
  }
}
