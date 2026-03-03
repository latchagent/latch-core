// src/renderer/components/AnalyticsView.tsx

/**
 * @module AnalyticsView
 * @description Deep analytics dashboard — cost attribution by work phase,
 * context window pressure, rate-limit gaps, loop detection, and per-project health.
 *
 * Navigation: Dashboard → Project → Conversation
 */

import React, { useEffect, useMemo } from 'react'
import { TrendUp, ArrowLeft } from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'
import type { WorkPhase, PhaseCostBucket, ContextPressurePoint, RateLimitGap, ProjectHealthMetrics, LoopPattern } from '../../types'

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

const LOOP_ICONS: Record<string, string> = {
  'repeated-read':    '↻',
  'repeated-failure': '✗',
  'write-cycle':      '⇄',
  'cost-spike':       '↑',
}

const LOOP_COLORS: Record<string, string> = {
  'repeated-read':    'var(--warning)',
  'repeated-failure': 'rgb(var(--d-red, 248 113 113))',
  'write-cycle':      'rgb(168, 85, 247)',
  'cost-spike':       'var(--warning)',
}

// ── Root Component ──────────────────────────────────────────────────────────

export default function AnalyticsView() {
  const {
    analyticsDashboard,
    analyticsConv,
    analyticsLoading,
    analyticsProjectSlug,
    loadAnalyticsDashboard,
    loadTimelineConversations,
  } = useAppStore()

  useEffect(() => {
    loadAnalyticsDashboard()
    loadTimelineConversations()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (analyticsLoading && !analyticsDashboard && !analyticsConv) {
    return (
      <div className="view-container">
        <div className="view-header"><h1 className="view-title">Analytics</h1></div>
        <div className="an-empty"><span className="an-empty-text">Crunching numbers...</span></div>
      </div>
    )
  }

  // Drill-down: conversation selected → deep analytics
  if (analyticsConv && analyticsProjectSlug) {
    return <ConversationDetail />
  }

  // Drill-down: project selected → project conversations
  if (analyticsProjectSlug) {
    return <ProjectDetail slug={analyticsProjectSlug} />
  }

  // Top level: all projects dashboard
  return <DashboardView />
}

// ── Dashboard View (all projects) ───────────────────────────────────────────

function DashboardView() {
  const { analyticsDashboard, analyticsLoading, loadAnalyticsDashboard, setAnalyticsProjectSlug } = useAppStore()

  useEffect(() => {
    if (!analyticsDashboard && !analyticsLoading) loadAnalyticsDashboard()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!analyticsDashboard) {
    return (
      <div className="view-container">
        <div className="view-header"><h1 className="view-title">Analytics</h1></div>
        <div className="an-empty">
          <TrendUp size={48} weight="light" className="an-empty-icon" />
          <span className="an-empty-text">No analytics data yet</span>
          <span className="an-empty-hint">Conversation data from ~/.claude/projects/ will be analyzed here.</span>
        </div>
      </div>
    )
  }

  const { projects, totalCostUsd, totalConversations, totalTurns } = analyticsDashboard

  return (
    <div className="view-container">
      <div className="view-header"><h1 className="view-title">Analytics</h1></div>

      {/* Global stats */}
      <div className="an-stats-grid">
        <div className="an-stat-card">
          <div className="an-stat-value">{formatCost(totalCostUsd)}</div>
          <div className="an-stat-label">Lifetime Cost</div>
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

      {/* Phase legend */}
      <div className="an-dashboard-legend">
        <span className="an-dashboard-legend-label">Time spent:</span>
        {(['planning', 'implementation', 'debugging', 'coordination', 'responding'] as WorkPhase[]).map((phase) => (
          <span key={phase} className="an-dashboard-legend-item">
            <span className="an-phase-dot" style={{ background: PHASE_COLORS[phase] }} />
            {PHASE_LABELS[phase]}
          </span>
        ))}
      </div>

      {/* Per-project cards */}
      <div className="view-section-label">Projects</div>
      <div className="an-project-list">
        {projects.map((p) => (
          <ProjectCard
            key={p.projectSlug}
            project={p}
            onClick={() => setAnalyticsProjectSlug(p.projectSlug)}
          />
        ))}
      </div>
    </div>
  )
}

function ProjectCard({ project: p, onClick }: { project: ProjectHealthMetrics; onClick: () => void }) {
  const realModels = p.modelBreakdown.filter(m => m.model !== 'synthetic' && m.model !== '<synthetic>')
  const modelText = realModels.length > 0
    ? realModels.map(m => m.model.replace('claude-', '')).join(', ')
    : null

  return (
    <div className="an-project-card an-project-card-clickable" onClick={onClick}>
      <div className="an-project-header">
        <span className="an-project-name">{p.projectName}</span>
        <span className="an-project-cost">{formatCost(p.lifetimeCostUsd)}</span>
      </div>

      {p.phaseBreakdown.length > 0 && (
        <div className="an-phase-bar">
          {p.phaseBreakdown.map((b) => (
            <div
              key={b.phase}
              className="an-phase-segment an-tip"
              data-tip={`${PHASE_LABELS[b.phase]}: ${formatCost(b.costUsd)} (${formatPct(b.pct)})`}
              style={{ width: `${b.pct * 100}%`, background: PHASE_COLORS[b.phase] }}
            />
          ))}
        </div>
      )}

      <div className="an-project-meta">
        <span>{p.conversationCount} conv</span>
        <span>{formatTokens(p.totalTurns)} turns</span>
        <span>avg {formatCost(p.avgCostPerConversation)}/conv</span>
        {modelText && <span>{modelText}</span>}
      </div>

      {p.weeklySpend.length > 1 && (
        <div className="an-weekly-row">
          <span className="an-weekly-label">Weekly spend</span>
          <WeeklySparkline weeks={p.weeklySpend} />
        </div>
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
          className="an-weekly-bar an-tip"
          data-tip={`${w.week}: ${formatCost(w.costUsd)}, ${w.conversations} conv`}
          style={{ height: `${Math.max((w.costUsd / maxCost) * 100, 4)}%` }}
        />
      ))}
    </div>
  )
}

// ── Project Detail (conversations for one project) ──────────────────────────

function ProjectDetail({ slug }: { slug: string }) {
  const {
    analyticsDashboard,
    timelineConversations,
    setAnalyticsProjectSlug,
    loadConversationAnalytics,
  } = useAppStore()

  // Find the project health data
  const project = analyticsDashboard?.projects.find(p => p.projectSlug === slug)

  // Filter conversations to this project
  const projectConversations = useMemo(
    () => timelineConversations.filter(c => c.projectSlug === slug),
    [timelineConversations, slug],
  )

  const projectName = project?.projectName ?? projectConversations[0]?.projectName ?? slug

  return (
    <div className="view-container">
      <div className="view-header">
        <button className="an-back-btn" onClick={() => setAnalyticsProjectSlug(null)}>
          <ArrowLeft size={16} weight="bold" />
          All Projects
        </button>
        <h1 className="view-title">{projectName}</h1>
      </div>

      {/* Project stats */}
      {project && (
        <div className="an-stats-grid">
          <div className="an-stat-card">
            <div className="an-stat-value">{formatCost(project.lifetimeCostUsd)}</div>
            <div className="an-stat-label">Total Cost</div>
          </div>
          <div className="an-stat-card">
            <div className="an-stat-value">{project.conversationCount}</div>
            <div className="an-stat-label">Conversations</div>
          </div>
          <div className="an-stat-card">
            <div className="an-stat-value">{formatTokens(project.totalTurns)}</div>
            <div className="an-stat-label">Total Turns</div>
          </div>
          <div className="an-stat-card">
            <div className="an-stat-value">{formatCost(project.avgCostPerConversation)}</div>
            <div className="an-stat-label">Avg Cost / Conv</div>
          </div>
        </div>
      )}

      {/* Phase breakdown */}
      {project && project.phaseBreakdown.length > 0 && (
        <>
          <div className="view-section-label">Phase Breakdown</div>
          <PhaseCostSection buckets={project.phaseBreakdown} />
        </>
      )}

      {/* Conversations list */}
      <div className="view-section-label">Conversations ({projectConversations.length})</div>
      {projectConversations.length === 0 ? (
        <div className="an-empty-text">No conversations found for this project.</div>
      ) : (
        <div className="tl-conversation-list">
          {projectConversations.map((conv) => (
            <button
              key={conv.id}
              className="tl-conversation-item"
              onClick={() => loadConversationAnalytics(conv.filePath)}
            >
              <div className="tl-conv-top">
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
      )}
    </div>
  )
}

// ── Conversation Detail (deep analytics for one conversation) ───────────────

function ConversationDetail() {
  const { analyticsConv, analyticsProjectSlug, setAnalyticsProjectSlug } = useAppStore()

  if (!analyticsConv) return null

  return (
    <div className="view-container">
      <div className="view-header">
        <button
          className="an-back-btn"
          onClick={() => useAppStore.setState({ analyticsConv: null })}
        >
          <ArrowLeft size={16} weight="bold" />
          Back to Project
        </button>
        <h1 className="view-title">Conversation Analytics</h1>
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

      {/* Loop detection */}
      {analyticsConv.loops.length > 0 && (
        <>
          <div className="view-section-label">
            Loops Detected
            <span className="an-gap-count">{analyticsConv.loops.length}</span>
          </div>
          <LoopSection loops={analyticsConv.loops} totalWasted={analyticsConv.totalWastedCostUsd} />
        </>
      )}
    </div>
  )
}

// ── Phase Cost Section ──────────────────────────────────────────────────────

function PhaseCostSection({ buckets }: { buckets: PhaseCostBucket[] }) {
  if (buckets.length === 0) return <div className="an-empty-text">No phase data</div>

  return (
    <div className="an-phase-section">
      <div className="an-phase-bar an-phase-bar-large">
        {buckets.map((b) => (
          <div
            key={b.phase}
            className="an-phase-segment an-tip"
            data-tip={`${PHASE_LABELS[b.phase]}: ${formatCost(b.costUsd)} · ${b.turns} turns (${formatPct(b.pct)})`}
            style={{ width: `${b.pct * 100}%`, background: PHASE_COLORS[b.phase] }}
          />
        ))}
      </div>

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

      <div className="an-context-chart">
        {points.map((p, i) => {
          if (points.length > 200 && i % Math.ceil(points.length / 200) !== 0 && i !== points.length - 1) return null
          const totalHeight = (p.cumulativeInput + p.cumulativeCacheRead) / maxTokens
          const cacheHeight = p.cumulativeCacheRead / maxTokens

          return (
            <div
              key={p.turnIndex}
              className="an-context-bar an-tip an-tip-above"
              data-tip={`Turn ${p.turnIndex + 1}: ${formatTokens(p.cumulativeInput)} input, ${formatPct(p.cacheHitRatio)} cache`}
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

// ── Loop Section ────────────────────────────────────────────────────────────

function LoopSection({ loops, totalWasted }: { loops: LoopPattern[]; totalWasted: number }) {
  return (
    <div className="an-loop-section">
      {totalWasted > 0 && (
        <div className="an-loop-waste-banner">
          Estimated waste: {formatCost(totalWasted)}
        </div>
      )}
      <div className="an-gap-list">
        {loops.map((loop, i) => (
          <div key={i} className="an-loop-item">
            <span className="an-loop-icon" style={{ color: LOOP_COLORS[loop.kind] }}>
              {LOOP_ICONS[loop.kind]}
            </span>
            <div className="an-loop-body">
              <span className="an-loop-label" style={{ color: LOOP_COLORS[loop.kind] }}>
                {loop.label}
              </span>
              <span className="an-loop-desc">{loop.description}</span>
            </div>
            {loop.wastedCostUsd > 0 && (
              <span className="an-loop-cost">{formatCost(loop.wastedCostUsd)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
