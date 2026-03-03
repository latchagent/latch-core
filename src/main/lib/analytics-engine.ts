// src/main/lib/analytics-engine.ts

/**
 * @module analytics-engine
 * @description Computes deep analytics from parsed timeline data —
 * phase cost attribution, context pressure curves, rate-limit gap detection.
 * Pure computation, no I/O.
 */

import type {
  TimelineTurn,
  TimelineData,
  WorkPhase,
  PhaseCostBucket,
  ContextPressurePoint,
  RateLimitGap,
  ConversationAnalytics,
  ProjectHealthMetrics,
  AnalyticsDashboard,
  TimelineConversation,
} from '../../types'
import { detectAllLoops } from './loop-detector'

// ── Work Phase Classification ───────────────────────────────────────────────

const PLANNING_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TaskList', 'TaskGet'])
const IMPLEMENTATION_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])
const COORDINATION_TOOLS = new Set(['Agent', 'Skill', 'SendMessage', 'EnterPlanMode', 'ExitPlanMode', 'TaskCreate', 'TaskUpdate'])

// Bash commands that suggest debugging
const DEBUG_PATTERNS = [
  /\btest\b/i, /\bpytest\b/i, /\bvitest\b/i, /\bjest\b/i, /\bmocha\b/i,
  /\bnpm run test/i, /\bnpx tsc/i, /\btsc --noEmit/i,
  /\berror\b/i, /\bdebug\b/i, /\blog\b/i,
  /\bgit diff\b/i, /\bgit status\b/i, /\bgit log\b/i,
]

/**
 * Classify a turn into a work phase based on its tool calls.
 */
export function classifyPhase(turn: TimelineTurn): WorkPhase {
  if (turn.toolCalls.length === 0) return 'responding'

  const primaryTool = turn.toolCalls[0].name

  if (COORDINATION_TOOLS.has(primaryTool)) return 'coordination'
  if (IMPLEMENTATION_TOOLS.has(primaryTool)) return 'implementation'
  if (PLANNING_TOOLS.has(primaryTool)) return 'planning'

  // Bash: check if debugging or implementation
  if (primaryTool === 'Bash') {
    const cmd = turn.toolCalls[0].inputSummary ?? ''
    const isError = turn.toolCalls.some(tc => tc.isError)
    if (isError) return 'debugging'
    for (const pattern of DEBUG_PATTERNS) {
      if (pattern.test(cmd)) return 'debugging'
    }
    return 'implementation' // build commands, installs, etc.
  }

  return 'responding'
}

// ── Phase Cost Attribution ──────────────────────────────────────────────────

/**
 * Break down total cost by work phase.
 */
export function computePhaseCosts(turns: TimelineTurn[]): PhaseCostBucket[] {
  const buckets = new Map<WorkPhase, { costUsd: number; turns: number; tokens: number }>()

  for (const turn of turns) {
    const phase = classifyPhase(turn)
    const existing = buckets.get(phase) ?? { costUsd: 0, turns: 0, tokens: 0 }
    existing.costUsd += turn.costUsd
    existing.turns += 1
    existing.tokens += turn.inputTokens + turn.outputTokens
    buckets.set(phase, existing)
  }

  const totalCost = turns.reduce((s, t) => s + t.costUsd, 0) || 1

  const order: WorkPhase[] = ['planning', 'implementation', 'debugging', 'coordination', 'responding']
  return order
    .filter(phase => buckets.has(phase))
    .map(phase => {
      const b = buckets.get(phase)!
      return {
        phase,
        costUsd: b.costUsd,
        turns: b.turns,
        tokens: b.tokens,
        pct: b.costUsd / totalCost,
      }
    })
}

// ── Context Window Pressure ─────────────────────────────────────────────────

/**
 * Build a cumulative token curve showing context pressure over time.
 * Cache hit ratio indicates when context is being reused vs rebuilt.
 */
export function computeContextPressure(turns: TimelineTurn[]): ContextPressurePoint[] {
  let cumInput = 0
  let cumOutput = 0
  let cumCacheRead = 0
  let cumCacheWrite = 0

  return turns.map((turn) => {
    cumInput += turn.inputTokens
    cumOutput += turn.outputTokens
    cumCacheRead += turn.cacheReadTokens
    cumCacheWrite += turn.cacheWriteTokens

    const totalInput = cumInput + cumCacheRead + cumCacheWrite
    const cacheHitRatio = totalInput > 0 ? cumCacheRead / totalInput : 0

    return {
      turnIndex: turn.index,
      timestamp: turn.timestamp,
      cumulativeInput: cumInput,
      cumulativeOutput: cumOutput,
      cumulativeCacheRead: cumCacheRead,
      cumulativeCacheWrite: cumCacheWrite,
      cacheHitRatio,
    }
  })
}

// ── Rate Limit Gap Detection ────────────────────────────────────────────────

const GAP_THRESHOLD_MS = 30_000 // 30 seconds suggests rate limiting

