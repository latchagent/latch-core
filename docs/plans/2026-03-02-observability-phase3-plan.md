# Stuck/Loop Detection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Detect when an AI agent is stuck in a loop — repeatedly reading the same files, failing the same commands, or thrashing on the same code — and surface these patterns with estimated wasted cost in the existing Analytics conversation view.

**Architecture:** A pure-computation `loop-detector.ts` module analyzes `TimelineTurn[]` for four loop patterns: repeated file reads, repeated command failures, write/rewrite cycles on the same file, and cost velocity spikes. Results are added to the existing `ConversationAnalytics` type and rendered as a new "Loops Detected" section in the Analytics conversation tab. No new view, no new IPC channels — loop detection piggybacks on the existing `latch:analytics-conversation` handler. Radar also gets a new signal type so loops show up in the Radar view for real-time awareness.

**Tech Stack:** TypeScript, Electron IPC (existing), React 18, Zustand (existing), pure CSS

---

## Task 1: Types

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Add loop detection types after the ConversationAnalytics interface**

Find the `ConversationAnalytics` interface (after the `RateLimitGap` interface) and add these types right before it:

```typescript
// ─── Loop Detection (Phase 3) ───────────────────────────────────────────────

export type LoopKind = 'repeated-read' | 'repeated-failure' | 'write-cycle' | 'cost-spike'

export interface LoopPattern {
  kind: LoopKind
  label: string
  description: string
  /** Turn indices involved in this loop */
  turnIndices: number[]
  /** Number of repetitions detected */
  repetitions: number
  /** Estimated wasted cost (USD) from redundant turns */
  wastedCostUsd: number
  /** The repeated target (file path, command, etc.) */
  target: string
}
```

**Step 2: Add `loops` field to `ConversationAnalytics`**

Inside the existing `ConversationAnalytics` interface, add after `longestGapMs`:

```typescript
  loops: LoopPattern[]
  totalWastedCostUsd: number
```

**Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(loops): add loop detection types"
```

---

## Task 2: Loop Detector Module

**Files:**
- Create: `src/main/lib/loop-detector.ts`

**Step 1: Create the loop detector**

```typescript
// src/main/lib/loop-detector.ts

/**
 * @module loop-detector
 * @description Detects stuck/loop patterns in conversation turns —
 * repeated file reads, repeated command failures, write/rewrite cycles,
 * and cost velocity spikes. Pure computation, no I/O.
 */

import type { TimelineTurn, LoopPattern, LoopKind } from '../../types'

// ── Configuration ───────────────────────────────────────────────────────────

/** Minimum repetitions to flag a pattern */
const READ_REPEAT_THRESHOLD = 3
/** Sliding window size (turns) for detecting repeats */
const WINDOW_SIZE = 15
/** Minimum failures of same command to flag */
const FAILURE_REPEAT_THRESHOLD = 2
/** Minimum writes to same file to flag a cycle */
const WRITE_CYCLE_THRESHOLD = 2
/** Rolling window for cost spike detection (turns) */
const COST_WINDOW = 5
/** Cost spike multiplier — current window must be Nx the baseline */
const COST_SPIKE_MULTIPLIER = 3

// ── Detectors ───────────────────────────────────────────────────────────────

/**
 * Detect files being read 3+ times in a sliding window.
 * Indicates the agent keeps re-reading files instead of using cached knowledge.
 */
export function detectRepeatedReads(turns: TimelineTurn[]): LoopPattern[] {
  const patterns: LoopPattern[] = []
  const fileReads = new Map<string, number[]>() // filePath → turn indices

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
    // Check sliding windows for clusters of reads
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
        break // One pattern per file
      }
    }
  }

  return patterns
}

/**
 * Detect the same bash command failing 2+ times.
 * Indicates the agent is retrying without fixing the root cause.
 */
