// src/renderer/components/ReplayView.tsx

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  PlayCircle, PauseCircle, SkipBack, SkipForward,
  ArrowLeft, ArrowCounterClockwise, GitFork, MagnifyingGlass,
} from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'
import type { TimelineTurn, TimelineActionType, PlaybackSpeed, Checkpoint } from '../../types'

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

/** Parse a unified diff string into per-file chunks. */
function parseDiffByFile(raw: string): Map<string, string> {
  const result = new Map<string, string>()
  const chunks = raw.split(/^(?=diff --git )/m)
  for (const chunk of chunks) {
    if (!chunk.startsWith('diff --git ')) continue
    const nameMatch = chunk.match(/^diff --git a\/.+ b\/(.+)$/m)
    if (nameMatch) result.set(nameMatch[1], chunk)
  }
  return result
}

/**
 * Match a filesChanged path (often absolute) against diff-parsed relative paths.
 * E.g. "/Users/foo/project/src/main.ts" should match the "src/main.ts" key.
 */
function findChunkForPath(chunks: Map<string, string>, filePath: string): string | undefined {
  // Direct match first (relative paths)
  if (chunks.has(filePath)) return chunks.get(filePath)
  // Try matching by suffix — filesChanged stores absolute paths, diff uses relative
  for (const [relPath, chunk] of chunks) {
    if (filePath.endsWith('/' + relPath) || filePath === relPath) return chunk
  }
  return undefined
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

type FilterChip = 'checkpoints' | 'writes' | 'errors' | 'prompts'

const FILTER_CHIPS: { id: FilterChip; label: string }[] = [
  { id: 'checkpoints', label: 'Checkpoints' },
  { id: 'writes', label: 'Writes' },
  { id: 'errors', label: 'Errors' },
  { id: 'prompts', label: 'Prompts' },
]

function turnMatchesChips(
  turn: TimelineTurn,
  chips: Set<FilterChip>,
  checkpointIndices: number[],
  index: number,
): boolean {
  if (chips.size === 0) return true
  if (chips.has('checkpoints') && checkpointIndices.includes(index)) return true
  if (chips.has('writes') && turn.actionType === 'write') return true
  if (chips.has('errors') && turn.actionType === 'error') return true
  if (chips.has('prompts') && turn.actionType === 'prompt') return true
  return false
}

function turnMatchesSearch(
  turn: TimelineTurn,
  query: string,
  checkpoint: Checkpoint | undefined,
): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  if (turn.textSummary?.toLowerCase().includes(q)) return true
  if (turn.thinkingSummary?.toLowerCase().includes(q)) return true
  for (const tc of turn.toolCalls) {
    if (tc.name.toLowerCase().includes(q)) return true
    if (tc.inputSummary?.toLowerCase().includes(q)) return true
  }
  if (checkpoint) {
    if (checkpoint.summary.toLowerCase().includes(q)) return true
    for (const fp of checkpoint.filesChanged) {
      if (fp.toLowerCase().includes(q)) return true
    }
  }
  return false
}

const SPEED_OPTIONS: PlaybackSpeed[] = [0.5, 1, 2, 4]