function formatGap(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

/**
 * Detect gaps between consecutive turns that suggest rate limiting or waiting.
 */
export function detectRateLimitGaps(turns: TimelineTurn[]): RateLimitGap[] {
  const gaps: RateLimitGap[] = []

  for (let i = 0; i < turns.length - 1; i++) {
    const thisTs = new Date(turns[i].timestamp).getTime()
    const nextTs = new Date(turns[i + 1].timestamp).getTime()
    const gapMs = nextTs - thisTs

    if (gapMs >= GAP_THRESHOLD_MS) {
      gaps.push({
        afterTurnIndex: i,
        timestamp: turns[i].timestamp,
        gapMs,
        gapLabel: formatGap(gapMs),
      })
    }
  }

  return gaps
}

// ── Single Conversation Analytics ───────────────────────────────────────────

/**
 * Compute full analytics for a single parsed conversation.
 */
export function computeConversationAnalytics(data: TimelineData): ConversationAnalytics {
  const { turns } = data

  const phaseCosts = computePhaseCosts(turns)
  const contextPressure = computeContextPressure(turns)
  const rateLimitGaps = detectRateLimitGaps(turns)

  const peakInputTokens = contextPressure.length > 0
    ? Math.max(...contextPressure.map(p => p.cumulativeInput))
    : 0

  const avgCacheHitRatio = contextPressure.length > 0
    ? contextPressure.reduce((s, p) => s + p.cacheHitRatio, 0) / contextPressure.length
    : 0

  const longestGapMs = rateLimitGaps.length > 0
    ? Math.max(...rateLimitGaps.map(g => g.gapMs))
    : 0

  const loops = detectAllLoops(turns)
  const totalWastedCostUsd = loops.reduce((s, l) => s + l.wastedCostUsd, 0)

  return {
    phaseCosts,
    contextPressure,
    rateLimitGaps,
    peakInputTokens,
    avgCacheHitRatio,
    longestGapMs,
    loops,
    totalWastedCostUsd,
  }
}

// ── Per-Project Health Dashboard ────────────────────────────────────────────

/**
 * Compute health metrics for a single project from its conversations.
 * Requires the conversations to already have scanConversationPreview data,
 * and TimelineData to be parsed for phase breakdown.
 */
export function computeProjectHealth(
  projectSlug: string,
  projectName: string,
  conversations: TimelineConversation[],
  parsedTimelines: TimelineData[],
): ProjectHealthMetrics {
  let lifetimeCostUsd = 0
  let lifetimeTokens = 0
  let totalTurns = 0

  const modelMap = new Map<string, { costUsd: number; turns: number }>()
  const weekMap = new Map<string, { costUsd: number; conversations: number }>()
  const allTurns: TimelineTurn[] = []

  for (const conv of conversations) {
    lifetimeCostUsd += conv.totalCostUsd
    lifetimeTokens += conv.totalTokens
    totalTurns += conv.turnCount

    // Weekly aggregation from conversation date
    const d = new Date(conv.lastModified)
    const weekStart = new Date(d)
    weekStart.setDate(d.getDate() - d.getDay())
    const weekKey = weekStart.toISOString().slice(0, 10)
    const w = weekMap.get(weekKey) ?? { costUsd: 0, conversations: 0 }
    w.costUsd += conv.totalCostUsd
    w.conversations += 1
    weekMap.set(weekKey, w)
  }

  // Aggregate model breakdown and phase breakdown from parsed timelines
  for (const tl of parsedTimelines) {
    for (const turn of tl.turns) {
      allTurns.push(turn)
      // Skip synthetic model entries
      if (turn.model === 'synthetic' || turn.model === '<synthetic>') continue
      const m = modelMap.get(turn.model) ?? { costUsd: 0, turns: 0 }
      m.costUsd += turn.costUsd
      m.turns += 1
      modelMap.set(turn.model, m)
    }
  }

  const phaseBreakdown = computePhaseCosts(allTurns)

  const modelBreakdown = Array.from(modelMap.entries())
    .map(([model, data]) => ({ model, ...data }))
    .sort((a, b) => b.costUsd - a.costUsd)

  const weeklySpend = Array.from(weekMap.entries())
    .map(([week, data]) => ({ week, ...data }))
    .sort((a, b) => a.week.localeCompare(b.week))
    .slice(-12) // last 12 weeks

  return {
    projectSlug,
    projectName,
    lifetimeCostUsd,
    lifetimeTokens,
    conversationCount: conversations.length,
    totalTurns,
    avgCostPerConversation: conversations.length > 0 ? lifetimeCostUsd / conversations.length : 0,
    modelBreakdown,
    weeklySpend,
    phaseBreakdown,
  }
}

/**
 * Compute the full cross-project dashboard.
 * `projectMap` keys are project slugs, values are { conversations, timelines }.
 */
export function computeDashboard(
  projectMap: Map<string, {
    name: string
    conversations: TimelineConversation[]
    timelines: TimelineData[]
  }>,
): AnalyticsDashboard {
  const projects: ProjectHealthMetrics[] = []
  let totalCostUsd = 0
  let totalConversations = 0
  let totalTurns = 0

  for (const [slug, data] of projectMap) {
    const health = computeProjectHealth(slug, data.name, data.conversations, data.timelines)
    projects.push(health)
    totalCostUsd += health.lifetimeCostUsd
    totalConversations += health.conversationCount
    totalTurns += health.totalTurns
  }

  // Sort by lifetime cost descending
  projects.sort((a, b) => b.lifetimeCostUsd - a.lifetimeCostUsd)

  return { projects, totalCostUsd, totalConversations, totalTurns }
}
