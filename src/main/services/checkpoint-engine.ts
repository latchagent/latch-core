// src/main/services/checkpoint-engine.ts

/**
 * @module checkpoint-engine
 * @description Auto-creates git checkpoints when agents write files.
 * Debounces writes within a 3-second window into a single checkpoint.
 * Triggered by the live-tailer's onFileWrite callback.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Checkpoint, LiveEvent } from '../../types'
import type { CheckpointStore } from '../stores/checkpoint-store'

const execFileAsync = promisify(execFile)

// ── Configuration ──────────────────────────────────────────────────────────

const DEBOUNCE_MS = 3_000

// ── Types ──────────────────────────────────────────────────────────────────

interface SessionCheckpointState {
  sessionId: string
  worktreePath: string
  pendingFiles: Set<string>
  debounceTimer: ReturnType<typeof setTimeout> | null
  lastTurnIndex: number
  lastCheckpointTurn: number
  cumulativeCostUsd: number
  lastThinkingSummary: string | null
}

export interface CheckpointEngineOptions {
  store: CheckpointStore
  sendToRenderer: (channel: string, payload: unknown) => void
  getSessionWorktree: (sessionId: string) => string | null
}

// ── State ──────────────────────────────────────────────────────────────────

const sessions = new Map<string, SessionCheckpointState>()
let _opts: CheckpointEngineOptions | null = null

// ── Helpers ────────────────────────────────────────────────────────────────

function uid(): string {
  return `ckpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function gitCommitCheckpoint(
  worktreePath: string,
  message: string,
): Promise<string | null> {
  try {
    // Stage all changes
    await execFileAsync('git', ['add', '-A'], { cwd: worktreePath })

    // Check if there are staged changes
    try {
      await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd: worktreePath })
      // If diff --cached --quiet succeeds, there are no staged changes
      return null
    } catch {
      // Non-zero exit = there ARE staged changes, proceed with commit
    }

    // Commit
    await execFileAsync('git', ['commit', '-m', message, '--no-verify'], {
      cwd: worktreePath,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Latch', GIT_AUTHOR_EMAIL: 'checkpoint@latch.dev', GIT_COMMITTER_NAME: 'Latch', GIT_COMMITTER_EMAIL: 'checkpoint@latch.dev' },
    })

    // Get the commit hash
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })
    return stdout.trim()
  } catch (err) {
    console.warn('[checkpoint-engine] Failed to create checkpoint commit:', err)
    return null
  }
}

// ── Core Logic ─────────────────────────────────────────────────────────────

function getOrCreateState(sessionId: string): SessionCheckpointState | null {
  if (sessions.has(sessionId)) return sessions.get(sessionId)!

  const worktreePath = _opts?.getSessionWorktree(sessionId)
  if (!worktreePath) return null

  const state: SessionCheckpointState = {
    sessionId,
    worktreePath,
    pendingFiles: new Set(),
    debounceTimer: null,
    lastTurnIndex: 0,
    lastCheckpointTurn: 0,
    cumulativeCostUsd: 0,
    lastThinkingSummary: null,
  }
  sessions.set(sessionId, state)
  return state
}

async function flushCheckpoint(state: SessionCheckpointState): Promise<void> {
  if (!_opts || state.pendingFiles.size === 0) return

  const filesChanged = [...state.pendingFiles]
  state.pendingFiles.clear()

  const number = _opts.store.latestNumber(state.sessionId) + 1
  const fileList = filesChanged.map(f => f.split('/').pop()).join(', ')
  const commitMsg = `latch:checkpoint #${number} — turn ${state.lastTurnIndex} [${fileList}]`

  const commitHash = await gitCommitCheckpoint(state.worktreePath, commitMsg)
  if (!commitHash) return

  const summary = state.lastThinkingSummary
    || `Modified ${filesChanged.length} file${filesChanged.length === 1 ? '' : 's'}: ${fileList}`

  const checkpoint = _opts.store.record({
    sessionId: state.sessionId,
    number,
    commitHash,
    turnStart: state.lastCheckpointTurn + 1,
    turnEnd: state.lastTurnIndex,
    summary,
    filesChanged,
    costUsd: state.cumulativeCostUsd,
  })

  state.lastCheckpointTurn = state.lastTurnIndex
  state.cumulativeCostUsd = 0
  state.lastThinkingSummary = null

  // Emit LiveEvent so checkpoint appears in Live view
  _opts.sendToRenderer('latch:live-event', {
    id: uid(),
    sessionId: state.sessionId,
    timestamp: checkpoint.timestamp,
    kind: 'anomaly',
    anomalyKind: 'checkpoint',
    anomalyMessage: `Checkpoint #${number}: ${summary}`,
  } satisfies LiveEvent)

  console.log(`[checkpoint-engine] Created checkpoint #${number} for session ${state.sessionId} (${commitHash.slice(0, 7)})`)
}

// ── Public API ─────────────────────────────────────────────────────────────

export function startCheckpointEngine(opts: CheckpointEngineOptions): void {
  _opts = opts
  console.log('[checkpoint-engine] Started')
}

/**
 * Called by the live-tailer when a Write/Edit tool call is detected.
 */
export function checkpointOnFileWrite(sessionId: string, filePath: string): void {
  if (!_opts) return

  const state = getOrCreateState(sessionId)
  if (!state) return

  state.pendingFiles.add(filePath)

  // Debounce: batch writes within DEBOUNCE_MS into one checkpoint
  if (state.debounceTimer) clearTimeout(state.debounceTimer)
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null
    flushCheckpoint(state).catch(err => {
      console.warn('[checkpoint-engine] Flush error:', err)
    })
  }, DEBOUNCE_MS)
}

/**
 * Update turn index and thinking summary from live events.
 * Called when live-tailer processes thinking or tool-call events.
 */
export function checkpointUpdateTurn(sessionId: string, turnIndex: number, thinkingSummary?: string, costUsd?: number): void {
  const state = sessions.get(sessionId)
  if (!state) return

  state.lastTurnIndex = Math.max(state.lastTurnIndex, turnIndex)
  if (thinkingSummary) state.lastThinkingSummary = thinkingSummary
  if (costUsd) state.cumulativeCostUsd += costUsd
}

export function checkpointRemoveSession(sessionId: string): void {
  const state = sessions.get(sessionId)
  if (state?.debounceTimer) clearTimeout(state.debounceTimer)
  sessions.delete(sessionId)
}

export function stopCheckpointEngine(): void {
  for (const [, state] of sessions) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
  }
  sessions.clear()
  _opts = null
  console.log('[checkpoint-engine] Stopped')
}
