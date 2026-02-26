import React from 'react'
import type { SessionRecord } from '../../types'

interface TopbarProps {
  session?: SessionRecord
}

export default function Topbar({ session }: TopbarProps) {
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
      <div className="status">
        Sandbox: <span className={`status-strong ${sandboxClass}`}>{sandboxLabel}</span>
      </div>
    </header>
  )
}
