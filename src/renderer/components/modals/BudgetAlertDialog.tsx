// src/renderer/components/modals/BudgetAlertDialog.tsx

import React from 'react'
import { Warning } from '@phosphor-icons/react'
import { useAppStore } from '../../store/useAppStore'

function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  return `$${usd.toFixed(2)}`
}

export default function BudgetAlertDialog() {
  const alert = useAppStore((s) => s.activeBudgetAlert)
  const respondBudgetAlert = useAppStore((s) => s.respondBudgetAlert)
  const sessions = useAppStore((s) => s.sessions)

  if (!alert) return null

  const session = sessions.get(alert.sessionId)
  const sessionName = session?.name ?? alert.sessionId

  return (
    <div className="modal-backdrop">
      <div className="budget-alert-dialog">
        <div className="budget-alert-icon">
          <Warning size={32} weight="fill" />
        </div>
        <h2 className="budget-alert-title">Budget Exceeded</h2>
        <p className="budget-alert-desc">
          Session <strong>{sessionName}</strong> has exceeded its budget limit.
        </p>
        <div className="budget-alert-stats">
          <div className="budget-alert-stat">
            <span className="budget-alert-stat-label">Current Cost</span>
            <span className="budget-alert-stat-value">{formatCost(alert.currentCostUsd)}</span>
          </div>
          <div className="budget-alert-stat">
            <span className="budget-alert-stat-label">Budget Limit</span>
            <span className="budget-alert-stat-value">{formatCost(alert.limitUsd)}</span>
          </div>
        </div>
        <div className="budget-alert-actions">
          <button
            className="budget-alert-btn is-danger"
            onClick={() => respondBudgetAlert(alert.id, 'kill')}
          >
            Kill Session
          </button>
          <button
            className="budget-alert-btn is-extend"
            onClick={() => respondBudgetAlert(alert.id, 'extend')}
          >
            Extend to {formatCost(alert.limitUsd * 2)}
          </button>
        </div>
      </div>
    </div>
  )
}