export function detectRepeatedFailures(turns: TimelineTurn[]): LoopPattern[] {
  const patterns: LoopPattern[] = []
  const failures = new Map<string, number[]>() // command → turn indices

  for (const turn of turns) {
    for (const tc of turn.toolCalls) {
      if (tc.isError && tc.inputSummary) {
        // Normalize command for grouping (trim, lowercase first 80 chars)
        const key = `${tc.name}:${tc.inputSummary.slice(0, 80).toLowerCase().trim()}`
        const indices = failures.get(key) ?? []
        indices.push(turn.index)
        failures.set(key, indices)
      }
    }
  }

  for (const [cmdKey, indices] of failures) {
    if (indices.length >= FAILURE_REPEAT_THRESHOLD) {
      // Check for clusters within the window
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
 * Detect write/edit cycles on the same file — agent writes, then rewrites.
 * Indicates thrashing: writing code, reverting, rewriting.
 */
export function detectWriteCycles(turns: TimelineTurn[]): LoopPattern[] {
  const patterns: LoopPattern[] = []
  const writes = new Map<string, number[]>() // filePath → turn indices

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
 * Detect cost velocity spikes — a window of turns costing 3x+ the baseline.
 * Indicates inefficient work (spinning without progress).
 */
export function detectCostSpikes(turns: TimelineTurn[]): LoopPattern[] {
  if (turns.length < COST_WINDOW * 2) return [] // Need enough data

  const patterns: LoopPattern[] = []

  // Compute baseline: average cost per turn across first half
  const baselineTurns = turns.slice(0, Math.floor(turns.length / 2))
  const baselineAvg = baselineTurns.reduce((s, t) => s + t.costUsd, 0) / baselineTurns.length
  if (baselineAvg <= 0) return []

  // Slide a window across the second half looking for spikes
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
      // Skip ahead to avoid overlapping detections
      i += COST_WINDOW - 1
    }
  }

  return patterns
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run all loop detectors on a set of turns.
 * Returns deduplicated loop patterns sorted by wasted cost (highest first).
 */
export function detectAllLoops(turns: TimelineTurn[]): LoopPattern[] {
  const all = [
    ...detectRepeatedReads(turns),
    ...detectRepeatedFailures(turns),
    ...detectWriteCycles(turns),
    ...detectCostSpikes(turns),
  ]

  // Sort by wasted cost descending
  all.sort((a, b) => b.wastedCostUsd - a.wastedCostUsd)

  return all
}
```

**Step 2: Commit**

```bash
git add src/main/lib/loop-detector.ts
git commit -m "feat(loops): add loop detector with repeated reads, failures, write cycles, cost spikes"
```

---

## Task 3: Wire into Analytics Engine

**Files:**
- Modify: `src/main/lib/analytics-engine.ts`

**Step 1: Add import**

At the top with other imports:

```typescript
import { detectAllLoops } from './loop-detector'
```

**Step 2: Add loop detection to `computeConversationAnalytics`**

Inside the `computeConversationAnalytics` function, after the `longestGapMs` calculation and before the `return` statement, add:

```typescript
  const loops = detectAllLoops(turns)
  const totalWastedCostUsd = loops.reduce((s, l) => s + l.wastedCostUsd, 0)
```

Then update the return statement to include:

```typescript
    loops,
    totalWastedCostUsd,
```

**Step 3: Commit**

```bash
git add src/main/lib/analytics-engine.ts
git commit -m "feat(loops): wire loop detection into conversation analytics"
```

---

## Task 4: Render Loops in AnalyticsView

**Files:**
- Modify: `src/renderer/components/AnalyticsView.tsx`
- Modify: `src/renderer/styles.css`

**Step 1: Add LoopPattern to imports**

Update the type import at the top of AnalyticsView.tsx:

```typescript
import type { WorkPhase, PhaseCostBucket, ContextPressurePoint, RateLimitGap, ProjectHealthMetrics, LoopPattern } from '../../types'
```

**Step 2: Add loop kind colors and labels**

After the `PHASE_LABELS` constant:

```typescript
const LOOP_ICONS: Record<string, string> = {
  'repeated-read':    '↻',
  'repeated-failure': '✗',
  'write-cycle':      '⇄',
  'cost-spike':       '↑',
}

const LOOP_COLORS: Record<string, string> = {
  'repeated-read':    'var(--warning)',
  'repeated-failure': 'rgb(var(--d-red, 248 113 113))',
  'write-cycle':      'rgb(168, 85, 247)',
  'cost-spike':       'var(--warning)',
}
```

**Step 3: Add LoopSection component**

After the `RateLimitSection` component at the bottom of the file:

```tsx
// ── Loop Section ────────────────────────────────────────────────────────────

function LoopSection({ loops, totalWasted }: { loops: LoopPattern[]; totalWasted: number }) {
  return (
    <div className="an-loop-section">
      {totalWasted > 0 && (
        <div className="an-loop-waste-banner">
          Estimated waste: {formatCost(totalWasted)}
        </div>
      )}
      <div className="an-gap-list">
        {loops.map((loop, i) => (
          <div key={i} className="an-loop-item">
            <span className="an-loop-icon" style={{ color: LOOP_COLORS[loop.kind] }}>
              {LOOP_ICONS[loop.kind]}
            </span>
            <div className="an-loop-body">
              <span className="an-loop-label" style={{ color: LOOP_COLORS[loop.kind] }}>
                {loop.label}
              </span>
              <span className="an-loop-desc">{loop.description}</span>
            </div>
            {loop.wastedCostUsd > 0 && (
              <span className="an-loop-cost">{formatCost(loop.wastedCostUsd)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
```

**Step 4: Wire LoopSection into ConversationTab**

In the `ConversationTab` component, after the rate limit gaps section (before the closing `</>`), add:

```tsx
      {/* Loop detection */}
      {analyticsConv.loops.length > 0 && (
        <>
          <div className="view-section-label">
            Loops Detected
            <span className="an-gap-count">{analyticsConv.loops.length}</span>
          </div>
          <LoopSection loops={analyticsConv.loops} totalWasted={analyticsConv.totalWastedCostUsd} />
        </>
      )}
```

**Step 5: Add CSS at the end of `src/renderer/styles.css`**

```css
/* ── Loop Detection ───────────────────────────────────────────────────────── */

.an-loop-section {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.an-loop-waste-banner {
  padding: 10px 16px;
  background: rgba(251, 191, 36, 0.08);
  border: 1px solid rgba(251, 191, 36, 0.2);
  border-radius: 6px;
  font-size: 13px;
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--warning);
  margin-bottom: 8px;
}

.an-loop-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 16px;
  background: var(--bg-card);
  font-size: 12px;
  font-family: var(--font-mono);
}

.an-loop-icon {
  font-size: 14px;
  font-weight: 700;
  flex-shrink: 0;
  width: 18px;
  text-align: center;
  line-height: 1.4;
}

.an-loop-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.an-loop-label {
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.an-loop-desc {
  color: var(--text-secondary);
  line-height: 1.4;
}

.an-loop-cost {
  font-weight: 600;
  color: var(--warning);
  white-space: nowrap;
  flex-shrink: 0;
}
```

**Step 6: Commit**

```bash
git add src/renderer/components/AnalyticsView.tsx src/renderer/styles.css
git commit -m "feat(loops): render loop detection results in analytics conversation view"
```

---

## Task 5: Smoke Test

**Step 1: Run the type checker**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit 2>&1 | head -40`
Expected: No new errors from our files

**Step 2: Manual verification checklist**

- [ ] Open Analytics → Conversation tab → pick a conversation
- [ ] "Cost by Phase" and "Context Pressure" sections still render
- [ ] If loops detected: "Loops Detected" section appears with count badge
- [ ] Each loop shows icon, label, description, and wasted cost
- [ ] "Estimated waste" banner shows at top of loops section
- [ ] If no loops: section simply doesn't appear (no empty state needed)
- [ ] Hovering a loop item shows full description text
