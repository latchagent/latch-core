/**
 * @module TimelineView
 * @description Session timeline replay — visualizes every agent action as
 * color-coded nodes on a horizontal strip with cost/duration annotations.
 */

import React, { useEffect, useMemo, useRef } from 'react'
import { GitBranch } from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'
import type { TimelineTurn, TimelineActionType } from '../../types'

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

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

function formatTime(timestamp: string): string {
  const d = new Date(timestamp)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatDate(timestamp: string): string {
  const d = new Date(timestamp)
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)}KB`
  return `${bytes}B`
}

const ACTION_COLORS: Record<TimelineActionType, string> = {
  read:    'rgb(var(--d-blue))',
  write:   'rgb(var(--d-green))',
  bash:    'rgb(var(--d-yellow))',
  search:  'rgb(var(--d-blue))',
  agent:   'rgb(168, 85, 247)',
  error:   'var(--error)',
  respond: 'var(--text-tertiary)',
}

const ACTION_LABELS: Record<TimelineActionType, string> = {
  read: 'Read', write: 'Write', bash: 'Bash', search: 'Search',
  agent: 'Agent', error: 'Error', respond: 'Response',
}

// ── Component ───────────────────────────────────────────────────────────────

export default function TimelineView() {
  const {
    timelineConversations,
    timelineData,
    timelineSelectedTurn,
    timelineLoading,
    loadTimelineConversations,
    loadTimeline,
    setTimelineSelectedTurn,
  } = useAppStore()

  const stripRef = useRef<HTMLDivElement>(null)

  // Load conversations on mount
  useEffect(() => {
    loadTimelineConversations()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Action type distribution for summary
  const actionCounts = useMemo(() => {
    if (!timelineData) return {}
    const counts: Partial<Record<TimelineActionType, number>> = {}
    for (const turn of timelineData.turns) {
      counts[turn.actionType] = (counts[turn.actionType] ?? 0) + 1
    }
    return counts
  }, [timelineData])

  const selectedTurn = useMemo(() => {
    if (timelineSelectedTurn === null || !timelineData) return null
    return timelineData.turns[timelineSelectedTurn] ?? null
  }, [timelineData, timelineSelectedTurn])

  // ── Conversation list ───────────────────────────────────────────────

  if (!timelineData) {
    return (
      <div className="view-container">
        <div className="view-header">
          <h1 className="view-title">Timeline</h1>
        </div>

        {timelineLoading ? (
          <div className="tl-empty">
            <span className="tl-empty-text">Loading timeline...</span>
          </div>
        ) : timelineConversations.length === 0 ? (
          <div className="tl-empty">
            <GitBranch size={48} weight="light" className="tl-empty-icon" />
            <span className="tl-empty-text">No conversations found</span>
            <span className="tl-empty-hint">
              Claude Code conversation logs from ~/.claude/projects/ will appear here.
            </span>
          </div>
        ) : (
          <div className="tl-conversation-list">
            {timelineConversations.map((conv) => (
              <button
                key={conv.id}
                className="tl-conversation-item"
                onClick={() => loadTimeline(conv.filePath)}
              >
                <div className="tl-conv-top">
                  <span className="tl-conv-project">{conv.projectName}</span>
                  <span className="tl-conv-date">{formatDate(conv.lastModified)}</span>
                </div>
                {conv.promptPreview && (
                  <div className="tl-conv-prompt">{conv.promptPreview}</div>
                )}
                <div className="tl-conv-bottom">
                  <span className="tl-conv-stats">
                    {conv.turnCount ?? 0} turns · {formatTokens(conv.totalTokens)} tokens
                  </span>
                  <span className="tl-conv-cost">{formatCost(conv.totalCostUsd)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── Timeline view ───────────────────────────────────────────────────

  const { turns } = timelineData

  return (
    <div className="view-container">
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="view-header">
        <h1 className="view-title">Timeline</h1>
        <div className="view-header-actions">
          <button
            className="view-action-btn"
            onClick={() => {
              useAppStore.setState({ timelineData: null, timelineSelectedTurn: null })
            }}
          >
            Back
          </button>
        </div>
      </div>

      {/* ── Summary stats ──────────────────────────────────────── */}
      <div className="tl-summary">
        <div className="tl-summary-item">
          <span className="tl-summary-value">{timelineData.turnCount}</span>
          <span className="tl-summary-label">turns</span>
        </div>
        <div className="tl-summary-item">
          <span className="tl-summary-value">{formatCost(timelineData.totalCostUsd)}</span>
          <span className="tl-summary-label">cost</span>
        </div>
        <div className="tl-summary-item">
          <span className="tl-summary-value">{formatDuration(timelineData.totalDurationMs)}</span>
          <span className="tl-summary-label">duration</span>
        </div>
        <div className="tl-summary-item">
          <span className="tl-summary-value">{timelineData.models.join(', ')}</span>
          <span className="tl-summary-label">model</span>
        </div>
      </div>

      {/* ── Action type legend ─────────────────────────────────── */}
      <div className="tl-legend">
        {(Object.entries(actionCounts) as [TimelineActionType, number][]).map(([type, count]) => (
          <span key={type} className="tl-legend-item">
            <span className="tl-legend-dot" style={{ background: ACTION_COLORS[type] }} />
            {ACTION_LABELS[type]} {count}
          </span>
        ))}
      </div>

      {/* ── Timeline strip ─────────────────────────────────────── */}
      <div className="tl-strip-container">
        <div className="tl-strip" ref={stripRef}>
          {turns.map((turn) => (
            <button
              key={turn.index}
              className={`tl-node${timelineSelectedTurn === turn.index ? ' is-selected' : ''}`}
              style={{ '--node-color': ACTION_COLORS[turn.actionType] } as React.CSSProperties}
              title={`#${turn.index + 1} ${turn.toolCalls[0]?.name ?? 'Response'} ${formatCost(turn.costUsd)}`}
              onClick={() => setTimelineSelectedTurn(turn.index)}
            >
              <span className="tl-node-dot" />
            </button>
          ))}
        </div>
        {/* Time markers */}
        {turns.length > 0 && (
          <div className="tl-time-markers">
            <span>{formatTime(turns[0].timestamp)}</span>
            {turns.length > 2 && (
              <span>{formatTime(turns[Math.floor(turns.length / 2)].timestamp)}</span>
            )}
            <span>{formatTime(turns[turns.length - 1].timestamp)}</span>
          </div>
        )}
      </div>

      {/* ── Detail panel ───────────────────────────────────────── */}
      {selectedTurn ? (
        <TurnDetail turn={selectedTurn} />
      ) : (
        <div className="tl-detail-empty">
          Click a node above to see turn details
        </div>
      )}
    </div>
  )
}

