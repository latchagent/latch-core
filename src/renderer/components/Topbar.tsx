import React from 'react'
import { StopCircle } from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'
import type { SessionRecord } from '../../types'

interface TopbarProps {
  session?: SessionRecord
}

export default function Topbar({ session }: TopbarProps) {
  const endSession = useAppStore((s) => s.endSession)
  const harness = session?.harness || '—'
  const policy  = session?.policyOverride?.name ?? session?.policy ?? '—'
  const name    = session?.name ?? '—'

  const docker  = session?.docker
  const sandboxLabel = docker?.enabled
    ? docker.image
    : 'Native'
  const sandboxClass = docker?.enabled
    ? docker.status === 'running' ? 'status-docker-running' : 'status-docker-other'
    : ''

  // Check if the active tab has a running PTY
  const activeTab = session?.tabs.get(session.activeTabId)
  const canEnd = activeTab?.ptyReady && !session?.showWizard

  return (
    <header className="topbar">
      <div className="status">
        Harness: <span className="status-strong">{harness}</span>
      </div>
      <div className="status">
        Policy: <span className="status-strong">{policy}</span>
      </div>
      <div className="status">
        Session: <span className="status-strong">{name}</span>
      </div>
      {session?.branchRef && (
        <div className="status">
          Branch: <span className="status-strong">{session.branchRef}</span>
          {session.worktreePath && <span className="topbar-badge">worktree</span>}
        </div>
      )}
      <div className="status">
        Sandbox: <span className={`status-strong ${sandboxClass}`}>{sandboxLabel}</span>
      </div>
      {canEnd && session && (
        <button
          className="topbar-end-btn"
          onClick={() => endSession(session.id)}
          title={session.branchRef ? 'End session (pause or merge)' : 'End session (Ctrl+C)'}
        >
          <StopCircle size={14} weight="bold" />
          End
        </button>
      )}
    </header>
  )
}
