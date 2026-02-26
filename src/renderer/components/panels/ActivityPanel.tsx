/**
 * @module ActivityPanel
 * @description Activity rail panel showing real-time tool-call authorization
 * events and radar anomaly signals. Follows the CommsPanel pattern.
 */

import React, { useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '../../store/useAppStore'
import type { ActivityEvent, RadarSignal } from '../../../types'

function formatTime(ts: string): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function riskLabel(risk: string): string {
  return risk.toUpperCase()
}

function signalLevelClass(level: RadarSignal['level']): string {
  if (level === 'high') return 'is-high'
  if (level === 'medium') return 'is-medium'
  return 'is-low'
}

export default function ActivityPanel() {
  const {
    activityEvents,
    activityTotal,
    radarSignals,
    clearActivity,
    loadActivityPanel,
  } = useAppStore()

  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadActivityPanel()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const deniedCount  = useMemo(() => activityEvents.filter((e) => e.decision === 'deny').length, [activityEvents])
  const highRiskCount = useMemo(() => activityEvents.filter((e) => e.risk === 'high').length, [activityEvents])

  return (
    <div className="rail-panel" id="rail-panel-activity">
      <div className="section-label">Activity</div>

      {/* ── Radar signals ──────────────────────────────────────────────── */}
      {radarSignals.length > 0 && (
        <div className="activity-radar">
          {radarSignals.map((signal, i) => (
            <div key={`${signal.id}-${i}`} className={`activity-radar-signal ${signalLevelClass(signal.level)}`}>
              <span className="activity-radar-level">{signal.level.toUpperCase()}</span>
              <span className="activity-radar-msg">{signal.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Stats bar ──────────────────────────────────────────────────── */}
      <div className="activity-stats-bar">
        <span className="activity-stat">Total: {activityTotal}</span>
        <span className="activity-stat is-denied">Denied: {deniedCount}</span>
        <span className="activity-stat is-high-risk">High-risk: {highRiskCount}</span>
      </div>

      {/* ── Event log ──────────────────────────────────────────────────── */}
      <div className="activity-log" ref={logRef}>
        {activityEvents.length === 0 ? (
          <div className="comms-empty">No activity events yet.</div>
        ) : (
          activityEvents.map((event) => (
            <div
              key={event.id}
              className={`activity-event${event.decision === 'deny' ? ' is-denied' : ''}`}
            >
              <div className="activity-event-header">
                <span className="activity-event-tool">{event.toolName}</span>
                <span className={`activity-event-decision ${event.decision === 'deny' ? 'is-denied' : 'is-allowed'}`}>
                  {event.decision.toUpperCase()}
                </span>
              </div>
              <div className="activity-event-meta">
                <span>{event.actionClass}</span>
                <span>{riskLabel(event.risk)}</span>
                <span>{formatTime(event.timestamp)}</span>
              </div>
              {event.reason && (
                <div className="activity-event-reason">{event.reason}</div>
              )}
            </div>
          ))
        )}
      </div>

      {/* ── Clear button ───────────────────────────────────────────────── */}
      <button className="panel-action is-danger" onClick={clearActivity}>
        Clear Activity
      </button>
    </div>
  )
}
