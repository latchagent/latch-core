// src/main/lib/loop-detector.ts

/**
 * @module loop-detector
 * @description Detects stuck/loop patterns in conversation turns —
 * repeated file reads, repeated command failures, write/rewrite cycles,
 * and cost velocity spikes. Pure computation, no I/O.
 */

import type { TimelineTurn, LoopPattern } from '../../types'

// ── Configuration ───────────────────────────────────────────────────────────

const READ_REPEAT_THRESHOLD = 3
const WINDOW_SIZE = 15
const FAILURE_REPEAT_THRESHOLD = 2
const WRITE_CYCLE_THRESHOLD = 2
const COST_WINDOW = 5
const COST_SPIKE_MULTIPLIER = 3

// ── Detectors ───────────────────────────────────────────────────────────────

/**
 * Detect files being read 3+ times in a sliding window.
 */
export function detectRepeatedReads(turns: TimelineTurn[]): LoopPattern[] {
  const patterns: LoopPattern[] = []
  const fileReads = new Map<string, number[]>()

  for (const turn of turns) {
    for (const tc of turn.toolCalls) {
      if ((tc.name === 'Read' || tc.name === 'Glob' || tc.name === 'Grep') && tc.inputSummary) {
        const key = tc.inputSummary
        const indices = fileReads.get(key) ?? []
        indices.push(turn.index)
        fileReads.set(key, indices)
      }
    }
  }

  for (const [filePath, indices] of fileReads) {
    for (let start = 0; start <= indices.length - READ_REPEAT_THRESHOLD; start++) {
      const cluster = indices.slice(start, start + READ_REPEAT_THRESHOLD)
      const span = cluster[cluster.length - 1] - cluster[0]
      if (span <= WINDOW_SIZE) {
        const involvedTurns = turns.filter(t => cluster.includes(t.index))
        const wastedCost = involvedTurns.slice(1).reduce((s, t) => s + t.costUsd, 0)
        patterns.push({
          kind: 'repeated-read',
          label: 'Repeated read',
          description: `Read "${filePath}" ${cluster.length} times in ${span + 1} turns`,
          turnIndices: cluster,
          repetitions: cluster.length,
          wastedCostUsd: wastedCost,
          target: filePath,
        })
        break
      }
    }
  }

  return patterns
}

/**
 * Detect the same command failing 2+ times.
 */
export function detectRepeatedFailures(turns: TimelineTurn[]): LoopPattern[] {
  const patterns: LoopPattern[] = []
  const failures = new Map<string, number[]>()

  for (const turn of turns) {
    for (const tc of turn.toolCalls) {
      if (tc.isError && tc.inputSummary) {
        const key = `${tc.name}:${tc.inputSummary.slice(0, 80).toLowerCase().trim()}`
        const indices = failures.get(key) ?? []
        indices.push(turn.index)
        failures.set(key, indices)
      }
    }
  }

  for (const [cmdKey, indices] of failures) {
    if (indices.length >= FAILURE_REPEAT_THRESHOLD) {
      for (let start = 0; start <= indices.length - FAILURE_REPEAT_THRESHOLD; start++) {
        const cluster = indices.slice(start, start + FAILURE_REPEAT_THRESHOLD)
        const span = cluster[cluster.length - 1] - cluster[0]
        if (span <= WINDOW_SIZE) {
          const involvedTurns = turns.filter(t => cluster.includes(t.index))
          const wastedCost = involvedTurns.slice(1).reduce((s, t) => s + t.costUsd, 0)
          const target = cmdKey.split(':').slice(1).join(':')
          patterns.push({
            kind: 'repeated-failure',
            label: 'Repeated failure',
            description: `"${target}" failed ${cluster.length} times in ${span + 1} turns`,
            turnIndices: cluster,
            repetitions: cluster.length,
            wastedCostUsd: wastedCost,
            target,
          })
          break
        }
      }
    }
  }

  return patterns
}

/**
 * Detect write/edit cycles on the same file.
 */
export function detectWriteCycles(turns: TimelineTurn[]): LoopPattern[] {
  const patterns: LoopPattern[] = []
  const writes = new Map<string, number[]>()

  for (const turn of turns) {
    for (const tc of turn.toolCalls) {
      if ((tc.name === 'Write' || tc.name === 'Edit') && tc.inputSummary) {
        const key = tc.inputSummary
        const indices = writes.get(key) ?? []
        indices.push(turn.index)
        writes.set(key, indices)
      }
    }
  }

  for (const [filePath, indices] of writes) {
    if (indices.length >= WRITE_CYCLE_THRESHOLD) {
      for (let start = 0; start <= indices.length - WRITE_CYCLE_THRESHOLD; start++) {
        const cluster = indices.slice(start, start + WRITE_CYCLE_THRESHOLD)
        const span = cluster[cluster.length - 1] - cluster[0]
        if (span <= WINDOW_SIZE) {
          const involvedTurns = turns.filter(t => cluster.includes(t.index))
          const wastedCost = involvedTurns.slice(1).reduce((s, t) => s + t.costUsd, 0)
          patterns.push({
            kind: 'write-cycle',
            label: 'Write cycle',
            description: `Edited "${filePath}" ${cluster.length} times in ${span + 1} turns`,
            turnIndices: cluster,
            repetitions: cluster.length,
            wastedCostUsd: wastedCost,
            target: filePath,
          })
          break
        }
      }
    }
  }

  return patterns
}

/**
 * Detect cost velocity spikes — a window costing 3x+ the baseline.
 */
export function detectCostSpikes(turns: TimelineTurn[]): LoopPattern[] {
  if (turns.length < COST_WINDOW * 2) return []

  const patterns: LoopPattern[] = []

  const baselineTurns = turns.slice(0, Math.floor(turns.length / 2))
  const baselineAvg = baselineTurns.reduce((s, t) => s + t.costUsd, 0) / baselineTurns.length
  if (baselineAvg <= 0) return []

  for (let i = Math.floor(turns.length / 2); i <= turns.length - COST_WINDOW; i++) {
    const window = turns.slice(i, i + COST_WINDOW)
    const windowAvg = window.reduce((s, t) => s + t.costUsd, 0) / COST_WINDOW

    if (windowAvg >= baselineAvg * COST_SPIKE_MULTIPLIER) {
      const turnIndices = window.map(t => t.index)
      const excessCost = window.reduce((s, t) => s + t.costUsd, 0) - (baselineAvg * COST_WINDOW)
      patterns.push({
        kind: 'cost-spike',
        label: 'Cost spike',
        description: `${COST_WINDOW}-turn window cost ${(windowAvg / baselineAvg).toFixed(1)}x the baseline average`,
        turnIndices,
        repetitions: 1,
        wastedCostUsd: Math.max(0, excessCost),
        target: `turns ${turnIndices[0] + 1}–${turnIndices[turnIndices.length - 1] + 1}`,
      })
      i += COST_WINDOW - 1
    }
  }

  return patterns
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run all loop detectors. Returns patterns sorted by wasted cost descending.
 */
export function detectAllLoops(turns: TimelineTurn[]): LoopPattern[] {
  const all = [
    ...detectRepeatedReads(turns),
    ...detectRepeatedFailures(turns),
    ...detectWriteCycles(turns),
    ...detectCostSpikes(turns),
  ]

  all.sort((a, b) => b.wastedCostUsd - a.wastedCostUsd)

  return all
}
