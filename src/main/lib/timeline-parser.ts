/**
 * @module timeline-parser
 * @description Parses Claude Code JSONL conversation files into structured
 * timeline turns. Handles streaming deduplication (multiple entries per requestId),
 * matches tool_use blocks to tool_result blocks, and calculates per-turn costs.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { classifyAction } from './timeline-classifier'
import { normalizeModelId, calculateCost } from './pricing'
import type { TimelineTurn, TimelineToolCall, TimelineConversation, TimelineData, TimelineActionType } from '../../types'

// ── Helpers ─────────────────────────────────────────────────────────────────

function summarize(text: string | null | undefined, maxLen = 2000): string | null {
  if (!text) return null
  const clean = text.trim()
  if (!clean) return null
  return clean.length > maxLen ? clean.slice(0, maxLen) + '…' : clean
}

function toolInputSummary(name: string, input: Record<string, unknown>): string {
  if (name === 'Read' || name === 'Write') return String(input.file_path ?? input.filePath ?? '')
  if (name === 'Edit') return String(input.file_path ?? input.filePath ?? '')
  if (name === 'Glob') return String(input.pattern ?? '')
  if (name === 'Grep') return String(input.pattern ?? '')
  if (name === 'Bash') return summarize(String(input.command ?? ''), 120) ?? ''
  if (name === 'WebSearch') return String(input.query ?? '')
  if (name === 'WebFetch') return String(input.url ?? '')
  if (name === 'Agent') return summarize(String(input.prompt ?? ''), 120) ?? ''
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.length > 0) return summarize(v, 120) ?? ''
  }
  return ''
}

/**
 * Recover the project directory name from a Claude projects slug.
 * Slug format: "-Users-cbryant-code-latch-core" (path with / → - and leading -)
 * Problem: hyphens in real dir names are ambiguous. We walk the slug segments
 * greedily against the filesystem to find the deepest real directory.
 */
function slugToProjectName(slug: string): string {
  // Strip leading dash, split into segments
  const segments = slug.replace(/^-/, '').split('-').filter(Boolean)
  if (segments.length === 0) return slug

  // Walk the filesystem greedily: try joining segments left-to-right
  // and check if each candidate is a real directory
  let current = '/'
  let i = 0
  while (i < segments.length) {
    // Try progressively longer hyphenated combos for the next path component
    let matched = false
    for (let len = segments.length - i; len >= 1; len--) {
      const candidate = segments.slice(i, i + len).join('-')
      const testPath = path.join(current, candidate)
      try {
        if (fs.statSync(testPath).isDirectory()) {
          current = testPath
          i += len
          matched = true
          break
        }
      } catch { /* not a real path */ }
    }
    if (!matched) {
      // No filesystem match — just use the remaining segments joined with hyphens
      return segments.slice(i).join('-') || path.basename(current)
    }
  }

  return path.basename(current)
}

// ── Conversation listing ────────────────────────────────────────────────────

/**
 * List all JSONL conversation files in Claude projects directory.
 * Optionally filter to a single project slug.
 */
export function listConversations(projectSlug?: string): TimelineConversation[] {
  const claudeBase = path.join(os.homedir(), '.claude', 'projects')
  if (!fs.existsSync(claudeBase)) return []

  const conversations: TimelineConversation[] = []
  const slugs = projectSlug ? [projectSlug] : (() => {
    try { return fs.readdirSync(claudeBase) } catch { return [] }
  })()

  for (const slug of slugs) {
    const dirPath = path.join(claudeBase, slug)
    try {
      if (!fs.statSync(dirPath).isDirectory()) continue
    } catch { continue }

    const projectName = slugToProjectName(slug)

    let files: string[]
    try { files = fs.readdirSync(dirPath) } catch { continue }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = path.join(dirPath, file)
      try {
        const stat = fs.statSync(filePath)
        if (stat.size < 1024) continue
        const preview = scanConversationPreview(filePath)
        conversations.push({
          id: file.replace('.jsonl', ''),
          filePath,
          projectSlug: slug,
          projectName,
          lastModified: stat.mtime.toISOString(),
          sizeBytes: stat.size,
          ...preview,
        })
      } catch { continue }
    }
  }

  conversations.sort((a, b) => b.lastModified.localeCompare(a.lastModified))
  return conversations
}

/**
 * Lightweight scan of a JSONL file to extract:
 * - First user message text (prompt preview)
 * - Aggregate token count and cost across all assistant turns
 * - Turn count (deduplicated by requestId, keeping LAST entry per request
 *   since Claude Code writes multiple streaming chunks and the final one
 *   has complete token counts)
 */
