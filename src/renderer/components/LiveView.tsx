// src/renderer/components/LiveView.tsx

/**
 * @module LiveView
 * @description Real-time session tailing — session cards overview with
 * drill-down to full tool call trace, thinking summaries, and anomaly warnings.
 */

import React, { useEffect, useRef } from 'react'
import { Pulse, ArrowLeft } from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'
import type { LiveEvent, LiveSessionStats } from '../../types'

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  if (usd >= 0.01) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(3)}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatElapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime()
  const sec = Math.floor(ms / 1000) % 60
  const min = Math.floor(ms / 60_000) % 60
  const hr = Math.floor(ms / 3_600_000)
  if (hr > 0) return `${hr}h ${min}m`
  if (min > 0) return `${min}m ${sec}s`
  return `${sec}s`
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

const STATUS_COLORS: Record<string, string> = {
  active:        'var(--success)',
  thinking:      'var(--warning)',
  idle:          'var(--text-tertiary)',
  'rate-limited': 'rgb(var(--d-red, 248 113 113))',
}

const STATUS_LABELS: Record<string, string> = {
  active:        'Active',
  thinking:      'Thinking',
  idle:          'Idle',
  'rate-limited': 'Rate Limited',
}

// ── Root Component ──────────────────────────────────────────────────────────

