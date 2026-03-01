import React from 'react'
import { Terminal, Broadcast, Lock, Lightning, Robot, HardDrives, Key, Gear, ShieldWarning, BookOpenText, Target } from '@phosphor-icons/react'
import { useAppStore, useAgentStatus } from '../store/useAppStore'
import StatusDot from './StatusDot'
import type { SessionRecord, AppView } from '../../types'

// ─── SessionItem ──────────────────────────────────────────────────────────────

interface SessionItemProps {
  session:    SessionRecord
  isActive:   boolean
  onClick:    () => void
  onDelete:   () => void
}

function SessionItem({ session, isActive, onClick, onDelete }: SessionItemProps) {
  const isDisconnected = session.needsReconnect && !session.showWizard
  const status = useAgentStatus(session.id)

  return (
    <div
      className={`session-item${isActive ? ' is-active' : ''}${isDisconnected ? ' session-disconnected' : ''}`}
      onClick={onClick}
    >
      <div className="session-item-content">
        <span className="session-item-name">
          <StatusDot status={status} />
          {session.name}
        </span>
        <span className="session-meta">
          {isDisconnected
            ? `${session.harness || 'Shell'} · disconnected`
            : (session.harness || 'Shell')}
        </span>
      </div>
      <button
        className="session-delete"
        title="Delete session"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
      >
        ×
      </button>
    </div>
  )
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

export default function Sidebar() {
  const {
    sessions,
    activeSessionId,
    activeView,
    feedUnread,
    radarSignals,
    activateSession,
    setActiveView,
    createSession,
    deleteSession,
  } = useAppStore()

  const sessionList = Array.from(sessions.values())

  const handleNewSession = () => {
    createSession(`Session ${sessions.size + 1}`)
  }

  const handleDelete = (id: string, name: string) => {
    if (!window.confirm(`Delete "${name}"? This will kill all terminals and remove the session.`)) return
    deleteSession(id)
  }

  return (
    <aside className="sidebar">
      {/* ── Navigation ─────────────────────────────────────────── */}
      <nav className="sidebar-nav">
        <button
          className={`sidebar-nav-item${activeView === 'home' && !activeSessionId ? ' is-active' : ''}`}
          onClick={() => setActiveView('home')}
        >
          <Terminal className="sidebar-nav-icon" weight="light" />
          Home
        </button>
        <button
          className={`sidebar-nav-item${activeView === 'feed' ? ' is-active' : ''}`}
          onClick={() => setActiveView('feed')}
        >
          <Broadcast className="sidebar-nav-icon" weight="light" />
          Feed
          {feedUnread > 0 && <span className="sidebar-badge">{feedUnread > 99 ? '99+' : feedUnread}</span>}
        </button>
        <button
          className={`sidebar-nav-item${activeView === 'policies' ? ' is-active' : ''}`}
          onClick={() => setActiveView('policies')}
        >
          <Lock className="sidebar-nav-icon" weight="light" />
          Policies
        </button>
        <button
          className={`sidebar-nav-item${activeView === 'skills' ? ' is-active' : ''}`}
          onClick={() => setActiveView('skills')}
        >
          <Lightning className="sidebar-nav-icon" weight="light" />
          Skills
        </button>
        <button
          className={`sidebar-nav-item${activeView === 'agents' ? ' is-active' : ''}`}
          onClick={() => setActiveView('agents')}
        >
          <Robot className="sidebar-nav-icon" weight="light" />
          Agents
        </button>
        <button
          className={`sidebar-nav-item${activeView === 'mcp' ? ' is-active' : ''}`}
          onClick={() => setActiveView('mcp')}
        >
          <HardDrives className="sidebar-nav-icon" weight="light" />
          MCP
        </button>
        <button
          className={`sidebar-nav-item${activeView === 'vault' ? ' is-active' : ''}`}
          onClick={() => setActiveView('vault')}
        >
          <Key className="sidebar-nav-icon" weight="light" />
          Vault
        </button>
        <button
          className={`sidebar-nav-item${activeView === 'radar' ? ' is-active' : ''}`}
          onClick={() => setActiveView('radar')}
        >
          <Target className="sidebar-nav-icon" weight="light" />
          Radar
          {radarSignals.length > 0 && (
            <span className={`sidebar-badge${radarSignals.some((s) => s.level === 'high') ? ' is-alert' : ''}`}>
              {radarSignals.length}
            </span>
          )}
        </button>
      </nav>

      <div className="sidebar-section sidebar-sessions" id="session-list">
        {sessionList.map((session) => (
          <SessionItem
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            onClick={() => activateSession(session.id)}
            onDelete={() => handleDelete(session.id, session.name)}
          />
        ))}
      </div>

      {/* ── Bottom nav (Docs, Settings) ──────────────────────── */}
      <nav className="sidebar-nav sidebar-nav-bottom">
        <button
          className={`sidebar-nav-item${activeView === 'docs' ? ' is-active' : ''}`}
          onClick={() => setActiveView('docs')}
        >
          <BookOpenText className="sidebar-nav-icon" weight="light" />
          Docs
        </button>
        <button
          className={`sidebar-nav-item${activeView === 'settings' ? ' is-active' : ''}`}
          onClick={() => setActiveView('settings')}
        >
          <Gear className="sidebar-nav-icon" weight="light" />
          Settings
        </button>
      </nav>

    </aside>
  )
}
