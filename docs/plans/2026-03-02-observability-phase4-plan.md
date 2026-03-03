# Deep Analytics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an Analytics view that surfaces deep insights from conversation data — cost attribution by work phase (planning/implementation/debugging), context window pressure visualization, rate-limit gap detection, and per-project health dashboards with lifetime spend and model trends.

**Architecture:** A main-process `analytics-engine.ts` module computes derived analytics from the existing `parseTimeline()` output — no new store needed. It classifies turns into work phases (planning, implementation, debugging, coordination), builds context pressure curves from cumulative token data, detects rate-limit gaps from timestamp sequences, and aggregates per-project health metrics from `listConversations()`. Two IPC handlers serve the renderer: one for single-conversation deep analytics, one for cross-project health dashboards. The renderer gets a new `AnalyticsView` with tabbed sections reusing existing CSS patterns.

**Tech Stack:** TypeScript, Electron IPC, React 18, Zustand, Phosphor Icons, pure CSS

**Scoping note:** "Agent effectiveness score" (git outcome correlation) is deferred — it requires git integration we don't have wired yet. Everything else computes purely from JSONL data.

---

## Task 1: Types

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Add analytics types after the TimelineData interface**

```typescript
// ─── Analytics (Phase 4) ────────────────────────────────────────────────────

export type WorkPhase = 'planning' | 'implementation' | 'debugging' | 'coordination' | 'responding'

export interface PhaseCostBucket {
  phase: WorkPhase
  costUsd: number
  turns: number
  tokens: number
  pct: number
}

export interface ContextPressurePoint {
  turnIndex: number
  timestamp: string
  cumulativeInput: number
  cumulativeOutput: number
  cumulativeCacheRead: number
  cumulativeCacheWrite: number
  cacheHitRatio: number
}

export interface RateLimitGap {
  afterTurnIndex: number
  timestamp: string
  gapMs: number
  gapLabel: string
}

export interface ConversationAnalytics {
  phaseCosts: PhaseCostBucket[]
  contextPressure: ContextPressurePoint[]
  rateLimitGaps: RateLimitGap[]
  peakInputTokens: number
  avgCacheHitRatio: number
  longestGapMs: number
}

export interface ProjectHealthMetrics {
  projectSlug: string
  projectName: string
  lifetimeCostUsd: number
  lifetimeTokens: number
  conversationCount: number
  totalTurns: number
  avgCostPerConversation: number
  modelBreakdown: { model: string; costUsd: number; turns: number }[]
  weeklySpend: { week: string; costUsd: number; conversations: number }[]
  phaseBreakdown: PhaseCostBucket[]
}

export interface AnalyticsDashboard {
  projects: ProjectHealthMetrics[]
  totalCostUsd: number
  totalConversations: number
  totalTurns: number
}
```

**Step 2: Add `'analytics'` to the `AppView` type**

Find the `AppView` type and append `| 'analytics'`.

**Step 3: Add analytics IPC methods to `LatchAPI`**

After the timeline methods:

```typescript
  // Analytics
  getConversationAnalytics(payload: { filePath: string }): Promise<{ ok: boolean; analytics: ConversationAnalytics | null; error?: string }>;
  getAnalyticsDashboard(): Promise<{ ok: boolean; dashboard: AnalyticsDashboard | null; error?: string }>;
```

