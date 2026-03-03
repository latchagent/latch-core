// src/main/services/budget-enforcer.ts

/**
 * @module budget-enforcer
 * @description Tracks running session and project costs against configured
 * budgets. Emits LiveEvent anomalies at 80% and budget alert dialogs at
 * 100%. Subscribes to the same usage events as usage-watcher.
 */

import crypto from 'node:crypto'
import type { UsageEvent, BudgetAlert, LiveEvent, FeedItem, RadarSignal } from '../../types'

// ── Types ──────────────────────────────────────────────────────────────────

interface SessionBudget {
  sessionId: string
  limitUsd: number
  currentCostUsd: number
  warningEmitted: boolean
  exceededEmitted: boolean
  extensions: number
}

interface ProjectDayCost {
  projectSlug: string
  date: string
  costUsd: number
  warningEmitted: boolean
  exceededEmitted: boolean
}

export interface BudgetEnforcerOptions {
  sendToRenderer: (channel: string, payload: unknown) => void
  getSessionBudget: (sessionId: string) => number | null
  getGlobalSessionBudget: () => number | null
  getDailyProjectBudget: () => number | null
  getSessionProject: (sessionId: string) => string | null
  killSession: (sessionId: string) => void
  recordFeed: (params: { sessionId: string; message: string; harnessId: string }) => FeedItem
  emitRadar: (signal: RadarSignal) => void
}

// ── State ──────────────────────────────────────────────────────────────────

const sessionBudgets = new Map<string, SessionBudget>()
const projectDayCosts = new Map<string, ProjectDayCost>()
const pendingAlerts = new Map<string, BudgetAlert>()

let _opts: BudgetEnforcerOptions | null = null

// ── Helpers ────────────────────────────────────────────────────────────────

