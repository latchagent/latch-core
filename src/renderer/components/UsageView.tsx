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
      const isProject = s.sessionId?.startsWith('project:') ?? false
      if (isProject && s.sessionId) {
        // Extract readable project name from slug like "project:-Users-cbryant-code-latch-core"
        const slug = s.sessionId.replace('project:', '')
        const parts = slug.split('-').filter(Boolean)
        name = parts[parts.length - 1] ?? slug // last path segment
      } else if (!name && s.sessionId) {
        const session = sessions.get(s.sessionId)
        name = session?.name ?? null
      }
      return {
        ...s,
        displayName: name ?? s.sessionId ?? 'Untracked',
        costRatio: s.totalCostUsd / maxCost,
        isProject,
      }
    })
  }, [usageSummary, sessions])

  const latchSessions = useMemo(() => sessionCards.filter((s) => !s.isProject), [sessionCards])
  const projectSessions = useMemo(() => sessionCards.filter((s) => s.isProject), [sessionCards])

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
          {latchSessions.length > 0 && (
            <div className="usage-section">
              <div className="view-section-label">Sessions</div>
              <div className="usage-session-list">
                {latchSessions.map((s) => (
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

          {/* ── Projects (non-Latch Claude Code usage) ────────── */}
          {projectSessions.length > 0 && (
            <div className="usage-section">
              <div className="view-section-label">
                Projects
                <span className="usage-untracked-count">{projectSessions.length}</span>
              </div>
              <div className="usage-session-list">
                {projectSessions.map((s) => (
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
                      <span>{s.models.map(modelShortName).join(', ')}</span>
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
