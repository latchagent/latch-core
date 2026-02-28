/**
 * @module radar
 * @description Anomaly detection engine for local authz activity.
 * Ported from `lib/cloud/anomaly.ts` and wrapped in a periodic runner.
 */

import type { ActivityEvent, RadarSignal, RadarConfig } from '../../types'
import type { ActivityStore } from '../stores/activity-store'

// ─── Detection (ported from cloud) ──────────────────────────────────────────

const DEFAULT_CONFIG: RadarConfig = {
  sensitivity: 'medium',
  volumeThresholdPct: 200,
  errorRateThresholdPct: 15,
  timeWindowMin: 5,
}

function zThreshold(sensitivity: RadarConfig['sensitivity']): number {
  if (sensitivity === 'high') return 1.8
  if (sensitivity === 'low')  return 3.0
  return 2.4
}

function meanStd(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 }
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, values.length)
  return { mean, std: Math.sqrt(variance) }
}

function zScore(value: number, mean: number, std: number): number {
  if (!Number.isFinite(std) || std === 0) return 0
  return (value - mean) / std
}

function formatList(items: string[], max = 3): string {
  if (items.length <= max) return items.join(', ')
  return `${items.slice(0, max).join(', ')}...`
}

/** Run z-score anomaly detection over activity events. */
export function detectAnomalies(activity: ActivityEvent[], config?: Partial<RadarConfig>): RadarSignal[] {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  const now = Date.now()
  const windowMs = Math.max(1, cfg.timeWindowMin) * 60_000
  const baselineHours = cfg.sensitivity === 'low' ? 72 : cfg.sensitivity === 'high' ? 6 : 24
  const baselineWindowMs = baselineHours * 3_600_000

  const recentStart   = now - windowMs
  const baselineStart = now - baselineWindowMs - windowMs
  const baselineEnd   = recentStart

  const recent   = activity.filter((e) => { const ts = new Date(e.timestamp).getTime(); return Number.isFinite(ts) && ts >= recentStart })
  const baseline = activity.filter((e) => { const ts = new Date(e.timestamp).getTime(); return Number.isFinite(ts) && ts >= baselineStart && ts < baselineEnd })

  const signals: RadarSignal[] = []

  // Require a mature baseline before reporting anomalies.
  // Without enough historical data, everything looks anomalous.
  const MIN_BASELINE = 50
  if (baseline.length < MIN_BASELINE) return signals
  if (recent.length < 3) return signals

  // Build baseline windows
  const wCount = Math.max(1, Math.floor((baselineEnd - baselineStart) / windowMs))
  const counts = new Array(wCount).fill(0)
  const errors = new Array(wCount).fill(0)
  const highRisk = new Array(wCount).fill(0)
  const baselineTools = new Set<string>()

  for (const e of baseline) {
    const ts = new Date(e.timestamp).getTime()
    const idx = Math.floor((ts - baselineStart) / windowMs)
    if (idx < 0 || idx >= wCount) continue
    counts[idx]++
    if (e.decision !== 'allow') errors[idx]++
    if (e.risk === 'high') highRisk[idx]++
    baselineTools.add(e.toolName)
  }

  // Recent aggregates
  let rErrors = 0, rHigh = 0
  const rTools = new Set<string>()
  for (const e of recent) {
    if (e.decision !== 'allow') rErrors++
    if (e.risk === 'high') rHigh++
    rTools.add(e.toolName)
  }

  const zT = zThreshold(cfg.sensitivity)
  const volThreshold = 1 + cfg.volumeThresholdPct / 100

  // Traffic volume spike (requires non-zero baseline mean)
  const { mean: vMean, std: vStd } = meanStd(counts)
  const vRatio = vMean > 0 ? recent.length / vMean : 0
  const vZ = zScore(recent.length, vMean, vStd)
  if (recent.length >= 3 && vMean > 0 && vRatio >= volThreshold && vZ >= zT) {
    signals.push({
      id: 'traffic-volume-spike',
      level: vRatio >= 3 ? 'high' : vRatio >= 2 ? 'medium' : 'low',
      message: `Tool call volume spiked to ${recent.length} (baseline ${vMean.toFixed(1)} per ${cfg.timeWindowMin}m).`,
      observedAt: new Date().toISOString(),
    })
  }

  // New tool access (only meaningful when baseline has a diverse set of known tools)
  if (baselineTools.size >= 3) {
    const newTools = Array.from(rTools).filter((t) => !baselineTools.has(t))
    if (newTools.length > 0) {
      const hasHigh = recent.some((e) => newTools.includes(e.toolName) && e.risk === 'high')
      signals.push({
        id: 'new-tool-access',
        level: hasHigh ? 'high' : cfg.sensitivity === 'high' ? 'medium' : 'low',
        message: `New tool access detected: ${formatList(newTools)}.`,
        observedAt: new Date().toISOString(),
      })
    }
  }

  // Error rate spike
  const errRates = counts.map((c, i) => c > 0 ? errors[i] / c : null).filter((v): v is number => v !== null)
  const { mean: eMean, std: eStd } = meanStd(errRates)
  const rErrRate = recent.length > 0 ? rErrors / recent.length : 0
  const eDelta = (rErrRate - eMean) * 100
  const eZ = zScore(rErrRate, eMean, eStd)
  if (recent.length >= 5 && eStd > 0 && eDelta >= cfg.errorRateThresholdPct && eZ >= zT) {
    signals.push({
      id: 'error-rate-spike',
      level: cfg.sensitivity === 'high' ? 'high' : 'medium',
      message: `Denied rate increased by ${eDelta.toFixed(1)}% over baseline.`,
      observedAt: new Date().toISOString(),
    })
  }

  // High-risk surge
  const hRates = counts.map((c, i) => c > 0 ? highRisk[i] / c : null).filter((v): v is number => v !== null)
  const { mean: hMean, std: hStd } = meanStd(hRates)
  const rHighRate = recent.length > 0 ? rHigh / recent.length : 0
  const hDelta = (rHighRate - hMean) * 100
  const hZ = zScore(rHighRate, hMean, hStd)
  if (recent.length >= 5 && hStd > 0 && hDelta >= Math.max(5, cfg.errorRateThresholdPct / 2) && hZ >= zT) {
    signals.push({
      id: 'high-risk-surge',
      level: 'high',
      message: `High-risk activity surged to ${(rHighRate * 100).toFixed(1)}% of requests (baseline ${(hMean * 100).toFixed(1)}%).`,
      observedAt: new Date().toISOString(),
    })
  }

  return signals
}