function uid(): string {
  return `budget-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function emitLiveEvent(event: LiveEvent): void {
  _opts?.sendToRenderer('latch:live-event', event)
}

function emitBudgetAlert(alert: BudgetAlert): void {
  _opts?.sendToRenderer('latch:budget-alert', alert)
}

function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  return `$${usd.toFixed(2)}`
}

// ── Session Budget Logic ───────────────────────────────────────────────────

function getOrCreateSessionBudget(sessionId: string): SessionBudget | null {
  if (sessionBudgets.has(sessionId)) return sessionBudgets.get(sessionId)!

  const limit = _opts?.getSessionBudget(sessionId) ?? _opts?.getGlobalSessionBudget() ?? null
  if (limit === null) return null

  const budget: SessionBudget = {
    sessionId,
    limitUsd: limit,
    currentCostUsd: 0,
    warningEmitted: false,
    exceededEmitted: false,
    extensions: 0,
  }
  sessionBudgets.set(sessionId, budget)
  return budget
}

function checkSessionBudget(budget: SessionBudget): void {
  const pct = budget.currentCostUsd / budget.limitUsd
  const now = new Date().toISOString()

  // 80% warning
  if (pct >= 0.8 && !budget.warningEmitted) {
    budget.warningEmitted = true

    emitLiveEvent({
      id: uid(),
      sessionId: budget.sessionId,
      timestamp: now,
      kind: 'anomaly',
      anomalyKind: 'budget-warning',
      anomalyMessage: `Session approaching budget limit (${formatCost(budget.currentCostUsd)} / ${formatCost(budget.limitUsd)})`,
    })

    _opts?.recordFeed({
      sessionId: budget.sessionId,
      message: `Budget warning: session at ${Math.round(pct * 100)}% of ${formatCost(budget.limitUsd)} limit`,
      harnessId: 'latch',
    })
  }

  // 100% exceeded
  if (pct >= 1.0 && !budget.exceededEmitted) {
    budget.exceededEmitted = true

    const alert: BudgetAlert = {
      id: uid(),
      sessionId: budget.sessionId,
      kind: 'exceeded',
      currentCostUsd: budget.currentCostUsd,
      limitUsd: budget.limitUsd,
      timestamp: now,
    }
    pendingAlerts.set(alert.id, alert)
    emitBudgetAlert(alert)

    emitLiveEvent({
      id: uid(),
      sessionId: budget.sessionId,
      timestamp: now,
      kind: 'anomaly',
      anomalyKind: 'budget-exceeded',
      anomalyMessage: `Session exceeded ${formatCost(budget.limitUsd)} budget (${formatCost(budget.currentCostUsd)})`,
    })

    _opts?.recordFeed({
      sessionId: budget.sessionId,
      message: `Budget exceeded: session at ${formatCost(budget.currentCostUsd)}, limit was ${formatCost(budget.limitUsd)}`,
      harnessId: 'latch',
    })

    _opts?.emitRadar({
      id: uid(),
      level: 'high',
      message: `Session budget exceeded: ${formatCost(budget.currentCostUsd)} / ${formatCost(budget.limitUsd)}`,
      observedAt: now,
    })
  }
}

// ── Project Budget Logic ───────────────────────────────────────────────────

function checkProjectBudget(sessionId: string, costUsd: number): void {
  const dailyLimit = _opts?.getDailyProjectBudget() ?? null
  if (dailyLimit === null) return

  const projectSlug = _opts?.getSessionProject(sessionId) ?? null
  if (!projectSlug) return

  const date = todayKey()
  const key = `${projectSlug}:${date}`

  let entry = projectDayCosts.get(key)
  if (!entry) {
    entry = { projectSlug, date, costUsd: 0, warningEmitted: false, exceededEmitted: false }
    projectDayCosts.set(key, entry)
  }

  entry.costUsd += costUsd
  const pct = entry.costUsd / dailyLimit
  const now = new Date().toISOString()

  if (pct >= 0.8 && !entry.warningEmitted) {
    entry.warningEmitted = true
    emitLiveEvent({
      id: uid(),
      sessionId,
      timestamp: now,
      kind: 'anomaly',
      anomalyKind: 'project-budget-warning',
      anomalyMessage: `Project "${projectSlug}" approaching daily budget (${formatCost(entry.costUsd)} / ${formatCost(dailyLimit)})`,
    })
  }

  if (pct >= 1.0 && !entry.exceededEmitted) {
    entry.exceededEmitted = true
    _opts?.emitRadar({
      id: uid(),
      level: 'high',
      message: `Daily project budget exceeded for "${projectSlug}": ${formatCost(entry.costUsd)} / ${formatCost(dailyLimit)}`,
      observedAt: now,
    })
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize the budget enforcer.
 */
export function startBudgetEnforcer(opts: BudgetEnforcerOptions): void {
  _opts = opts
  console.log('[budget-enforcer] Started')
}

/**
 * Process a usage event. Called for every usage event (same events usage-watcher pushes).
 */
export function budgetEnforcerProcessEvent(event: UsageEvent): void {
  if (!_opts) return
  if (!event.sessionId) return

  const budget = getOrCreateSessionBudget(event.sessionId)
  if (budget) {
    budget.currentCostUsd += event.costUsd
    checkSessionBudget(budget)
  }

  checkProjectBudget(event.sessionId, event.costUsd)
}

/**
 * Handle user response to a budget alert (kill or extend).
 */
export function respondToBudgetAlert(alertId: string, action: 'kill' | 'extend'): void {
  const alert = pendingAlerts.get(alertId)
  if (!alert) return
  pendingAlerts.delete(alertId)

  const budget = sessionBudgets.get(alert.sessionId)

  if (action === 'kill') {
    _opts?.killSession(alert.sessionId)
    _opts?.recordFeed({
      sessionId: alert.sessionId,
      message: `Session killed: budget of ${formatCost(alert.limitUsd)} exceeded`,
      harnessId: 'latch',
    })
  } else if (action === 'extend' && budget) {
    budget.limitUsd *= 2
    budget.warningEmitted = false
    budget.exceededEmitted = false
    budget.extensions++
    _opts?.recordFeed({
      sessionId: alert.sessionId,
      message: `Budget extended to ${formatCost(budget.limitUsd)} (extension #${budget.extensions})`,
      harnessId: 'latch',
    })
  }
}

/**
 * Remove tracking for a closed session.
 */
export function budgetEnforcerRemoveSession(sessionId: string): void {
  sessionBudgets.delete(sessionId)
}

/**
 * Clean up all state.
 */
export function stopBudgetEnforcer(): void {
  sessionBudgets.clear()
  projectDayCosts.clear()
  pendingAlerts.clear()
  _opts = null
  console.log('[budget-enforcer] Stopped')
}