// ── Turn Detail Sub-component ───────────────────────────────────────────────

function TurnDetail({ turn }: { turn: TimelineTurn }) {
  return (
    <div className="tl-detail">
      <div className="tl-detail-header">
        <span className="tl-detail-badge" style={{ background: ACTION_COLORS[turn.actionType] }}>
          {ACTION_LABELS[turn.actionType]}
        </span>
        <span className="tl-detail-turn">Turn #{turn.index + 1}</span>
        <span className="tl-detail-time">{formatTime(turn.timestamp)}</span>
        <span className="tl-detail-cost">{formatCost(turn.costUsd)}</span>
      </div>

      {/* Tool calls */}
      {turn.toolCalls.length > 0 && (
        <div className="tl-detail-section">
          {turn.toolCalls.map((tc, i) => (
            <div key={i} className={`tl-detail-tool${tc.isError ? ' is-error' : ''}`}>
              <div className="tl-detail-tool-name">{tc.name}</div>
              {tc.inputSummary && (
                <div className="tl-detail-tool-input">{tc.inputSummary}</div>
              )}
              {tc.resultSummary && (
                <div className="tl-detail-tool-result">
                  {tc.isError ? '✗ ' : '→ '}{tc.resultSummary}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Thinking summary */}
      {turn.thinkingSummary && (
        <div className="tl-detail-section">
          <div className="tl-detail-section-label">Thinking</div>
          <div className="tl-detail-thinking">{turn.thinkingSummary}</div>
        </div>
      )}

      {/* Text response */}
      {turn.textSummary && (
        <div className="tl-detail-section">
          <div className="tl-detail-section-label">Response</div>
          <div className="tl-detail-text">{turn.textSummary}</div>
        </div>
      )}

      {/* Token metadata */}
      <div className="tl-detail-meta">
        <span>{formatTokens(turn.inputTokens)} in</span>
        <span>{formatTokens(turn.outputTokens)} out</span>
        {turn.cacheReadTokens > 0 && <span>{formatTokens(turn.cacheReadTokens)} cached</span>}
        {turn.durationMs !== null && <span>{formatDuration(turn.durationMs)}</span>}
        <span className="tl-detail-model">{turn.model}</span>
      </div>
    </div>
  )
}
