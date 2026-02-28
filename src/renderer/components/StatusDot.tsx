import React from 'react'
import type { AgentStatus } from '../../types'

const STATUS_LABELS: Record<AgentStatus, string> = {
  running: 'Running',
  waiting: 'Waiting',
  idle:    'Idle',
  exited:  'Exited',
}

interface StatusDotProps {
  status: AgentStatus
  showLabel?: boolean
}

/** Small colored dot indicating agent activity state. */
export default function StatusDot({ status, showLabel = false }: StatusDotProps) {
  return (
    <span className={`status-dot is-${status}`} title={STATUS_LABELS[status]}>
      <span className="status-dot-circle" />
      {showLabel && <span className="status-dot-label">{STATUS_LABELS[status]}</span>}
    </span>
  )
}
