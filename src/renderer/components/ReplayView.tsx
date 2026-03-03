// src/renderer/components/ReplayView.tsx

import React, { useEffect, useRef } from 'react'
import {
  PlayCircle, PauseCircle, SkipBack, SkipForward,
  ArrowLeft,
} from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'
import type { TimelineTurn, TimelineActionType, PlaybackSpeed } from '../../types'

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  if (usd >= 0.01) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(3)}`
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${ms}ms`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

const ACTION_COLORS: Record<TimelineActionType, string> = {
  read:    'rgb(var(--d-blue))',
  write:   'rgb(var(--d-green))',
  bash:    'rgb(var(--d-yellow))',
  search:  'rgb(var(--d-blue))',
  agent:   'rgb(168, 85, 247)',
  error:   'var(--error)',
  respond: 'var(--text-tertiary)',
  prompt:  'rgb(34, 211, 238)',
}

const ACTION_LABELS: Record<TimelineActionType, string> = {
  read:    'Read',
  write:   'Write',
  bash:    'Bash',
  search:  'Search',
  agent:   'Agent',
  error:   'Error',
  respond: 'Response',
  prompt:  'Prompt',
}

function SummaryBar({ summary }: { summary: { totalCostUsd: number; totalDurationMs: number; turnCount: number; models: string[] } }) {
  return (
    <div className="replay-summary-bar">
      <span className="replay-summary-item">
        <span className="replay-summary-value">{summary.turnCount}</span>
        <span className="replay-summary-label">turns</span>
      </span>
      <span className="replay-summary-item">
        <span className="replay-summary-value">{formatCost(summary.totalCostUsd)}</span>
        <span className="replay-summary-label">cost</span>
      </span>
      <span className="replay-summary-item">
        <span className="replay-summary-value">{formatDuration(summary.totalDurationMs)}</span>
        <span className="replay-summary-label">duration</span>
      </span>
      <span className="replay-summary-item">
        <span className="replay-summary-value">{summary.models.join(', ')}</span>
        <span className="replay-summary-label">model</span>
      </span>
    </div>
  )
}

function ActionLegend({ turns }: { turns: TimelineTurn[] }) {
  const counts: Partial<Record<TimelineActionType, number>> = {}
  for (const turn of turns) {
    counts[turn.actionType] = (counts[turn.actionType] ?? 0) + 1
  }
  const entries = Object.entries(counts) as [TimelineActionType, number][]
  if (entries.length === 0) return null

  return (
    <div className="replay-action-legend">
      {entries.map(([type, count]) => (
        <span key={type} className="replay-legend-item">
          <span className="replay-legend-dot" style={{ background: ACTION_COLORS[type] }} />
          {ACTION_LABELS[type]} {count}
        </span>
      ))}
    </div>
  )
}

const SPEED_OPTIONS: PlaybackSpeed[] = [0.5, 1, 2, 4]

/** Duration (ms) to display a turn during auto-play. Compress gaps > 10s. */
function turnDisplayMs(turn: TimelineTurn, speed: PlaybackSpeed): number {
  const raw = turn.durationMs ?? 2_000
  const capped = raw > 10_000 ? 2_000 : raw
  return Math.max(capped / speed, 200)
}

// ── Root ────────────────────────────────────────────────────────────────────