/** Duration (ms) to display a turn during auto-play. Compress gaps > 5s. */
function turnDisplayMs(turn: TimelineTurn, speed: PlaybackSpeed): number {
  const raw = turn.durationMs ?? 800
  const capped = raw > 5_000 ? 800 : raw
  return Math.max(capped / speed, 100)
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
    replayCheckpointMap,
    replaySessionId,
    replaySummary,
    loadTimelineConversations,
    loadReplay,
    replayPlay,
    replayPause,
    replayStep,
    replaySeek,
    setReplaySpeed,
    sessions,
    executeRewind,
    forkFromCheckpoint,
    activateSession,
    setActiveView,
  } = useAppStore()

  const streamRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Checkpoint action inline state
  const [rewindConfirmId, setRewindConfirmId] = useState<string | null>(null)
  const [forkingCpId, setForkingCpId] = useState<string | null>(null)
  const [forkGoal, setForkGoal] = useState('')
  const [forkLoading, setForkLoading] = useState(false)
  const [forkError, setForkError] = useState('')

  // Filter state
  const [filterSearch, setFilterSearch] = useState('')
  const [filterChips, setFilterChips] = useState<Set<FilterChip>>(new Set())

  const toggleChip = (chip: FilterChip) => {
    setFilterChips(prev => {
      const next = new Set(prev)
      if (next.has(chip)) next.delete(chip)
      else next.add(chip)
      return next
    })
  }

  const isFiltering = filterSearch.length > 0 || filterChips.size > 0

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
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return

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

  // Reset checkpoint action state when navigating turns
  useEffect(() => {
    setRewindConfirmId(null)
    setForkingCpId(null)
    setForkGoal('')
    setForkError('')
  }, [replayCurrentIndex])

  // Checkpoint action handlers
  const handleReplayRewind = async (checkpoint: Checkpoint) => {
    if (rewindConfirmId !== checkpoint.id) {
      setRewindConfirmId(checkpoint.id)
      setForkingCpId(null)
      return
    }
    const result = await executeRewind(checkpoint.id, replaySessionId!)
    setRewindConfirmId(null)
    if (result.ok) {
      activateSession(checkpoint.sessionId)
    }
  }

  const handleReplayFork = async (checkpoint: Checkpoint) => {
    if (forkingCpId !== checkpoint.id) {
      setForkingCpId(checkpoint.id)
      setRewindConfirmId(null)
      setForkGoal('')
      setForkError('')
      return
    }
    if (!forkGoal.trim()) return
    setForkLoading(true)
    setForkError('')
    const result = await forkFromCheckpoint(checkpoint.id, forkGoal.trim(), replaySessionId!)
    setForkLoading(false)
    if (result.ok) {
      setForkingCpId(null)
      setForkGoal('')
      setActiveView('home')
    } else {
      setForkError(result.error ?? 'Fork failed')
    }
  }

  // Handle conversation selection — match by worktreePath first (Claude Code uses CWD slug)
  const handleConversationSelect = (filePath: string) => {
    setFilterSearch('')
    setFilterChips(new Set())
    const conv = timelineConversations.find(c => c.filePath === filePath)
    let sessionId: string | undefined
    if (conv) {
      for (const [id, s] of sessions) {
        const cwd = s.worktreePath ?? s.repoRoot
        if (cwd && cwd.replace(/[/.]/g, '-') === conv.projectSlug) {
          sessionId = id
          break
        }
      }
    }
    loadReplay(filePath, sessionId)
  }

  // Build slug → session name lookup for the conversation list
  const sessionNameBySlug = useMemo(() => {
    const map = new Map<string, string>()
    for (const [, s] of sessions) {
      const cwd = s.worktreePath ?? s.repoRoot
      if (cwd) {
        const slug = cwd.replace(/[/.]/g, '-')
        if (!s.name.startsWith('Session ')) map.set(slug, s.name)
        else if (!map.has(slug)) map.set(slug, s.name)
      }
    }
    return map
  }, [sessions])

  // Running stats
  const playedTurns = replayTurns.slice(0, replayCurrentIndex + 1)
  const runningCost = playedTurns.reduce((sum, t) => sum + t.costUsd, 0)
  const runningTokens = playedTurns.reduce((sum, t) => sum + t.inputTokens + t.outputTokens, 0)
  const currentTurn = replayTurns[replayCurrentIndex] ?? null

  // Filtered stream items (turns + gap markers)
  const filteredStream = useMemo(() => {
    if (!isFiltering) return null // null = show all, no filtering
    const items: Array<{ type: 'turn'; turn: TimelineTurn; index: number } | { type: 'gap'; count: number }> = []
    let hiddenRun = 0
    for (let i = 0; i < playedTurns.length; i++) {
      const turn = playedTurns[i]
      const cp = replayCheckpointMap.get(i)
      const matchesChip = turnMatchesChips(turn, filterChips, replayCheckpointIndices, i)
      const matchesText = turnMatchesSearch(turn, filterSearch, cp)
      if (matchesChip && matchesText) {
        if (hiddenRun > 0) {
          items.push({ type: 'gap', count: hiddenRun })
          hiddenRun = 0
        }
        items.push({ type: 'turn', turn, index: i })
      } else {
        hiddenRun++
      }
    }
    if (hiddenRun > 0) items.push({ type: 'gap', count: hiddenRun })
    return items
  }, [playedTurns, filterSearch, filterChips, replayCheckpointIndices, replayCheckpointMap, isFiltering])

  // Player view (when a replay is loaded)
  if (replayTurns.length > 0) {
    return (
      <div className="view-container replay-view">
        <div className="view-header replay-player-header">
          <button className="an-back-btn" onClick={() => loadReplay('')}>
            <ArrowLeft size={16} weight="bold" />
            Conversations
          </button>
          <h1 className="view-title">Replay</h1>
        </div>

        {/* Summary (from Timeline) */}
        {replaySummary && <SummaryBar summary={replaySummary} />}

        {/* Stats bar */}
        <div className="replay-stats-bar">
          <span className="replay-stat">Turn {replayCurrentIndex + 1} / {replayTurns.length}</span>
          <span className="replay-stat">{formatCost(runningCost)} <span className="replay-stat-suffix">total spend</span></span>
          <span className="replay-stat">{formatTokens(runningTokens)} <span className="replay-stat-suffix">total tokens</span></span>
        </div>

        {/* Main content: two panels */}
        <div className="replay-panels">
          {/* Left: Activity stream */}
          <div className="replay-stream-container">
            {/* Filter bar */}
            <div className="replay-filter-bar">
              <div className="replay-filter-search">
                <MagnifyingGlass size={14} weight="light" className="replay-filter-search-icon" />
                <input
                  type="text"
                  className="replay-filter-input"
                  placeholder="Search files, summaries..."
                  value={filterSearch}
                  onChange={(e) => setFilterSearch(e.target.value)}
                />
                {isFiltering && (
                  <span className="replay-filter-count">
                    {filteredStream ? filteredStream.filter(i => i.type === 'turn').length : playedTurns.length} / {playedTurns.length}
                  </span>
                )}
              </div>
              <div className="replay-filter-chips">
                {FILTER_CHIPS.map(chip => (
                  <button
                    key={chip.id}
                    className={`replay-filter-chip${filterChips.has(chip.id) ? ' is-active' : ''}`}
                    onClick={() => toggleChip(chip.id)}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Turn stream */}
            <div className="replay-stream" ref={streamRef}>
              {filteredStream ? (
                filteredStream.map((item, idx) =>
                  item.type === 'gap' ? (
                    <div
                      key={`gap-${idx}`}
                      className="replay-filter-gap"
                      onClick={() => { setFilterSearch(''); setFilterChips(new Set()) }}
                    >
                      {item.count} turn{item.count === 1 ? '' : 's'} hidden
                    </div>
                  ) : (
                    <TurnCard
                      key={item.turn.index}
                      turn={item.turn}
                      isActive={item.index === replayCurrentIndex}
                      isCheckpoint={replayCheckpointIndices.includes(item.index)}
                      onClick={() => replaySeek(item.index)}
                    />
                  ),
                )
              ) : (
                playedTurns.map((turn, i) => (
                  <TurnCard
                    key={turn.index}
                    turn={turn}
                    isActive={i === replayCurrentIndex}
                    isCheckpoint={replayCheckpointIndices.includes(i)}
                    onClick={() => replaySeek(i)}
                  />
                ))
              )}
            </div>
          </div>

          {/* Right: Turn detail */}
          <div className="replay-detail">
            {currentTurn ? (
              <>
                <TurnDetail
                  turn={currentTurn}
                  checkpoint={replayCheckpointMap.get(replayCurrentIndex) ?? null}
                  sessionId={replaySessionId}
                  cwd={replaySessionId ? (sessions.get(replaySessionId)?.worktreePath ?? sessions.get(replaySessionId)?.repoRoot) : null}
                  onRewind={handleReplayRewind}
                  onFork={handleReplayFork}
                />
                {/* Inline rewind confirm */}
                {rewindConfirmId && replayCheckpointMap.get(replayCurrentIndex)?.id === rewindConfirmId && (
                  <div className="rewind-confirm" style={{ margin: '12px 16px' }}>
                    <span className="rewind-confirm-text">
                      This will revert all file changes after checkpoint #{replayCheckpointMap.get(replayCurrentIndex)!.number}. Continue?
                    </span>
                    <div className="rewind-confirm-actions">
                      <button className="budget-alert-btn is-danger" onClick={() => handleReplayRewind(replayCheckpointMap.get(replayCurrentIndex)!)}>
                        Yes, rewind
                      </button>
                      <button className="budget-alert-btn is-extend" onClick={() => setRewindConfirmId(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {/* Inline fork form */}
                {forkingCpId && replayCheckpointMap.get(replayCurrentIndex)?.id === forkingCpId && (
                  <div className="rewind-fork-form" style={{ margin: '12px 16px' }}>
                    <div className="rewind-fork-label">New goal for the forked session:</div>
                    <textarea
                      className="rewind-fork-textarea"
                      placeholder="What should the agent do differently from this point?"
                      value={forkGoal}
                      onChange={(e) => setForkGoal(e.target.value)}
                      rows={3}
                      disabled={forkLoading}
                      autoFocus
                    />
                    {forkError && <span className="rewind-fork-error">{forkError}</span>}
                    <div className="rewind-fork-actions">
                      <button
                        className="budget-alert-btn is-extend"
                        onClick={() => handleReplayFork(replayCheckpointMap.get(replayCurrentIndex)!)}
                        disabled={forkLoading || !forkGoal.trim()}
                      >
                        {forkLoading ? 'Forking...' : 'Fork'}
                      </button>
                      <button className="budget-alert-btn" onClick={() => { setForkingCpId(null); setForkGoal(''); setForkError('') }} disabled={forkLoading}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </>
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
                <span className="replay-conv-project">{sessionNameBySlug.get(conv.projectSlug) ?? conv.projectName}</span>
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
        <span className="replay-turn-badge" style={{ '--_badge-color': ACTION_COLORS[turn.actionType] } as React.CSSProperties}>
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

function TurnDetail({ turn, checkpoint, sessionId, cwd, onRewind, onFork }: {
  turn: TimelineTurn
  checkpoint?: Checkpoint | null
  sessionId?: string | null
  cwd?: string | null
  onRewind?: (cp: Checkpoint) => void
  onFork?: (cp: Checkpoint) => void
}) {
  const [diffCache, setDiffCache] = useState<Map<string, Map<string, string>>>(new Map())
  const [diffLoading, setDiffLoading] = useState<string | null>(null)
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())

  // Reset expanded files when checkpoint changes
  useEffect(() => {
    setExpandedFiles(new Set())
  }, [checkpoint?.id])

  const fetchDiff = async (cp: Checkpoint) => {
    if (diffCache.has(cp.id) || diffLoading) return
    if (!cwd) return
    setDiffLoading(cp.id)
    try {
      let result = await window.latch.gitDiff({ cwd, from: cp.commitHash + '^', to: cp.commitHash })
      // Fallback for root commits (no parent) — diff against empty tree
      if (!result.ok) {
        result = await window.latch.gitDiff({ cwd, from: '4b825dc642cb6eb9a060e54bf899d69f82cf7891', to: cp.commitHash })
      }
      if (result.ok && result.diff) {
        setDiffCache(prev => new Map(prev).set(cp.id, parseDiffByFile(result.diff)))
      }
    } finally {
      setDiffLoading(null)
    }
  }

  const toggleFile = (cp: Checkpoint, filePath: string) => {
    if (!diffCache.has(cp.id)) fetchDiff(cp)
    setExpandedFiles(prev => {
      const next = new Set(prev)
      if (next.has(filePath)) next.delete(filePath)
      else next.add(filePath)
      return next
    })
  }

  const renderDiffLines = (chunk: string) => {
    return chunk.split('\n').map((line, i) => {
      let cls = ''
      if (line.startsWith('+') && !line.startsWith('+++')) cls = 'diff-add'
      else if (line.startsWith('-') && !line.startsWith('---')) cls = 'diff-remove'
      else if (line.startsWith('@@')) cls = 'diff-header'
      return <div key={i} className={cls}>{line}</div>
    })
  }

  return (
    <div className="replay-turn-detail">
      <div className="replay-detail-header">
        <span className="replay-detail-badge" style={{ '--_badge-color': ACTION_COLORS[turn.actionType] } as React.CSSProperties}>
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

      {/* Checkpoint actions */}
      {checkpoint && sessionId && onRewind && onFork && (
        <div className="replay-detail-section">
          <div className="replay-detail-section-label">Checkpoint #{checkpoint.number}</div>
          <div className="replay-detail-checkpoint-summary">{checkpoint.summary}</div>
          <div className="replay-detail-checkpoint-meta">
            <span>{checkpoint.commitHash.slice(0, 7)}</span>
            <span>{checkpoint.filesChanged.length} file{checkpoint.filesChanged.length === 1 ? '' : 's'} changed</span>
            {checkpoint.costUsd > 0 && <span>{formatCost(checkpoint.costUsd)}</span>}
          </div>

          {/* Expandable per-file diffs */}
          {checkpoint.filesChanged.length > 0 && (
            <div className="replay-checkpoint-files">
              {checkpoint.filesChanged.map(fp => {
                const isExpanded = expandedFiles.has(fp)
                const fileChunks = diffCache.get(checkpoint.id)
                const chunk = fileChunks ? findChunkForPath(fileChunks, fp) : undefined
                return (
                  <div key={fp} className="replay-checkpoint-file-row">
                    <button
                      className="replay-checkpoint-file-toggle"
                      onClick={() => toggleFile(checkpoint, fp)}
                    >
                      <span className={`replay-checkpoint-file-chevron${isExpanded ? ' is-open' : ''}`}>&#9654;</span>
                      <span className="replay-checkpoint-file-path">{cwd && fp.startsWith(cwd) ? fp.slice(cwd.length + 1) : fp}</span>
                      {diffLoading === checkpoint.id && !fileChunks && (
                        <span className="replay-checkpoint-file-loading">loading...</span>
                      )}
                    </button>
                    {isExpanded && chunk && (
                      <pre className="replay-checkpoint-diff">{renderDiffLines(chunk)}</pre>
                    )}
                    {isExpanded && fileChunks && !chunk && (
                      <pre className="replay-checkpoint-diff"><div className="diff-header">No diff available for this file</div></pre>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          <div className="replay-detail-checkpoint-actions">
            <button className="replay-checkpoint-action-btn is-rewind" onClick={() => onRewind(checkpoint)}>
              <ArrowCounterClockwise size={14} weight="bold" />
              Rewind to here
            </button>
            <button className="replay-checkpoint-action-btn is-fork" onClick={() => onFork(checkpoint)}>
              <GitFork size={14} weight="bold" />
              Fork from here
            </button>
          </div>
        </div>
      )}
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