function scanConversationPreview(filePath: string): {
  promptPreview: string | null
  totalCostUsd: number
  totalTokens: number
  turnCount: number
} {
  let promptPreview: string | null = null

  // Accumulate per-requestId, keeping LAST entry (final streaming chunk)
  interface UsageEntry { model: string; input: number; output: number; cacheWrite: number; cacheRead: number }
  const byReqId = new Map<string, UsageEntry>()
  const noReqId: UsageEntry[] = []

  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const lines = content.split('\n')

    for (const line of lines) {
      if (!line.trim()) continue
      let obj: any
      try { obj = JSON.parse(line) } catch { continue }

      // Grab first human/user text as the prompt preview
      if (!promptPreview && obj.type === 'user' && obj.message) {
        const msg = obj.message
        if (typeof msg === 'string') {
          promptPreview = msg
        } else if (typeof msg.content === 'string') {
          promptPreview = msg.content
        } else if (Array.isArray(msg.content)) {
          const textBlock = msg.content.find((b: any) => b.type === 'text' && b.text)
          if (textBlock) promptPreview = textBlock.text
        }
        if (promptPreview) {
          promptPreview = promptPreview.trim().replace(/\n+/g, ' ')
          if (promptPreview.length > 140) promptPreview = promptPreview.slice(0, 140) + '…'
        }
      }

      // Collect assistant usage entries
      if (obj.type === 'assistant' && obj.message?.usage) {
        const model = obj.message.model
        if (!model || model === 'synthetic' || model === '<synthetic>') continue
        const usage = obj.message.usage
        const entry: UsageEntry = {
          model,
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheWrite: usage.cache_creation_input_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
        }
        const reqId = obj.requestId
        if (reqId) {
          byReqId.set(reqId, entry) // overwrites earlier chunks — keeps LAST
        } else {
          noReqId.push(entry)
        }
      }
    }
  } catch {
    // If file read fails, return defaults
  }

  // Sum up all deduplicated entries
  const allEntries = [...byReqId.values(), ...noReqId]
  let totalCostUsd = 0
  let totalTokens = 0
  for (const e of allEntries) {
    totalTokens += e.input + e.output + e.cacheWrite + e.cacheRead
    totalCostUsd += calculateCost({ inputTokens: e.input, outputTokens: e.output, cacheWriteTokens: e.cacheWrite, cacheReadTokens: e.cacheRead }, e.model)
  }

  return { promptPreview, totalCostUsd, totalTokens, turnCount: allEntries.length }
}

// ── Timeline parsing ────────────────────────────────────────────────────────

interface RawAssistantEntry {
  requestId: string | null
  timestamp: string
  model: string
  stopReason: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  }
  thinkingText: string | null
  responseText: string | null
  toolCalls: Array<{ name: string; id: string; input: Record<string, unknown> }>
}

interface RawToolResult {
  toolUseId: string
  content: string
  isError: boolean
}

interface RawUserPrompt {
  timestamp: string
  text: string
}

/**
 * Parse a JSONL conversation file into structured timeline data.
 */
