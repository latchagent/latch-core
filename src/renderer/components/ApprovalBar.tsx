/**
 * @module ApprovalBar
 * @description Fixed notification bar for interactive tool-call approvals.
 *
 * Rendered inside TerminalArea, above the terminal host. Shows the top
 * pending approval with Approve (Y) / Deny (N) buttons and a countdown.
 * Keyboard shortcuts: Y to approve, N to deny.
 */

import React, { useEffect, useState, useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { PendingApproval } from '../../types'

/** Summarise tool input for display (e.g. command for Bash, path for Write). */
function summariseInput(toolName: string, toolInput: Record<string, unknown>): string {
  const norm = toolName.toLowerCase()
  if (norm === 'bash') {
    const cmd = String(toolInput.command ?? toolInput.cmd ?? '')
    return cmd.length > 120 ? cmd.slice(0, 117) + '...' : cmd
  }
  if (norm === 'write' || norm === 'edit' || norm === 'read') {
    return String(toolInput.file_path ?? toolInput.path ?? '')
  }
  if (norm === 'webfetch' || norm === 'web_fetch') {
    return String(toolInput.url ?? '')
  }
  if (norm === 'websearch' || norm === 'web_search') {
    return String(toolInput.query ?? '')
  }
  // Fallback: show first key value
  const keys = Object.keys(toolInput)
  if (keys.length) {
    const val = String(toolInput[keys[0]] ?? '')
    return val.length > 80 ? val.slice(0, 77) + '...' : val
  }
  return ''
}

function CountdownTimer({ approval }: { approval: PendingApproval }) {
  const [remaining, setRemaining] = useState(() => {
    const elapsed = Date.now() - new Date(approval.createdAt).getTime()
    return Math.max(0, Math.ceil((approval.timeoutMs - elapsed) / 1000))
  })

  useEffect(() => {
    const interval = setInterval(() => {
      const elapsed = Date.now() - new Date(approval.createdAt).getTime()
      const secs = Math.max(0, Math.ceil((approval.timeoutMs - elapsed) / 1000))
      setRemaining(secs)
      if (secs <= 0) clearInterval(interval)
    }, 1000)
    return () => clearInterval(interval)
  }, [approval.createdAt, approval.timeoutMs])

  const defaultLabel = approval.timeoutDefault === 'deny' ? 'deny' : 'allow'

  return (
    <span className="approval-countdown">
      {remaining}s ({defaultLabel})
    </span>
  )
}

export default function ApprovalBar() {
  const pendingApprovals = useAppStore((s) => s.pendingApprovals)
  const activeSessionId  = useAppStore((s) => s.activeSessionId)
  const resolveApproval  = useAppStore((s) => s.resolveApproval)

  // Filter to current session
  const sessionApprovals = pendingApprovals.filter((a) => a.sessionId === activeSessionId)
  const current = sessionApprovals[0]

  const handleApprove = useCallback(() => {
    if (current) resolveApproval(current.id, 'approve')
  }, [current, resolveApproval])

  const handleDeny = useCallback(() => {
    if (current) resolveApproval(current.id, 'deny')
  }, [current, resolveApproval])

  // Keyboard shortcuts: Y to approve, N to deny
  useEffect(() => {
    if (!current) return
    const handler = (e: KeyboardEvent) => {
      // Don't capture if user is typing in an input/textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault()
        handleApprove()
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        handleDeny()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [current, handleApprove, handleDeny])

  if (!current) return null

  const summary = summariseInput(current.toolName, current.toolInput)
  const isHigh = current.risk === 'high'

  return (
    <div className={`approval-bar${isHigh ? ' is-high-risk' : ''}`}>
      <div className="approval-info">
        <span className={`approval-risk-badge is-${current.risk}`}>{current.risk}</span>
        <span className="approval-tool">{current.toolName}</span>
        {current.reason && <span className="approval-reason">{current.reason}</span>}
        {summary && <span className="approval-summary">{summary}</span>}
      </div>

      <div className="approval-actions">
        <CountdownTimer approval={current} />
        {sessionApprovals.length > 1 && (
          <span className="approval-queue-count">+{sessionApprovals.length - 1} queued</span>
        )}
        <button className="approval-btn is-deny" onClick={handleDeny} title="Deny (N)">
          Deny (N)
        </button>
        <button className="approval-btn is-approve" onClick={handleApprove} title="Approve (Y)">
          Approve (Y)
        </button>
      </div>
    </div>
  )
}