export default function ReplayView() {
  const {
    timelineConversations,
    replayTurns,
    replayCurrentIndex,
    replayIsPlaying,
    replaySpeed,
    replayCheckpointIndices,
    replaySummary,
    loadTimelineConversations,
    loadReplay,
    replayPlay,
    replayPause,
    replayStep,
    replaySeek,
    setReplaySpeed,
    sessions,
  } = useAppStore()

  const streamRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load conversations on mount
  useEffect(() => {
    loadTimelineConversations()
  }, [])

  // Auto-play timer
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)

    if (!replayIsPlaying || replayTurns.length === 0) return

    if (replayCurrentIndex >= replayTurns.length - 1) {
      replayPause()
      return
    }

    const currentTurn = replayTurns[replayCurrentIndex]
    const delay = turnDisplayMs(currentTurn, replaySpeed)

    timerRef.current = setTimeout(() => {
      replayStep(1)
    }, delay)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [replayIsPlaying, replayCurrentIndex, replaySpeed, replayTurns.length])

  // Auto-scroll stream to latest turn
  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight
    }
  }, [replayCurrentIndex])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (replayTurns.length === 0) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return

      if (e.code === 'Space') {
        e.preventDefault()
        replayIsPlaying ? replayPause() : replayPlay()
      } else if (e.code === 'ArrowRight') {
        e.preventDefault()
        replayStep(1)
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault()
        replayStep(-1)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [replayTurns.length, replayIsPlaying])

  // Handle conversation selection
  const handleConversationSelect = (filePath: string) => {
    const conv = timelineConversations.find(c => c.filePath === filePath)
    let sessionId: string | undefined
    if (conv) {
      for (const [id, s] of sessions) {
        if (s.repoRoot && s.repoRoot.replace(/\//g, '-') === conv.projectSlug) {
          sessionId = id
          break
        }
      }
    }
    loadReplay(filePath, sessionId)
  }

  // Running stats
  const playedTurns = replayTurns.slice(0, replayCurrentIndex + 1)
  const runningCost = playedTurns.reduce((sum, t) => sum + t.costUsd, 0)
  const runningTokens = playedTurns.reduce((sum, t) => sum + t.inputTokens + t.outputTokens, 0)
  const currentTurn = replayTurns[replayCurrentIndex] ?? null

  // Player view (when a replay is loaded)
  if (replayTurns.length > 0) {
    return (
      <div className="view-container replay-view">
        <div className="view-header">
          <button className="an-back-btn" onClick={() => loadReplay('')}>
            <ArrowLeft size={16} weight="bold" />
            Conversations
          </button>
          <h1 className="view-title">Replay</h1>
        </div>

        {/* Summary + legend (from Timeline) */}
        {replaySummary && <SummaryBar summary={replaySummary} />}
        <ActionLegend turns={replayTurns} />

        {/* Stats bar */}
        <div className="replay-stats-bar">
          <span className="replay-stat">Turn {replayCurrentIndex + 1} / {replayTurns.length}</span>
          <span className="replay-stat">{formatCost(runningCost)}</span>
          <span className="replay-stat">{formatTokens(runningTokens)} tokens</span>
          {currentTurn && (
            <span className="replay-stat replay-stat-phase" style={{ color: ACTION_COLORS[currentTurn.actionType] }}>
              {ACTION_LABELS[currentTurn.actionType]}
            </span>
          )}
        </div>

        {/* Main content: two panels */}
        <div className="replay-panels">
          {/* Left: Activity stream */}
          <div className="replay-stream" ref={streamRef}>
            {playedTurns.map((turn, i) => (
              <TurnCard
                key={turn.index}
                turn={turn}
                isActive={i === replayCurrentIndex}
                isCheckpoint={replayCheckpointIndices.includes(i)}
                onClick={() => replaySeek(i)}
              />
            ))}
          </div>

          {/* Right: Turn detail */}
          <div className="replay-detail">
            {currentTurn ? (
              <TurnDetail turn={currentTurn} />
            ) : (
              <div className="an-empty-text" style={{ padding: 32 }}>Select a turn to view details</div>
            )}
          </div>
        </div>

        {/* Scrub bar */}
        <ScrubBar
          turns={replayTurns}
          currentIndex={replayCurrentIndex}
          checkpointIndices={replayCheckpointIndices}
          onSeek={replaySeek}
        />

        {/* Playback controls */}
        <div className="replay-controls">
          <button className="replay-ctrl-btn" onClick={() => replayStep(-1)} title="Step back">
            <SkipBack size={20} weight="fill" />
          </button>
          <button
            className="replay-ctrl-btn replay-ctrl-play"
            onClick={() => replayIsPlaying ? replayPause() : replayPlay()}
            title={replayIsPlaying ? 'Pause' : 'Play'}
          >
            {replayIsPlaying ? <PauseCircle size={32} weight="fill" /> : <PlayCircle size={32} weight="fill" />}
          </button>
          <button className="replay-ctrl-btn" onClick={() => replayStep(1)} title="Step forward">
            <SkipForward size={20} weight="fill" />
          </button>

          <div className="replay-speed-group">
            {SPEED_OPTIONS.map(s => (
              <button
                key={s}
                className={`replay-speed-btn${replaySpeed === s ? ' is-active' : ''}`}
                onClick={() => setReplaySpeed(s)}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // Conversation selector (no replay loaded)
  return (
    <div className="view-container">
      <div className="view-header">
        <h1 className="view-title">Replay</h1>
      </div>

      {timelineConversations.length === 0 ? (
        <div className="an-empty">
          <PlayCircle size={48} weight="light" className="an-empty-icon" />
          <span className="an-empty-text">No conversations found</span>
          <span className="an-empty-hint">Run an agent session first. Conversations are loaded from Claude Code project logs.</span>
        </div>
      ) : (
        <div className="replay-conversation-list">
          {timelineConversations.map(conv => (
            <div
              key={conv.id}
              className="replay-conversation-card"
              onClick={() => handleConversationSelect(conv.filePath)}
            >
              <div className="replay-conv-header">
                <span className="replay-conv-project">{conv.projectName}</span>
                <span className="replay-conv-date">
                  {new Date(conv.lastModified).toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </span>
              </div>
              {conv.promptPreview && (
                <div className="replay-conv-preview">{conv.promptPreview}</div>
              )}
              <div className="replay-conv-meta">
                <span>{conv.turnCount} turns</span>
                <span>{formatCost(conv.totalCostUsd)}</span>
                <span>{formatTokens(conv.totalTokens)} tokens</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Turn Card (Activity Stream) ─────────────────────────────────────────────

function TurnCard({
  turn, isActive, isCheckpoint, onClick,
}: {
  turn: TimelineTurn; isActive: boolean; isCheckpoint: boolean; onClick: () => void
}) {
  const toolCall = turn.toolCalls[0]

  return (
    <div
      className={`replay-turn-card${isActive ? ' is-active' : ''}${isCheckpoint ? ' is-checkpoint' : ''}`}
      onClick={onClick}
    >
      <div className="replay-turn-header">
        <span className="replay-turn-badge" style={{ background: ACTION_COLORS[turn.actionType] }}>
          {ACTION_LABELS[turn.actionType]}
        </span>
        <span className="replay-turn-num">#{turn.index + 1}</span>
        <span className="replay-turn-time">{formatTime(turn.timestamp)}</span>
        {turn.costUsd > 0 && <span className="replay-turn-cost">{formatCost(turn.costUsd)}</span>}
        {isCheckpoint && <span className="replay-turn-checkpoint" title="Checkpoint">📌</span>}
      </div>
      {turn.actionType === 'prompt' && turn.textSummary && (
        <div className="replay-turn-prompt">{turn.textSummary}</div>
      )}
      {turn.actionType !== 'prompt' && toolCall && (
        <div className="replay-turn-tool">
          {toolCall.name}{toolCall.inputSummary ? ` — ${toolCall.inputSummary}` : ''}
        </div>
      )}
      {turn.actionType !== 'prompt' && !toolCall && turn.thinkingSummary && (
        <div className="replay-turn-thinking">{turn.thinkingSummary}</div>
      )}
      {turn.actionType !== 'prompt' && !toolCall && !turn.thinkingSummary && turn.textSummary && (
        <div className="replay-turn-text">{turn.textSummary}</div>
      )}
    </div>
  )
}

// ── Turn Detail (Right Panel) ───────────────────────────────────────────────

function TurnDetail({ turn }: { turn: TimelineTurn }) {
  // User prompt turns get a simpler detail view
  if (turn.actionType === 'prompt') {
    return (
      <div className="replay-turn-detail">
        <div className="replay-detail-header">
          <span className="replay-detail-badge" style={{ background: ACTION_COLORS.prompt }}>
            Prompt
          </span>
          <span className="replay-detail-turn">Turn #{turn.index + 1}</span>
          <span className="replay-detail-time">{formatTime(turn.timestamp)}</span>
        </div>

        <div className="replay-detail-section">
          <div className="replay-detail-section-label">User Input</div>
          <div className="replay-detail-prompt">{turn.textSummary}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="replay-turn-detail">
      <div className="replay-detail-header">
        <span className="replay-detail-badge" style={{ background: ACTION_COLORS[turn.actionType] }}>
          {ACTION_LABELS[turn.actionType]}
        </span>
        <span className="replay-detail-turn">Turn #{turn.index + 1}</span>
        <span className="replay-detail-time">{formatTime(turn.timestamp)}</span>
        {turn.durationMs != null && (
          <span className="replay-detail-duration">{formatDuration(turn.durationMs)}</span>
        )}
      </div>

      {/* Thinking */}
      {turn.thinkingSummary && (
        <div className="replay-detail-section">
          <div className="replay-detail-section-label">Thinking</div>
          <div className="replay-detail-thinking">{turn.thinkingSummary}</div>
        </div>
      )}

      {/* Tool calls */}
      {turn.toolCalls.length > 0 && (
        <div className="replay-detail-section">
          <div className="replay-detail-section-label">Tool Calls</div>
          {turn.toolCalls.map((tc, i) => (
            <div key={i} className={`replay-detail-tool${tc.isError ? ' is-error' : ''}`}>
              <div className="replay-detail-tool-name">
                {tc.isError ? '✗ ' : '✓ '}{tc.name}
              </div>
              {tc.inputSummary && (
                <pre className="replay-detail-tool-input">{tc.inputSummary}</pre>
              )}
              {tc.resultSummary && (
                <pre className="replay-detail-tool-result">{tc.resultSummary}</pre>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Response */}
      {turn.textSummary && (
        <div className="replay-detail-section">
          <div className="replay-detail-section-label">Response</div>
          <div className="replay-detail-response">{turn.textSummary}</div>
        </div>
      )}

      {/* Metadata */}
      <div className="replay-detail-section">
        <div className="replay-detail-section-label">Metadata</div>
        <div className="replay-detail-meta-grid">
          <div className="replay-detail-meta-item">
            <span className="replay-detail-meta-label">Model</span>
            <span className="replay-detail-meta-value">{turn.model}</span>
          </div>
          <div className="replay-detail-meta-item">
            <span className="replay-detail-meta-label">Cost</span>
            <span className="replay-detail-meta-value">{formatCost(turn.costUsd)}</span>
          </div>
          <div className="replay-detail-meta-item">
            <span className="replay-detail-meta-label">Input</span>
            <span className="replay-detail-meta-value">{formatTokens(turn.inputTokens)}</span>
          </div>
          <div className="replay-detail-meta-item">
            <span className="replay-detail-meta-label">Output</span>
            <span className="replay-detail-meta-value">{formatTokens(turn.outputTokens)}</span>
          </div>
          {turn.cacheReadTokens > 0 && (
            <div className="replay-detail-meta-item">
              <span className="replay-detail-meta-label">Cache Read</span>
              <span className="replay-detail-meta-value">{formatTokens(turn.cacheReadTokens)}</span>
            </div>
          )}
          {turn.stopReason && (
            <div className="replay-detail-meta-item">
              <span className="replay-detail-meta-label">Stop</span>
              <span className="replay-detail-meta-value">{turn.stopReason}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Scrub Bar ───────────────────────────────────────────────────────────────

function ScrubBar({
  turns, currentIndex, checkpointIndices, onSeek,
}: {
  turns: TimelineTurn[]
  currentIndex: number
  checkpointIndices: number[]
  onSeek: (index: number) => void
}) {
  if (turns.length === 0) return null

  const totalDuration = turns.reduce((sum, t) => sum + (t.durationMs ?? 2_000), 0) || 1

  return (
    <div className="replay-scrub">
      <div className="replay-scrub-bar">
        {turns.map((turn, i) => {
          const width = ((turn.durationMs ?? 2_000) / totalDuration) * 100
          const isPlayed = i <= currentIndex
          const isCurrent = i === currentIndex
          const isCheckpoint = checkpointIndices.includes(i)
          const isGap = (turn.durationMs ?? 0) > 10_000

          return (
            <div
              key={i}
              className={`replay-scrub-seg${isPlayed ? ' is-played' : ''}${isCurrent ? ' is-current' : ''}${isGap ? ' is-gap' : ''}`}
              style={{
                width: `${Math.max(width, 0.3)}%`,
                background: isPlayed ? ACTION_COLORS[turn.actionType] : undefined,
              }}
              onClick={() => onSeek(i)}
              title={`Turn #${turn.index + 1} — ${ACTION_LABELS[turn.actionType]}`}
            >
              {isCheckpoint && <span className="replay-scrub-checkpoint" />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