export function parseTimeline(filePath: string): TimelineData {
  const content = fs.readFileSync(filePath, 'utf8')
  const lines = content.split('\n').filter((l) => l.trim())

  // Phase 1: Extract raw entries
  const assistantsByReqId = new Map<string, RawAssistantEntry>()
  const assistantsByOrder: RawAssistantEntry[] = []
  const toolResults = new Map<string, RawToolResult>()
  const userPrompts: RawUserPrompt[] = []

  for (const line of lines) {
    let obj: any
    try { obj = JSON.parse(line) } catch { continue }

    if (obj.type === 'assistant' && obj.message?.usage) {
      const msg = obj.message
      // Skip synthetic/internal bookkeeping entries (no real API call)
      if (!msg.model || msg.model === 'synthetic' || msg.model === '<synthetic>') continue
      const usage = msg.usage ?? {}

      let thinkingText: string | null = null
      let responseText: string | null = null
      const toolCalls: Array<{ name: string; id: string; input: Record<string, unknown> }> = []

      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'thinking' && block.thinking) {
            thinkingText = block.thinking
          } else if (block.type === 'text' && block.text) {
            responseText = block.text
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              name: block.name ?? 'unknown',
              id: block.id ?? '',
              input: block.input ?? {},
            })
          }
        }
      }

      const entry: RawAssistantEntry = {
        requestId: obj.requestId ?? null,
        timestamp: obj.timestamp ?? new Date().toISOString(),
        model: msg.model ?? 'unknown',
        stopReason: msg.stop_reason ?? null,
        usage: {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        },
        thinkingText,
        responseText,
        toolCalls,
      }

      // Dedup: keep last entry per requestId (last chunk has final token counts)
      if (entry.requestId) {
        assistantsByReqId.set(entry.requestId, entry)
      } else {
        assistantsByOrder.push(entry)
      }
    }

    if (obj.type === 'user') {
      const msg = obj.message

      // Extract user text (actual prompts typed by the user)
      let userText = ''
      if (typeof msg === 'string') {
        userText = msg
      } else if (typeof msg?.content === 'string') {
        userText = msg.content
      } else if (Array.isArray(msg?.content)) {
        const textBlocks = msg.content
          .filter((b: any) => b.type === 'text' && b.text)
          .map((b: any) => b.text)
        userText = textBlocks.join('\n')

        // Also extract tool_results for matching with assistant tool calls
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            let resultText = ''
            if (typeof block.content === 'string') {
              resultText = block.content
            } else if (Array.isArray(block.content)) {
              resultText = block.content
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text ?? '')
                .join('\n')
            }
            toolResults.set(block.tool_use_id, {
              toolUseId: block.tool_use_id,
              content: resultText,
              isError: block.is_error === true,
            })
          }
        }
      }

      // Only include non-empty user text as prompt turns
      if (userText.trim()) {
        userPrompts.push({
          timestamp: obj.timestamp ?? new Date().toISOString(),
          text: userText.trim(),
        })
      }
    }
  }

  // Merge deduped entries back, maintaining order by timestamp
  const allEntries = [
    ...assistantsByReqId.values(),
    ...assistantsByOrder,
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  // Phase 2: Build timeline turns
  const turns: TimelineTurn[] = []
  let totalCost = 0
  const modelsSet = new Set<string>()

  for (let i = 0; i < allEntries.length; i++) {
    const entry = allEntries[i]
    const normalizedModel = normalizeModelId(entry.model)
    modelsSet.add(normalizedModel)

    const costUsd = calculateCost({
      inputTokens: entry.usage.input_tokens,
      outputTokens: entry.usage.output_tokens,
      cacheWriteTokens: entry.usage.cache_creation_input_tokens,
      cacheReadTokens: entry.usage.cache_read_input_tokens,
    }, entry.model)
    totalCost += costUsd

    let durationMs: number | null = null
    if (i < allEntries.length - 1) {
      const nextTs = new Date(allEntries[i + 1].timestamp).getTime()
      const thisTs = new Date(entry.timestamp).getTime()
      durationMs = nextTs - thisTs
      if (durationMs < 0) durationMs = null
    }

    const timelineToolCalls: TimelineToolCall[] = entry.toolCalls.map((tc) => {
      const result = toolResults.get(tc.id)
      return {
        name: tc.name,
        id: tc.id,
        inputSummary: toolInputSummary(tc.name, tc.input),
        resultSummary: result ? summarize(result.content, 2000) : null,
        isError: result?.isError ?? false,
      }
    })

    const primaryTool = timelineToolCalls[0]
    const hasError = timelineToolCalls.some((tc) => tc.isError)
    const actionType: TimelineActionType = classifyAction(
      primaryTool?.name ?? null,
      hasError,
    )

    turns.push({
      index: i,
      requestId: entry.requestId,
      timestamp: entry.timestamp,
      durationMs,
      model: normalizedModel,
      stopReason: entry.stopReason,
      costUsd,
      inputTokens: entry.usage.input_tokens,
      outputTokens: entry.usage.output_tokens,
      cacheReadTokens: entry.usage.cache_read_input_tokens,
      cacheWriteTokens: entry.usage.cache_creation_input_tokens,
      thinkingSummary: summarize(entry.thinkingText),
      textSummary: summarize(entry.responseText),
      toolCalls: timelineToolCalls,
      actionType,
    })
  }

  // Phase 3: Insert user prompt turns and re-sort chronologically
  for (const prompt of userPrompts) {
    turns.push({
      index: -1,
      requestId: null,
      timestamp: prompt.timestamp,
      durationMs: null,
      model: '',
      stopReason: null,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingSummary: null,
      textSummary: summarize(prompt.text),
      toolCalls: [],
      actionType: 'prompt',
    })
  }

  // Re-sort all turns by timestamp and re-index
  turns.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  for (let i = 0; i < turns.length; i++) {
    turns[i].index = i
    // Recalculate duration from gap to next turn
    if (i < turns.length - 1) {
      const nextTs = new Date(turns[i + 1].timestamp).getTime()
      const thisTs = new Date(turns[i].timestamp).getTime()
      const gap = nextTs - thisTs
      turns[i].durationMs = gap >= 0 ? gap : null
    } else {
      turns[i].durationMs = null
    }
  }

  let totalDurationMs = 0
  if (turns.length >= 2) {
    const first = new Date(turns[0].timestamp).getTime()
    const last = new Date(turns[turns.length - 1].timestamp).getTime()
    totalDurationMs = last - first
  }

  const dirName = path.basename(path.dirname(filePath))
  const projectName = slugToProjectName(dirName)

  let fileStat: fs.Stats | null = null
  try { fileStat = fs.statSync(filePath) } catch { /* ignore */ }

  const totalTokens = turns.reduce((s, t) => s + t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens, 0)

  return {
    conversation: {
      id: path.basename(filePath, '.jsonl'),
      filePath,
      projectSlug: dirName,
      projectName,
      lastModified: fileStat?.mtime.toISOString() ?? new Date().toISOString(),
      sizeBytes: fileStat?.size ?? 0,
      promptPreview: null,
      totalCostUsd: totalCost,
      totalTokens,
      turnCount: turns.length,
    },
    turns,
    totalCostUsd: totalCost,
    totalDurationMs,
    turnCount: turns.length,
    models: Array.from(modelsSet),
  }
}