**Step 4: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(analytics): add deep analytics types"
```

---

## Task 2: Analytics Engine

**Files:**
- Create: `src/main/lib/analytics-engine.ts`

**Step 1: Create the analytics engine**

This module takes `TimelineData` (already parsed) and computes derived analytics.

```typescript
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

  return {
    phaseCosts,
    contextPressure,
    rateLimitGaps,
    peakInputTokens,
    avgCacheHitRatio,
    longestGapMs,
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
```

**Step 2: Commit**

```bash
git add src/main/lib/analytics-engine.ts
git commit -m "feat(analytics): add analytics engine with phase costs, context pressure, rate-limit gaps"
```

---

## Task 3: IPC Handlers

**Files:**
- Modify: `src/main/index.ts`

**Step 1: Add analytics import**

With the other imports at the top:

```typescript
import { computeConversationAnalytics, computeDashboard } from './lib/analytics-engine'
```

**Step 2: Add IPC handlers after the timeline handlers**

```typescript
  // ── Analytics ───────────────────────────────────────────────────────────

  ipcMain.handle('latch:analytics-conversation', async (_event: any, payload: any = {}) => {
    if (!payload.filePath) return { ok: false, analytics: null, error: 'filePath required' }
    try {
      const data = parseTimeline(payload.filePath)
      const analytics = computeConversationAnalytics(data)
      return { ok: true, analytics }
    } catch (err: unknown) {
      return { ok: false, analytics: null, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('latch:analytics-dashboard', async () => {
    try {
      const conversations = listConversations()

      // Group by project slug
      const projectMap = new Map<string, {
        name: string
        conversations: typeof conversations
        timelines: ReturnType<typeof parseTimeline>[]
      }>()

      for (const conv of conversations) {
        let entry = projectMap.get(conv.projectSlug)
        if (!entry) {
          entry = { name: conv.projectName, conversations: [], timelines: [] }
          projectMap.set(conv.projectSlug, entry)
        }
        entry.conversations.push(conv)
      }

      // Parse timelines — limit to most recent 5 per project to avoid blocking
      for (const [, entry] of projectMap) {
        const recent = entry.conversations.slice(0, 5)
        for (const conv of recent) {
          try {
            entry.timelines.push(parseTimeline(conv.filePath))
          } catch { /* skip unparseable files */ }
        }
      }

      const dashboard = computeDashboard(projectMap)
      return { ok: true, dashboard }
    } catch (err: unknown) {
      return { ok: false, dashboard: null, error: err instanceof Error ? err.message : String(err) }
    }
  })
```

**Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(analytics): add analytics IPC handlers"
```

---

## Task 4: Preload Bridge

**Files:**
- Modify: `src/preload/index.ts`

**Step 1: Add analytics methods after timeline methods**

```typescript
  // ── Analytics ──────────────────────────────────────────────────────────
  getConversationAnalytics: (payload: { filePath: string }) =>
    ipcRenderer.invoke('latch:analytics-conversation', payload),

  getAnalyticsDashboard: () =>
    ipcRenderer.invoke('latch:analytics-dashboard'),
```

**Step 2: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(analytics): add analytics preload bridge"
```

---

## Task 5: Zustand Store

**Files:**
- Modify: `src/renderer/store/useAppStore.ts`

**Step 1: Add type imports**

Extend the existing type import from `../../types`:

```typescript
import type { ..., ConversationAnalytics, AnalyticsDashboard } from '../../types'
```

**Step 2: Add state fields after timeline state**

```typescript
  // ── Analytics ─────────────────────────────────────────────────────────────
  analyticsConv: ConversationAnalytics | null;
  analyticsDashboard: AnalyticsDashboard | null;
  analyticsLoading: boolean;
  analyticsTab: 'dashboard' | 'conversation';
```

**Step 3: Add action signatures**

```typescript
  // Analytics
  loadAnalyticsDashboard:      () => Promise<void>;
  loadConversationAnalytics:   (filePath: string) => Promise<void>;
  setAnalyticsTab:             (tab: 'dashboard' | 'conversation') => void;
```

**Step 4: Add initial state**

```typescript
  analyticsConv:        null,
  analyticsDashboard:   null,
  analyticsLoading:     false,
  analyticsTab:         'dashboard',
```

**Step 5: Add action implementations after timeline actions**

```typescript
  // ── Analytics ──────────────────────────────────────────────────────────

  loadAnalyticsDashboard: async () => {
    set({ analyticsLoading: true })
    const result = await window.latch?.getAnalyticsDashboard?.()
    set({
      analyticsDashboard: result?.dashboard ?? null,
      analyticsLoading: false,
    })
  },

  loadConversationAnalytics: async (filePath: string) => {
    set({ analyticsLoading: true })
    const result = await window.latch?.getConversationAnalytics?.({ filePath })
    set({
      analyticsConv: result?.analytics ?? null,
      analyticsLoading: false,
      analyticsTab: 'conversation',
    })
  },

  setAnalyticsTab: (tab) => {
    set({ analyticsTab: tab })
  },
```

**Step 6: Commit**

```bash
git add src/renderer/store/useAppStore.ts
git commit -m "feat(analytics): add analytics state and actions to Zustand store"
```

---

## Task 6: App.tsx + Sidebar Wiring

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/Sidebar.tsx`

**Step 1: Import AnalyticsView in App.tsx**

```typescript
import AnalyticsView from './components/AnalyticsView'
```

**Step 2: Add analytics route after timeline route**

```typescript
  } else if (activeView === 'analytics') {
    mainContent = <AnalyticsView />
```

**Step 3: Add Analytics nav item in Sidebar**

Import the icon (add `TrendUp` to the phosphor import):

```typescript
import { Terminal, Broadcast, Lock, Robot, HardDrives, Gear, BookOpenText, Target, Plugs, ShieldCheck, ChartBar, GitBranch, TrendUp } from '@phosphor-icons/react'
```

After the Timeline button in the OBSERVE section, before Radar:

```tsx
        <button
          className={`sidebar-nav-item${activeView === 'analytics' ? ' is-active' : ''}`}
          onClick={() => setActiveView('analytics')}
        >
          <TrendUp className="sidebar-nav-icon" weight="light" />
          Analytics
        </button>
```

**Step 4: Commit**

```bash
git add src/renderer/App.tsx src/renderer/components/Sidebar.tsx
git commit -m "feat(analytics): wire analytics view route and sidebar nav"
```

---

## Task 7: AnalyticsView Component + CSS

**Files:**
- Create: `src/renderer/components/AnalyticsView.tsx`
- Modify: `src/renderer/styles.css`

**Step 1: Create AnalyticsView**

```tsx
// src/renderer/components/AnalyticsView.tsx

/**
 * @module AnalyticsView
 * @description Deep analytics dashboard — cost attribution by work phase,
 * context window pressure, rate-limit gaps, and per-project health.
 */

import React, { useEffect, useMemo } from 'react'
import { TrendUp } from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'
import type { WorkPhase, PhaseCostBucket, ContextPressurePoint, RateLimitGap, ProjectHealthMetrics } from '../../types'

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatCost(usd: number | undefined | null): string {
  const v = usd ?? 0
  if (v >= 100) return `$${v.toFixed(0)}`
  if (v >= 10) return `$${v.toFixed(1)}`
  if (v >= 0.01) return `$${v.toFixed(2)}`
  return `$${v.toFixed(3)}`
}

function formatTokens(n: number | undefined | null): string {
  const v = n ?? 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  return String(v)
}

function formatPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

const PHASE_COLORS: Record<WorkPhase, string> = {
  planning:       'rgb(var(--d-blue))',
  implementation: 'rgb(var(--d-green))',
  debugging:      'rgb(var(--d-red, 248 113 113))',
  coordination:   'rgb(168, 85, 247)',
  responding:     'var(--text-tertiary)',
}

const PHASE_LABELS: Record<WorkPhase, string> = {
  planning:       'Planning',
  implementation: 'Implementation',
  debugging:      'Debugging',
  coordination:   'Coordination',
  responding:     'Responding',
}

// ── Component ───────────────────────────────────────────────────────────────

export default function AnalyticsView() {
  const {
    analyticsDashboard,
    analyticsConv,
    analyticsLoading,
    analyticsTab,
    timelineConversations,
    loadAnalyticsDashboard,
    loadConversationAnalytics,
    loadTimelineConversations,
    setAnalyticsTab,
  } = useAppStore()

  useEffect(() => {
    loadAnalyticsDashboard()
    loadTimelineConversations()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Loading / Empty ─────────────────────────────────────────────────

  if (analyticsLoading && !analyticsDashboard && !analyticsConv) {
    return (
      <div className="view-container">
        <div className="view-header"><h1 className="view-title">Analytics</h1></div>
        <div className="an-empty"><span className="an-empty-text">Crunching numbers...</span></div>
      </div>
    )
  }

  return (
    <div className="view-container">
      <div className="view-header">
        <h1 className="view-title">Analytics</h1>
      </div>

      {/* ── Tab bar ──────────────────────────────────────── */}
      <div className="an-tabs">
        <button
          className={`an-tab${analyticsTab === 'dashboard' ? ' is-active' : ''}`}
          onClick={() => setAnalyticsTab('dashboard')}
        >
          Projects
        </button>
        <button
          className={`an-tab${analyticsTab === 'conversation' ? ' is-active' : ''}`}
          onClick={() => setAnalyticsTab('conversation')}
        >
          Conversation
        </button>
      </div>

      {analyticsTab === 'dashboard' ? (
        <DashboardTab />
      ) : (
        <ConversationTab />
      )}
    </div>
  )
}

// ── Dashboard Tab ───────────────────────────────────────────────────────────

function DashboardTab() {
  const { analyticsDashboard, analyticsLoading, loadAnalyticsDashboard } = useAppStore()

  useEffect(() => {
    if (!analyticsDashboard && !analyticsLoading) loadAnalyticsDashboard()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!analyticsDashboard) {
    return (
      <div className="an-empty">
        <TrendUp size={48} weight="light" className="an-empty-icon" />
        <span className="an-empty-text">No analytics data yet</span>
        <span className="an-empty-hint">Conversation data from ~/.claude/projects/ will be analyzed here.</span>
      </div>
    )
  }

  const { projects, totalCostUsd, totalConversations, totalTurns } = analyticsDashboard

  return (
    <>
      {/* ── Global stats ───────────────────────────────── */}
      <div className="an-stats-grid">
        <div className="an-stat-card">
          <div className="an-stat-value">{formatCost(totalCostUsd)}</div>
          <div className="an-stat-label">Lifetime</div>
        </div>
        <div className="an-stat-card">
          <div className="an-stat-value">{totalConversations}</div>
          <div className="an-stat-label">Conversations</div>
        </div>
        <div className="an-stat-card">
          <div className="an-stat-value">{formatTokens(totalTurns)}</div>
          <div className="an-stat-label">Total Turns</div>
        </div>
        <div className="an-stat-card">
          <div className="an-stat-value">{projects.length}</div>
          <div className="an-stat-label">Projects</div>
        </div>
      </div>

      {/* ── Per-project cards ──────────────────────────── */}
      <div className="view-section-label">Projects</div>
      <div className="an-project-list">
        {projects.map((p) => (
          <ProjectCard key={p.projectSlug} project={p} totalCost={totalCostUsd} />
        ))}
      </div>
    </>
  )
}

function ProjectCard({ project: p, totalCost }: { project: ProjectHealthMetrics; totalCost: number }) {
  const costPct = totalCost > 0 ? p.lifetimeCostUsd / totalCost : 0

  return (
    <div className="an-project-card">
      <div className="an-project-header">
        <span className="an-project-name">{p.projectName}</span>
        <span className="an-project-cost">{formatCost(p.lifetimeCostUsd)}</span>
      </div>

      {/* Cost bar relative to total */}
      <div className="an-project-bar-track">
        <div className="an-project-bar-fill" style={{ width: `${costPct * 100}%` }} />
      </div>

      {/* Phase breakdown bar */}
      {p.phaseBreakdown.length > 0 && (
        <div className="an-phase-bar">
          {p.phaseBreakdown.map((b) => (
            <div
              key={b.phase}
              className="an-phase-segment"
              style={{ width: `${b.pct * 100}%`, background: PHASE_COLORS[b.phase] }}
              title={`${PHASE_LABELS[b.phase]}: ${formatCost(b.costUsd)} (${formatPct(b.pct)})`}
            />
          ))}
        </div>
      )}

      <div className="an-project-meta">
        <span>{p.conversationCount} conversations</span>
        <span>{formatTokens(p.totalTurns)} turns</span>
        <span>avg {formatCost(p.avgCostPerConversation)}/conv</span>
        {p.modelBreakdown.length > 0 && (
          <span>{p.modelBreakdown.map(m => m.model.replace('claude-', '')).join(', ')}</span>
        )}
      </div>

      {/* Weekly spend sparkline */}
      {p.weeklySpend.length > 1 && (
        <WeeklySparkline weeks={p.weeklySpend} />
      )}
    </div>
  )
}

function WeeklySparkline({ weeks }: { weeks: { week: string; costUsd: number; conversations: number }[] }) {
  const maxCost = Math.max(...weeks.map(w => w.costUsd), 0.01)

  return (
    <div className="an-weekly-sparkline">
      {weeks.map((w) => (
        <div
          key={w.week}
          className="an-weekly-bar"
          style={{
            height: `${Math.max((w.costUsd / maxCost) * 100, 3)}%`,
            opacity: w.costUsd > 0 ? 0.4 + (w.costUsd / maxCost) * 0.6 : 0.15,
          }}
          title={`${w.week}: ${formatCost(w.costUsd)}, ${w.conversations} conv`}
        />
      ))}
    </div>
  )
}

// ── Conversation Tab ────────────────────────────────────────────────────────

function ConversationTab() {
  const {
    analyticsConv,
    timelineConversations,
    loadConversationAnalytics,
  } = useAppStore()

  if (!analyticsConv) {
    return (
      <>
        <div className="view-section-label">Select a conversation</div>
        <div className="tl-conversation-list">
          {timelineConversations.map((conv) => (
            <button
              key={conv.id}
              className="tl-conversation-item"
              onClick={() => loadConversationAnalytics(conv.filePath)}
            >
              <div className="tl-conv-top">
                <span className="tl-conv-project">{conv.projectName}</span>
                <span className="tl-conv-date">
                  {new Date(conv.lastModified).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                </span>
              </div>
              {conv.promptPreview && (
                <div className="tl-conv-prompt">{conv.promptPreview}</div>
              )}
              <div className="tl-conv-bottom">
                <span className="tl-conv-stats">{conv.turnCount ?? 0} turns · {formatTokens(conv.totalTokens)} tokens</span>
                <span className="tl-conv-cost">{formatCost(conv.totalCostUsd)}</span>
              </div>
            </button>
          ))}
        </div>
      </>
    )
  }

  return (
    <>
      <div className="view-header-actions" style={{ marginBottom: 16 }}>
        <button
          className="view-action-btn"
          onClick={() => useAppStore.setState({ analyticsConv: null })}
        >
          Back
        </button>
      </div>

      {/* Phase cost breakdown */}
      <div className="view-section-label">Cost by Phase</div>
      <PhaseCostSection buckets={analyticsConv.phaseCosts} />

      {/* Context pressure */}
      <div className="view-section-label">Context Pressure</div>
      <ContextPressureSection
        points={analyticsConv.contextPressure}
        peakInput={analyticsConv.peakInputTokens}
        avgCacheHit={analyticsConv.avgCacheHitRatio}
      />

      {/* Rate limit gaps */}
      {analyticsConv.rateLimitGaps.length > 0 && (
        <>
          <div className="view-section-label">
            Rate Limit Gaps
            <span className="an-gap-count">{analyticsConv.rateLimitGaps.length}</span>
          </div>
          <RateLimitSection gaps={analyticsConv.rateLimitGaps} />
        </>
      )}
    </>
  )
}

// ── Phase Cost Section ──────────────────────────────────────────────────────

function PhaseCostSection({ buckets }: { buckets: PhaseCostBucket[] }) {
  if (buckets.length === 0) return <div className="an-empty-text">No phase data</div>

  return (
    <div className="an-phase-section">
      {/* Stacked bar */}
      <div className="an-phase-bar an-phase-bar-large">
        {buckets.map((b) => (
          <div
            key={b.phase}
            className="an-phase-segment"
            style={{ width: `${b.pct * 100}%`, background: PHASE_COLORS[b.phase] }}
          />
        ))}
      </div>

      {/* Legend with details */}
      <div className="an-phase-legend">
        {buckets.map((b) => (
          <div key={b.phase} className="an-phase-legend-item">
            <span className="an-phase-dot" style={{ background: PHASE_COLORS[b.phase] }} />
            <span className="an-phase-name">{PHASE_LABELS[b.phase]}</span>
            <span className="an-phase-pct">{formatPct(b.pct)}</span>
            <span className="an-phase-cost">{formatCost(b.costUsd)}</span>
            <span className="an-phase-detail">{b.turns} turns</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Context Pressure Section ────────────────────────────────────────────────

function ContextPressureSection({
  points,
  peakInput,
  avgCacheHit,
}: {
  points: ContextPressurePoint[]
  peakInput: number
  avgCacheHit: number
}) {
  if (points.length === 0) return <div className="an-empty-text">No context data</div>

  const maxTokens = Math.max(...points.map(p => p.cumulativeInput + p.cumulativeCacheRead), 1)

  return (
    <div className="an-context-section">
      {/* Summary stats */}
      <div className="an-context-stats">
        <div className="an-context-stat">
          <span className="an-context-stat-value">{formatTokens(peakInput)}</span>
          <span className="an-context-stat-label">Peak Input</span>
        </div>
        <div className="an-context-stat">
          <span className="an-context-stat-value" style={{ color: avgCacheHit >= 0.5 ? 'var(--success)' : 'var(--warning)' }}>
            {formatPct(avgCacheHit)}
          </span>
          <span className="an-context-stat-label">Avg Cache Hit</span>
        </div>
      </div>

      {/* Mini area chart — pure CSS bars */}
      <div className="an-context-chart">
        {points.map((p, i) => {
          // Only render every Nth point if too many
          if (points.length > 200 && i % Math.ceil(points.length / 200) !== 0 && i !== points.length - 1) return null
          const totalHeight = (p.cumulativeInput + p.cumulativeCacheRead) / maxTokens
          const cacheHeight = p.cumulativeCacheRead / maxTokens

          return (
            <div
              key={p.turnIndex}
              className="an-context-bar"
              title={`Turn ${p.turnIndex + 1}: ${formatTokens(p.cumulativeInput)} input, ${formatPct(p.cacheHitRatio)} cache`}
            >
              <div
                className="an-context-bar-input"
                style={{ height: `${totalHeight * 100}%` }}
              />
              <div
                className="an-context-bar-cache"
                style={{ height: `${cacheHeight * 100}%` }}
              />
            </div>
          )
        })}
      </div>

      <div className="an-context-legend">
        <span className="an-context-legend-item">
          <span className="an-context-legend-dot" style={{ background: 'rgba(255,255,255,0.3)' }} />
          Input
        </span>
        <span className="an-context-legend-item">
          <span className="an-context-legend-dot" style={{ background: 'var(--success)' }} />
          Cache Read
        </span>
      </div>
    </div>
  )
}

// ── Rate Limit Section ──────────────────────────────────────────────────────

function RateLimitSection({ gaps }: { gaps: RateLimitGap[] }) {
  return (
    <div className="an-gap-list">
      {gaps.map((g, i) => (
        <div key={i} className="an-gap-item">
          <span className="an-gap-duration">{g.gapLabel}</span>
          <span className="an-gap-detail">after turn #{g.afterTurnIndex + 1}</span>
          <span className="an-gap-time">
            {new Date(g.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </span>
        </div>
      ))}
    </div>
  )
}
```

**Step 2: Add CSS at the end of `src/renderer/styles.css`**

```css
/* ── Analytics View ────────────────────────────────────────────────────────── */

.an-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 80px 0;
  text-align: center;
}

.an-empty-icon { color: var(--text-tertiary); margin-bottom: 8px; }
.an-empty-text { font-size: 14px; color: var(--text-secondary); }
.an-empty-hint { font-size: 12px; color: var(--text-tertiary); max-width: 320px; line-height: 1.5; }

/* ── Tabs ──────────────────────────────────────────────────────────────── */

.an-tabs {
  display: flex;
  gap: 2px;
  margin-bottom: 24px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  overflow: hidden;
}

.an-tab {
  flex: 1;
  padding: 10px 16px;
  background: var(--bg-card);
  border: none;
  cursor: pointer;
  font-size: 12px;
  font-family: var(--font-mono);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
  transition: background 120ms ease, color 120ms ease;
}

.an-tab:hover { color: var(--text-secondary); background: var(--bg-card-hover); }
.an-tab.is-active { color: var(--text-primary); background: var(--bg-card-hover); }

/* ── Stat cards ────────────────────────────────────────────────────────── */

.an-stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 24px;
}

.an-stat-card {
  padding: 16px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-card);
  text-align: center;
}

.an-stat-value {
  font-size: 24px;
  font-family: var(--font-mono);
  color: var(--text-primary);
  line-height: 1.2;
}

.an-stat-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-tertiary);
  margin-top: 4px;
  font-family: var(--font-mono);
}

/* ── Project list ──────────────────────────────────────────────────────── */

.an-project-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  overflow: hidden;
}

.an-project-card {
  padding: 14px 16px;
  background: var(--bg-card);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.an-project-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.an-project-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.an-project-cost {
  font-size: 14px;
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--text-primary);
}

.an-project-bar-track {
  height: 4px;
  background: rgba(255,255,255,0.05);
  border-radius: 2px;
  overflow: hidden;
}

.an-project-bar-fill {
  height: 100%;
  background: var(--text-primary);
  border-radius: 2px;
  opacity: 0.4;
  transition: width 400ms ease;
}

.an-project-meta {
  display: flex;
  gap: 12px;
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
}

/* ── Phase bar ─────────────────────────────────────────────────────────── */

.an-phase-bar {
  display: flex;
  height: 8px;
  border-radius: 4px;
  overflow: hidden;
  background: rgba(255,255,255,0.03);
}

.an-phase-bar-large { height: 12px; border-radius: 6px; }

.an-phase-segment {
  min-width: 2px;
  transition: width 400ms ease;
}

.an-phase-section {
  padding: 16px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-card);
  margin-bottom: 8px;
}

.an-phase-legend {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
}

.an-phase-legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-secondary);
}

.an-phase-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

.an-phase-name { min-width: 100px; }
.an-phase-pct { min-width: 36px; color: var(--text-primary); font-weight: 600; }
.an-phase-cost { min-width: 56px; }
.an-phase-detail { color: var(--text-tertiary); }

/* ── Context pressure ──────────────────────────────────────────────────── */

.an-context-section {
  padding: 16px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-card);
  margin-bottom: 8px;
}

.an-context-stats {
  display: flex;
  gap: 24px;
  margin-bottom: 12px;
}

.an-context-stat { display: flex; align-items: baseline; gap: 6px; }

.an-context-stat-value {
  font-size: 16px;
  font-family: var(--font-mono);
  color: var(--text-primary);
}

.an-context-stat-label {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  text-transform: uppercase;
}

.an-context-chart {
  display: flex;
  align-items: flex-end;
  gap: 1px;
  height: 80px;
  padding: 4px 0;
}

.an-context-bar {
  flex: 1;
  position: relative;
  height: 100%;
  min-width: 1px;
}

.an-context-bar-input {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: rgba(255,255,255,0.15);
  border-radius: 1px 1px 0 0;
}

.an-context-bar-cache {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--success);
  opacity: 0.5;
  border-radius: 1px 1px 0 0;
}

.an-context-legend {
  display: flex;
  gap: 16px;
  margin-top: 8px;
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
}

.an-context-legend-item { display: flex; align-items: center; gap: 5px; }

.an-context-legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

/* ── Rate limit gaps ───────────────────────────────────────────────────── */

.an-gap-count {
  margin-left: 8px;
  font-size: 10px;
  font-weight: 700;
  min-width: 18px;
  height: 18px;
  line-height: 18px;
  text-align: center;
  border-radius: 9px;
  background: rgba(251,191,36,0.15);
  color: var(--warning);
  padding: 0 5px;
  display: inline-block;
}

.an-gap-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  overflow: hidden;
}

.an-gap-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--bg-card);
  font-size: 12px;
  font-family: var(--font-mono);
}

.an-gap-duration {
  font-weight: 600;
  color: var(--warning);
  min-width: 60px;
}

.an-gap-detail { color: var(--text-secondary); }
.an-gap-time { margin-left: auto; color: var(--text-tertiary); font-size: 11px; }

/* ── Weekly sparkline ──────────────────────────────────────────────────── */

.an-weekly-sparkline {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 28px;
}

.an-weekly-bar {
  flex: 1;
  background: var(--text-primary);
  border-radius: 1px 1px 0 0;
  min-height: 1px;
  transition: height 300ms ease;
}
```

**Step 3: Commit**

```bash
git add src/renderer/components/AnalyticsView.tsx src/renderer/styles.css
git commit -m "feat(analytics): add AnalyticsView with phase costs, context pressure, rate-limit gaps, project health"
```

---

## Task 8: Smoke Test

**Step 1: Run the type checker**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit 2>&1 | head -40`
Expected: No new errors from our files

**Step 2: Manual verification checklist**

- [ ] Sidebar shows "Analytics" under OBSERVE (between Timeline and Radar)
- [ ] Clicking Analytics shows the Projects tab with stat cards
- [ ] Per-project cards show lifetime cost, phase breakdown bar, weekly sparkline
- [ ] Conversation tab shows conversation picker (reuses timeline list UI)
- [ ] Clicking a conversation shows Cost by Phase (stacked bar + legend)
- [ ] Context Pressure section shows cumulative token chart with cache overlay
- [ ] Rate Limit Gaps section shows detected gaps with duration and turn number
- [ ] Back button returns to conversation picker
- [ ] Tab switching between Projects and Conversation works