export default function LiveView() {
  const {
    liveEvents,
    liveSessionStats,
    liveDetailSessionId,
    sessions,
    setLiveDetailSession,
  } = useAppStore()

  if (liveDetailSessionId) {
    return <SessionDetail sessionId={liveDetailSessionId} />
  }

  const activeSessions = Array.from(sessions.values())
    .filter(s => !s.showWizard || liveSessionStats.has(s.id))
    .sort((a, b) => {
      const statsA = liveSessionStats.get(a.id)
      const statsB = liveSessionStats.get(b.id)
      const tA = statsA ? new Date(statsA.lastEventAt).getTime() : 0
      const tB = statsB ? new Date(statsB.lastEventAt).getTime() : 0
      return tB - tA
    })

  return (
    <div className="view-container">
      <div className="view-header">
        <h1 className="view-title">Live</h1>
      </div>

      {activeSessions.length === 0 ? (
        <div className="an-empty">
          <Pulse size={48} weight="light" className="an-empty-icon" />
          <span className="an-empty-text">No active sessions</span>
          <span className="an-empty-hint">Start an agent session to see real-time activity here.</span>
        </div>
      ) : (
        <div className="live-card-grid">
          {activeSessions.map(session => (
            <SessionCard
              key={session.id}
              session={session}
              stats={liveSessionStats.get(session.id) ?? null}
              events={liveEvents.get(session.id) ?? []}
              onClick={() => setLiveDetailSession(session.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Session Card ────────────────────────────────────────────────────────────

function SessionCard({
  session,
  stats,
  events,
  onClick,
}: {
  session: { id: string; name: string; harnessId: string | null }
  stats: LiveSessionStats | null
  events: LiveEvent[]
  onClick: () => void
}) {
  const statusEvent = [...events].reverse().find(e => e.kind === 'status-change')
  const status = statusEvent?.sessionStatus ?? 'idle'

  const lastToolCall = [...events].reverse().find(e => e.kind === 'tool-call')
  const lastAction = lastToolCall
    ? `${lastToolCall.toolName}${lastToolCall.target ? ` ${lastToolCall.target.split('/').pop()}` : ''}`
    : null

  return (
    <div className="live-card" onClick={onClick}>
      <div className="live-card-header">
        <div className="live-card-status">
          <span
            className={`live-status-dot${status === 'active' ? ' is-pulsing' : ''}`}
            style={{ background: STATUS_COLORS[status] ?? STATUS_COLORS.idle }}
          />
          <span className="live-card-name">{session.name}</span>
        </div>
        <span className="live-card-harness">{session.harnessId ?? 'unknown'}</span>
      </div>

      <div className="live-card-stats">
        <div className="live-card-stat">
          <span className="live-card-stat-value">{formatCost(stats?.totalCostUsd ?? 0)}</span>
          <span className="live-card-stat-label">Cost</span>
        </div>
        <div className="live-card-stat">
          <span className="live-card-stat-value">{stats?.turnCount ?? 0}</span>
          <span className="live-card-stat-label">Turns</span>
        </div>
        <div className="live-card-stat">
          <span className="live-card-stat-value">{stats ? formatElapsed(stats.startedAt) : '—'}</span>
          <span className="live-card-stat-label">Elapsed</span>
        </div>
        <div className="live-card-stat">
          <span className="live-card-stat-value">{stats ? stats.filesTouched.size : 0}</span>
          <span className="live-card-stat-label">Files</span>
        </div>
      </div>

      {lastAction && (
        <div className="live-card-last-action">
          <span className="live-card-action-label">Last:</span>
          <span className="live-card-action-value">{lastAction}</span>
        </div>
      )}

      <div className="live-card-status-label" style={{ color: STATUS_COLORS[status] }}>
        {STATUS_LABELS[status] ?? status}
      </div>
    </div>
  )
}

// ── Session Detail ──────────────────────────────────────────────────────────

function SessionDetail({ sessionId }: { sessionId: string }) {
  const {
    liveEvents,
    liveSessionStats,
    sessions,
    setLiveDetailSession,
  } = useAppStore()

  const events = liveEvents.get(sessionId) ?? []
  const stats = liveSessionStats.get(sessionId)
  const session = sessions.get(sessionId)

  const streamRef = useRef<HTMLDivElement>(null)

  // Reverse chronological — newest events at top
  const reversedEvents = [...events].reverse()

  const statusEvent = [...events].reverse().find(e => e.kind === 'status-change')
  const status = statusEvent?.sessionStatus ?? 'idle'

  return (
    <div className="view-container">
      <div className="view-header">
        <button className="an-back-btn" onClick={() => setLiveDetailSession(null)}>
          <ArrowLeft size={16} weight="bold" />
          All Sessions
        </button>
        <h1 className="view-title">{session?.name ?? sessionId}</h1>
        <span
          className={`live-status-dot live-status-dot-header${status === 'active' ? ' is-pulsing' : ''}`}
          style={{ background: STATUS_COLORS[status] }}
        />
      </div>

      {stats && (
        <div className="live-stats-bar">
          <div className="live-stats-item">
            <span className="live-stats-value">{formatCost(stats.totalCostUsd)}</span>
            <span className="live-stats-label">Cost</span>
          </div>
          <div className="live-stats-item">
            <span className="live-stats-value">{stats.turnCount}</span>
            <span className="live-stats-label">Turns</span>
          </div>
          <div className="live-stats-item">
            <span className="live-stats-value">{formatElapsed(stats.startedAt)}</span>
            <span className="live-stats-label">Elapsed</span>
          </div>
          <div className="live-stats-item">
            <span className="live-stats-value">{stats.filesTouched.size}</span>
            <span className="live-stats-label">Files Touched</span>
          </div>
          <div className="live-stats-item">
            <span className="live-stats-value">{formatTokens(stats.totalInputTokens)}</span>
            <span className="live-stats-label">Input Tokens</span>
          </div>
        </div>
      )}

      <div className="live-stream" ref={streamRef}>
        {reversedEvents.length === 0 ? (
          <div className="an-empty-text" style={{ padding: 32 }}>Waiting for events...</div>
        ) : (
          reversedEvents.map(event => <EventRow key={event.id} event={event} />)
        )}
      </div>
    </div>
  )
}

// ── Event Row ───────────────────────────────────────────────────────────────

function EventRow({ event }: { event: LiveEvent }) {
  if (event.kind === 'tool-call') {
    return (
      <div className={`live-event live-event-tool${event.status === 'error' ? ' is-error' : ''}`}>
        <span className="live-event-time">{formatTime(event.timestamp)}</span>
        <span className={`live-event-status-icon${event.status === 'running' ? ' is-running' : ''}`}>
          {event.status === 'success' ? '✓' : event.status === 'error' ? '✗' : '●'}
        </span>
        <span className="live-event-tool">{event.toolName}</span>
        {event.target && <span className="live-event-target">{event.target}</span>}
        {event.costUsd != null && event.costUsd > 0 && (
          <span className="live-event-cost">{formatCost(event.costUsd)}</span>
        )}
        {event.durationMs != null && (
          <span className="live-event-duration">{(event.durationMs / 1000).toFixed(1)}s</span>
        )}
      </div>
    )
  }

  if (event.kind === 'thinking') {
    return (
      <div className="live-event live-event-thinking">
        <span className="live-event-time">{formatTime(event.timestamp)}</span>
        <span className="live-event-thinking-icon">💭</span>
        <span className="live-event-thinking-text">{event.thinkingSummary}</span>
      </div>
    )
  }

  if (event.kind === 'anomaly') {
    const isLeak = event.anomalyKind === 'credential-leak'
    const isBudget = event.anomalyKind?.startsWith('budget-') || event.anomalyKind?.startsWith('project-budget-')
    const isCheckpoint = event.anomalyKind === 'checkpoint'

    return (
      <div className={`live-event live-event-anomaly${isLeak ? ' is-leak' : ''}${isBudget ? ' is-budget' : ''}${isCheckpoint ? ' is-checkpoint' : ''}`}>
        <span className="live-event-time">{formatTime(event.timestamp)}</span>
        <span className="live-event-anomaly-icon">{isLeak ? '🔑' : isBudget ? '💰' : isCheckpoint ? '📌' : '⚠'}</span>
        <span className="live-event-anomaly-text">{event.anomalyMessage}</span>
      </div>
    )
  }

  if (event.kind === 'status-change') {
    return (
      <div className="live-event live-event-status">
        <span className="live-event-time">{formatTime(event.timestamp)}</span>
        <span
          className="live-event-status-dot"
          style={{ background: STATUS_COLORS[event.sessionStatus ?? 'idle'] }}
        />
        <span className="live-event-status-text">
          {STATUS_LABELS[event.sessionStatus ?? 'idle']}
        </span>
      </div>
    )
  }

  return null
}
