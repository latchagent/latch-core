/**
 * @module RadarView
 * @description Dedicated anomaly detection view showing radar signals,
 * activity statistics, and recent denied/high-risk events.
 */

import React, { useEffect, useMemo } from 'react'
import { ShieldWarning, CaretRight } from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'
import type { RadarSignal, ActivityEvent } from '../../types'

function formatTime(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ts
  }
}

function signalIcon(level: RadarSignal['level']): string {
  if (level === 'high') return '!'
  if (level === 'medium') return '~'
  return '-'
}

function SignalCard({ signal }: { signal: RadarSignal }) {
  return (
    <div className={`radar-signal-card radar-level-${signal.level}`}>
      <div className="radar-signal-icon">{signalIcon(signal.level)}</div>
      <div className="radar-signal-body">
        <div className="radar-signal-level">{signal.level.toUpperCase()}</div>
        <div className="radar-signal-message">{signal.message}</div>
        <div className="radar-signal-time">{formatTime(signal.observedAt)}</div>
      </div>
    </div>
  )
}

function DeniedEventRow({ event }: { event: ActivityEvent }) {
  return (
    <div className="radar-event-row">
      <span className="radar-event-tool">{event.toolName}</span>
      <span className={`radar-event-badge radar-badge-${event.decision}`}>
        {event.decision.toUpperCase()}
      </span>
      <span className="radar-event-risk">{event.risk.toUpperCase()}</span>
      <span className="radar-event-time">{formatTime(event.timestamp)}</span>
      {event.reason && <span className="radar-event-reason">{event.reason}</span>}
    </div>
  )
}

export default function RadarView() {
  const {
    activityEvents,
    activityTotal,
    radarSignals,
    loadActivityPanel,
  } = useAppStore()

  useEffect(() => {
    loadActivityPanel()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const deniedEvents = useMemo(
    () => activityEvents.filter((e) => e.decision === 'deny'),
    [activityEvents],
  )
  const highRiskEvents = useMemo(
    () => activityEvents.filter((e) => e.risk === 'high'),
    [activityEvents],
  )
  const allowedCount = useMemo(
    () => activityEvents.filter((e) => e.decision === 'allow').length,
    [activityEvents],
  )

  // Tool frequency for the breakdown
  const toolBreakdown = useMemo(() => {
    const map = new Map<string, { total: number; denied: number; highRisk: number }>()
    for (const e of activityEvents) {
      const entry = map.get(e.toolName) ?? { total: 0, denied: 0, highRisk: 0 }
      entry.total++
      if (e.decision === 'deny') entry.denied++
      if (e.risk === 'high') entry.highRisk++
      map.set(e.toolName, entry)
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 10)
  }, [activityEvents])

  const hasSignals = radarSignals.length > 0
  const highSignals = radarSignals.filter((s) => s.level === 'high')
  const mediumSignals = radarSignals.filter((s) => s.level === 'medium')
  const lowSignals = radarSignals.filter((s) => s.level === 'low')

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h2 className="view-title">Anomaly Detection</h2>
          <p className="view-subtitle">
            Z-score anomaly detection across tool usage, error rates, and risk levels.
          </p>
        </div>
        {activityTotal > 0 && (
          <div className="view-header-actions">
            <button className="view-action-btn" onClick={() => window.latch?.exportActivity?.({ format: 'csv' })}>
              Export CSV
            </button>
            <button className="view-action-btn" onClick={() => window.latch?.exportActivity?.({ format: 'json' })}>
              Export JSON
            </button>
          </div>
        )}
      </div>

      {/* ── Status banner ──────────────────────────────────────────────── */}
      <div className={`radar-status-banner ${hasSignals ? 'has-signals' : 'all-clear'}`}>
        <ShieldWarning size={24} weight={hasSignals ? 'fill' : 'light'} />
        <span>
          {hasSignals
            ? `${radarSignals.length} active signal${radarSignals.length !== 1 ? 's' : ''} — ${highSignals.length} high, ${mediumSignals.length} medium, ${lowSignals.length} low`
            : 'No anomalies detected — all systems nominal'}
        </span>
      </div>

      {/* ── Stats cards ────────────────────────────────────────────────── */}
      <div className="radar-stats-grid">
        <div className="radar-stat-card">
          <div className="radar-stat-value">{activityTotal}</div>
          <div className="radar-stat-label">Total Events</div>
        </div>
        <div className="radar-stat-card">
          <div className="radar-stat-value">{allowedCount}</div>
          <div className="radar-stat-label">Allowed</div>
        </div>
        <div className="radar-stat-card radar-stat-denied">
          <div className="radar-stat-value">{deniedEvents.length}</div>
          <div className="radar-stat-label">Denied</div>
        </div>
        <div className="radar-stat-card radar-stat-high">
          <div className="radar-stat-value">{highRiskEvents.length}</div>
          <div className="radar-stat-label">High Risk</div>
        </div>
      </div>

      {/* ── Active signals ─────────────────────────────────────────────── */}
      {hasSignals && (
        <div className="radar-section">
          <div className="radar-section-label">Active Signals</div>
          <div className="radar-signals-list">
            {radarSignals.map((signal, i) => (
              <SignalCard key={`${signal.id}-${i}`} signal={signal} />
            ))}
          </div>
        </div>
      )}

      {/* ── Tool breakdown ─────────────────────────────────────────────── */}
      {toolBreakdown.length > 0 && (
        <div className="radar-section">
          <div className="radar-section-label">Tool Breakdown</div>
          <div className="radar-tool-table">
            <div className="radar-tool-header">
              <span>Tool</span>
              <span>Total</span>
              <span>Denied</span>
              <span>High Risk</span>
            </div>
            {toolBreakdown.map(([tool, stats]) => (
              <div key={tool} className="radar-tool-row">
                <span className="radar-tool-name">{tool}</span>
                <span>{stats.total}</span>
                <span className={stats.denied > 0 ? 'radar-text-denied' : ''}>{stats.denied}</span>
                <span className={stats.highRisk > 0 ? 'radar-text-high' : ''}>{stats.highRisk}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Recent denied events ───────────────────────────────────────── */}
      <div className="radar-section">
        <div className="radar-section-label">
          Recent Denied Events ({deniedEvents.length})
        </div>
        {deniedEvents.length === 0 ? (
          <div className="radar-empty-section">No denied events recorded.</div>
        ) : (
          <div className="radar-events-list">
            {deniedEvents.slice(0, 20).map((event) => (
              <DeniedEventRow key={event.id} event={event} />
            ))}
          </div>
        )}
      </div>

      {/* ── Empty state ────────────────────────────────────────────────── */}
      {activityTotal === 0 && !hasSignals && (
        <div className="radar-empty">
          <div className="radar-empty-icon">
            <ShieldWarning size={40} weight="light" />
          </div>
          <div className="radar-empty-text">No activity data yet</div>
          <div className="radar-empty-hint">
            Start an agent session to see anomaly detection in action.
            The radar monitors tool call volume, error rates, new tool access, and high-risk activity surges.
          </div>
        </div>
      )}
    </div>
  )
}
