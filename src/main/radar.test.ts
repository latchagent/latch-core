import { describe, it, expect } from 'vitest'
import { detectAnomalies } from './radar'
import type { ActivityEvent } from '../types'

function makeEvent(overrides: Partial<ActivityEvent> & { timestamp: string }): ActivityEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    toolName: 'Bash',
    actionClass: 'execute',
    risk: 'medium',
    decision: 'allow',
    reason: null,
    harnessId: 'claude',
    ...overrides,
  }
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString()
}

describe('detectAnomalies', () => {
  it('returns empty array when no activity', () => {
    expect(detectAnomalies([])).toEqual([])
  })

  it('returns empty array when insufficient data', () => {
    const events = [
      makeEvent({ timestamp: minutesAgo(1) }),
      makeEvent({ timestamp: minutesAgo(2) }),
    ]
    expect(detectAnomalies(events)).toEqual([])
  })

  it('detects new tool access', () => {
    // Build baseline with only Bash usage
    const baseline: ActivityEvent[] = []
    for (let i = 0; i < 50; i++) {
      baseline.push(makeEvent({
        timestamp: hoursAgo(12 - i * 0.2),
        toolName: 'Bash',
      }))
    }

    // Recent events include a new tool
    const recent: ActivityEvent[] = []
    for (let i = 0; i < 10; i++) {
      recent.push(makeEvent({
        timestamp: minutesAgo(4 - i * 0.3),
        toolName: i < 5 ? 'Bash' : 'Write',
      }))
    }

    const signals = detectAnomalies([...baseline, ...recent])
    const newToolSignal = signals.find(s => s.id === 'new-tool-access')
    expect(newToolSignal).toBeDefined()
    expect(newToolSignal!.message).toContain('Write')
  })

  it('detects traffic volume spike', () => {
    // Sparse baseline: a few events per window over 24 hours
    const baseline: ActivityEvent[] = []
    for (let i = 0; i < 20; i++) {
      baseline.push(makeEvent({
        timestamp: hoursAgo(20 - i),
        toolName: 'Read',
      }))
    }

    // Huge burst in the last 5 minutes
    const recent: ActivityEvent[] = []
    for (let i = 0; i < 50; i++) {
      recent.push(makeEvent({
        timestamp: minutesAgo(4 - i * 0.08),
        toolName: 'Read',
      }))
    }

    const signals = detectAnomalies([...baseline, ...recent])
    const volumeSignal = signals.find(s => s.id === 'traffic-volume-spike')
    expect(volumeSignal).toBeDefined()
  })

  it('detects error rate spike', () => {
    // Baseline: mostly allowed
    const baseline: ActivityEvent[] = []
    for (let i = 0; i < 60; i++) {
      baseline.push(makeEvent({
        timestamp: hoursAgo(12 - i * 0.2),
        toolName: 'Bash',
        decision: 'allow',
      }))
    }

    // Recent: mostly denied
    const recent: ActivityEvent[] = []
    for (let i = 0; i < 10; i++) {
      recent.push(makeEvent({
        timestamp: minutesAgo(4 - i * 0.3),
        toolName: 'Bash',
        decision: i < 7 ? 'deny' : 'allow',
      }))
    }

    const signals = detectAnomalies([...baseline, ...recent])
    const errorSignal = signals.find(s => s.id === 'error-rate-spike')
    expect(errorSignal).toBeDefined()
  })

  it('detects high-risk activity surge', () => {
    // Baseline: all low/medium risk
    const baseline: ActivityEvent[] = []
    for (let i = 0; i < 60; i++) {
      baseline.push(makeEvent({
        timestamp: hoursAgo(12 - i * 0.2),
        toolName: 'Read',
        risk: 'low',
      }))
    }

    // Recent: sudden high-risk burst
    const recent: ActivityEvent[] = []
    for (let i = 0; i < 10; i++) {
      recent.push(makeEvent({
        timestamp: minutesAgo(4 - i * 0.3),
        toolName: 'Bash',
        risk: 'high',
      }))
    }

    const signals = detectAnomalies([...baseline, ...recent])
    const highRiskSignal = signals.find(s => s.id === 'high-risk-surge')
    expect(highRiskSignal).toBeDefined()
    expect(highRiskSignal!.level).toBe('high')
  })

  it('respects sensitivity configuration', () => {
    // Build a scenario that triggers with high sensitivity but maybe not low
    const baseline: ActivityEvent[] = []
    for (let i = 0; i < 30; i++) {
      baseline.push(makeEvent({
        timestamp: hoursAgo(4 - i * 0.1),
        toolName: 'Bash',
      }))
    }

    const recent: ActivityEvent[] = []
    for (let i = 0; i < 5; i++) {
      recent.push(makeEvent({
        timestamp: minutesAgo(4 - i),
        toolName: 'NewTool',
      }))
    }

    const highSensitivity = detectAnomalies([...baseline, ...recent], { sensitivity: 'high' })
    const lowSensitivity = detectAnomalies([...baseline, ...recent], { sensitivity: 'low' })

    // High sensitivity should detect at least as many signals as low
    expect(highSensitivity.length).toBeGreaterThanOrEqual(lowSensitivity.length)
  })

  it('returns no signals when activity is normal', () => {
    // Steady, consistent activity with no anomalies
    const events: ActivityEvent[] = []
    for (let i = 0; i < 100; i++) {
      events.push(makeEvent({
        timestamp: hoursAgo(23 - i * 0.23),
        toolName: 'Bash',
        decision: 'allow',
        risk: 'medium',
      }))
    }

    const signals = detectAnomalies(events)
    // With steady activity, there should be no volume, error, or high-risk signals
    const volumeSignal = signals.find(s => s.id === 'traffic-volume-spike')
    const errorSignal = signals.find(s => s.id === 'error-rate-spike')
    const highRiskSignal = signals.find(s => s.id === 'high-risk-surge')
    expect(volumeSignal).toBeUndefined()
    expect(errorSignal).toBeUndefined()
    expect(highRiskSignal).toBeUndefined()
  })
})