// ─── Radar runner ───────────────────────────────────────────────────────────

export class Radar {
  private activityStore: ActivityStore
  private sendToRenderer: (channel: string, payload: unknown) => void
  private timer: ReturnType<typeof setInterval> | null = null
  private eventsSinceCheck = 0
  private lastSignals: RadarSignal[] = []
  private config: RadarConfig

  constructor(
    activityStore: ActivityStore,
    sendToRenderer: (channel: string, payload: unknown) => void,
    config?: Partial<RadarConfig>,
  ) {
    this.activityStore = activityStore
    this.sendToRenderer = sendToRenderer
    this.config = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  }

  /** Start the periodic radar check (every 30s). */
  start(): void {
    this.timer = setInterval(() => this.check(), 30_000)
  }

  /** Stop the radar. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Called every time a new event is recorded. Triggers check every 10 events. */
  onEvent(): void {
    this.eventsSinceCheck++
    if (this.eventsSinceCheck >= 10) {
      this.check()
    }
  }

  /** Get the latest signals (cached). */
  getSignals(): RadarSignal[] {
    return this.lastSignals
  }

  /** Run anomaly detection against recent activity. */
  private check(): void {
    this.eventsSinceCheck = 0
    try {
      const baselineHours = this.config.sensitivity === 'low' ? 72 : this.config.sensitivity === 'high' ? 6 : 24
      const sinceMs = (baselineHours + 1) * 3_600_000
      const activity = this.activityStore.getRecent(sinceMs)
      const signals = detectAnomalies(activity, this.config)

      this.lastSignals = signals
      if (signals.length > 0) {
        for (const signal of signals) {
          this.sendToRenderer('latch:radar-signal', signal)
        }
      }
    } catch {
      // Radar check failed — non-fatal, will retry next cycle
    }
  }
}
