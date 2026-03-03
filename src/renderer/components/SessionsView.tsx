import React from 'react'
import { Terminal, Trash, Play, ArrowRight } from '@phosphor-icons/react'
import { useAppStore, useAgentStatus } from '../store/useAppStore'
import StatusDot from './StatusDot'
import type { SessionRecord } from '../../types'

function formatDate(session: SessionRecord): string {
  // Session IDs are "session-N" — we don't have created_at on the in-memory record,
  // so show what we have: harness + project info
  return [session.harness, session.projectDir?.split('/').pop()].filter(Boolean).join(' · ')
}

function SessionCard({ session, isActive, onActivate, onDelete }: {
  session: SessionRecord
  isActive: boolean
  onActivate: () => void
  onDelete: () => void
}) {
  const isDisconnected = session.needsReconnect && !session.showWizard
  const isWizard = session.showWizard
  const status = useAgentStatus(session.id)

  return (
    <div className={`sessions-view-card${isActive ? ' is-active' : ''}${isDisconnected ? ' is-disconnected' : ''}`}>
      <div className="sessions-view-card-main" onClick={onActivate}>
        <div className="sessions-view-card-top">
          <span className="sessions-view-card-name">
            <StatusDot status={status} />
            {session.name}
          </span>
          {isActive && <span className="sessions-view-badge is-active">Active</span>}
          {isDisconnected && <span className="sessions-view-badge is-disconnected">Disconnected</span>}
          {isWizard && <span className="sessions-view-badge is-wizard">Setting up</span>}
        </div>
        <div className="sessions-view-card-meta">
          {session.harness && <span>{session.harness}</span>}
          {session.goal && <span className="sessions-view-card-goal">{session.goal.length > 80 ? session.goal.slice(0, 77) + '...' : session.goal}</span>}
        </div>
        <div className="sessions-view-card-details">
          {session.projectDir && <span title={session.projectDir}>{session.projectDir.split('/').pop()}</span>}
          {session.branchRef && <span>{session.branchRef}</span>}
          {session.gateway?.enabled && <span>Gateway</span>}
        </div>
      </div>
      <div className="sessions-view-card-actions">
        <button className="sessions-view-card-btn is-open" title="Open session" onClick={onActivate}>
          <ArrowRight size={14} weight="bold" />
        </button>
        <button className="sessions-view-card-btn is-delete" title="Delete session" onClick={(e) => { e.stopPropagation(); onDelete() }}>
          <Trash size={14} weight="bold" />
        </button>
      </div>
    </div>
  )
}

export default function SessionsView() {
  const {
    sessions,
    activeSessionId,
    activateSession,
    deleteSession,
    createSession,
  } = useAppStore()

  const sessionList = Array.from(sessions.values())

  const handleDelete = (id: string, name: string) => {
    if (!window.confirm(`Delete "${name}"? This will kill all terminals and remove the session.`)) return
    deleteSession(id)
  }

  const handleNew = () => {
    createSession(`Session ${sessions.size + 1}`)
  }

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h2 className="view-title">Sessions</h2>
          <p className="view-subtitle">{sessionList.length} session{sessionList.length !== 1 ? 's' : ''}</p>
        </div>
        <button className="view-action-btn" onClick={handleNew}>+ New Session</button>
      </div>

      {sessionList.length === 0 ? (
        <div className="policies-empty">
          <div className="policies-empty-icon">
            <Terminal size={40} weight="light" />
          </div>
          <div className="policies-empty-text">No sessions</div>
          <div className="policies-empty-hint">
            Create a session to start working with an AI coding agent.
          </div>
          <button className="cp-generate-btn" onClick={handleNew}>+ New Session</button>
        </div>
      ) : (
        <div className="sessions-view-list">
          {sessionList.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              onActivate={() => activateSession(session.id)}
              onDelete={() => handleDelete(session.id, session.name)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
