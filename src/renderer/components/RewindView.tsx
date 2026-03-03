// src/renderer/components/RewindView.tsx

import React, { useEffect, useState } from 'react'
import { ArrowCounterClockwise, MagnifyingGlass, ArrowLeft } from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'
import type { Checkpoint } from '../../types'

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  if (usd >= 0.01) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(3)}`
}

function formatDate(ts: string): string {
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ── Root ────────────────────────────────────────────────────────────────────

export default function RewindView() {
  const {
    sessions,
    rewindSessionId,
    rewindCheckpoints,
    rewindSelectedCheckpoint,
    rewindDiff,
    rewindLoading,
    rewindSearchQuery,
    setRewindSession,
    searchCheckpoints,
    selectCheckpoint,
    executeRewind,
  } = useAppStore()

  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState('')

  // Get sessions with worktrees (only these can have checkpoints)
  const eligibleSessions = Array.from(sessions.values()).filter(
    s => s.worktreePath || s.repoRoot
  )

  // Auto-select first eligible session
  useEffect(() => {
    if (!rewindSessionId && eligibleSessions.length > 0) {
      setRewindSession(eligibleSessions[0].id)
    }
  }, [eligibleSessions.length])

  const handleSearch = (value: string) => {
    setSearchInput(value)
    searchCheckpoints(value)
  }

  const handleRewind = async (checkpoint: Checkpoint) => {
    const result = await executeRewind(checkpoint.id)
    setConfirmingId(null)
    if (result.ok && result.rewindContext) {
      // Focus the session terminal and inject context
      const session = sessions.get(checkpoint.sessionId)
      if (session) {
        useAppStore.getState().activateSession(session.id)
        // Write rewind context to the active tab's PTY
        const tabId = session.activeTabId
        if (tabId) {
          window.latch?.writePty?.({ sessionId: tabId, data: result.rewindContext + '\n' })
        }
      }
    }
  }

  if (rewindSelectedCheckpoint) {
    return (
      <CheckpointDetail
        checkpoint={rewindSelectedCheckpoint}
        diff={rewindDiff}
        confirmingId={confirmingId}
        onBack={() => selectCheckpoint(null)}
        onRewind={() => setConfirmingId(rewindSelectedCheckpoint.id)}
        onConfirmRewind={() => handleRewind(rewindSelectedCheckpoint)}
        onCancelRewind={() => setConfirmingId(null)}
      />
    )
  }

  return (
    <div className="view-container">
      <div className="view-header">
        <h1 className="view-title">Rewind</h1>
      </div>

      {/* Session selector */}
      <div className="rewind-controls">
        <select
          className="modal-input"
          value={rewindSessionId ?? ''}
          onChange={(e) => setRewindSession(e.target.value || null)}
          style={{ maxWidth: 280 }}
        >
          <option value="">Select session...</option>
          {eligibleSessions.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        <div className="rewind-search">
          <MagnifyingGlass size={14} className="rewind-search-icon" />
          <input
            type="text"
            className="wizard-input"
            placeholder="Search checkpoints..."
            value={searchInput}
            onChange={(e) => handleSearch(e.target.value)}
            style={{ paddingLeft: 28 }}
          />
        </div>
      </div>

      {/* Checkpoint list */}
      {!rewindSessionId ? (
        <div className="an-empty">
          <ArrowCounterClockwise size={48} weight="light" className="an-empty-icon" />
          <span className="an-empty-text">Select a session</span>
          <span className="an-empty-hint">Choose a session to view its checkpoints.</span>
        </div>
      ) : rewindLoading ? (
        <div className="an-empty-text" style={{ padding: 32 }}>Loading checkpoints...</div>
      ) : rewindCheckpoints.length === 0 ? (
        <div className="an-empty">
          <ArrowCounterClockwise size={48} weight="light" className="an-empty-icon" />
          <span className="an-empty-text">{rewindSearchQuery ? 'No matches' : 'No checkpoints yet'}</span>
          <span className="an-empty-hint">
            {rewindSearchQuery
              ? 'Try a different search term.'
              : 'Checkpoints are created automatically when the agent writes files.'}
          </span>
        </div>
      ) : (
        <div className="rewind-timeline">
          {rewindCheckpoints.map(cp => (
            <CheckpointCard
              key={cp.id}
              checkpoint={cp}
              onClick={() => selectCheckpoint(cp)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Checkpoint Card ─────────────────────────────────────────────────────────

function CheckpointCard({ checkpoint, onClick }: { checkpoint: Checkpoint; onClick: () => void }) {
  return (
    <div className="rewind-card" onClick={onClick}>
      <div className="rewind-card-header">
        <span className="rewind-card-number">#{checkpoint.number}</span>
        <span className="rewind-card-turns">Turns {checkpoint.turnStart}–{checkpoint.turnEnd}</span>
        <span className="rewind-card-time">{formatDate(checkpoint.timestamp)}</span>
      </div>
      <div className="rewind-card-summary">{checkpoint.summary}</div>
      <div className="rewind-card-meta">
        <span className="rewind-card-files">
          {checkpoint.filesChanged.length} file{checkpoint.filesChanged.length === 1 ? '' : 's'}
        </span>
        {checkpoint.costUsd > 0 && (
          <span className="rewind-card-cost">{formatCost(checkpoint.costUsd)}</span>
        )}
      </div>
    </div>
  )
}

// ── Checkpoint Detail ───────────────────────────────────────────────────────

function CheckpointDetail({
  checkpoint,
  diff,
  confirmingId,
  onBack,
  onRewind,
  onConfirmRewind,
  onCancelRewind,
}: {
  checkpoint: Checkpoint
  diff: string | null
  confirmingId: string | null
  onBack: () => void
  onRewind: () => void
  onConfirmRewind: () => void
  onCancelRewind: () => void
}) {
  const isConfirming = confirmingId === checkpoint.id

  return (
    <div className="view-container">
      <div className="view-header">
        <button className="an-back-btn" onClick={onBack}>
          <ArrowLeft size={16} weight="bold" />
          All Checkpoints
        </button>
        <h1 className="view-title">Checkpoint #{checkpoint.number}</h1>
      </div>

      <div className="rewind-detail-meta">
        <div className="rewind-detail-stat">
          <span className="rewind-detail-label">Turns</span>
          <span className="rewind-detail-value">{checkpoint.turnStart}–{checkpoint.turnEnd}</span>
        </div>
        <div className="rewind-detail-stat">
          <span className="rewind-detail-label">Cost</span>
          <span className="rewind-detail-value">{formatCost(checkpoint.costUsd)}</span>
        </div>
        <div className="rewind-detail-stat">
          <span className="rewind-detail-label">Commit</span>
          <span className="rewind-detail-value" style={{ fontFamily: 'var(--font-mono)' }}>
            {checkpoint.commitHash.slice(0, 7)}
          </span>
        </div>
        <div className="rewind-detail-stat">
          <span className="rewind-detail-label">Time</span>
          <span className="rewind-detail-value">{formatDate(checkpoint.timestamp)}</span>
        </div>
      </div>

      <div className="rewind-detail-summary">{checkpoint.summary}</div>

      <div className="rewind-detail-files">
        <div className="rewind-detail-files-label">Files changed</div>
        {checkpoint.filesChanged.map(f => (
          <div key={f} className="rewind-detail-file">{f}</div>
        ))}
      </div>

      {/* Rewind action */}
      <div className="rewind-action-bar">
        {isConfirming ? (
          <div className="rewind-confirm">
            <span className="rewind-confirm-text">
              This will revert all file changes after checkpoint #{checkpoint.number}. Continue?
            </span>
            <div className="rewind-confirm-actions">
              <button className="budget-alert-btn is-danger" onClick={onConfirmRewind}>
                Yes, rewind
              </button>
              <button className="budget-alert-btn is-extend" onClick={onCancelRewind}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button className="rewind-btn" onClick={onRewind}>
            <ArrowCounterClockwise size={16} weight="bold" />
            Rewind to this checkpoint
          </button>
        )}
      </div>

      {/* Diff viewer */}
      {diff !== null && (
        <div className="rewind-diff">
          <div className="rewind-diff-label">Changes since this checkpoint</div>
          <pre className="rewind-diff-content">{diff || 'No changes since this checkpoint.'}</pre>
        </div>
      )}
    </div>
  )
}
