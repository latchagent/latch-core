/**
 * @module supervisor
 * @description Terminal-driving policy enforcement supervisor.
 * Watches PTY output for harness permission prompts and types yes/no
 * based on queued policy decisions from the authz server.
 *
 * The supervisor sits between the user and the harness:
 * - The harness runs in its native "ask for approval" mode
 * - PreToolUse hook notifies the supervisor (non-blocking)
 * - Supervisor evaluates policy and queues a decision
 * - When the harness shows its native permission prompt, the supervisor types the answer
 *
 * One supervisor instance handles all sessions. Per-session state is
 * managed via Maps keyed by sessionId/tabId.
 */

import crypto from 'node:crypto'
import type PtyManager from '../lib/pty-manager'
import type { AuthzServer } from './authz-server'
import type { FeedStore } from '../stores/feed-store'
import type { SupervisorAction, PendingApproval, ApprovalDecision, ActionClass } from '../../types'

// ─── ANSI stripping ──────────────────────────────────────────────────────────

/** Strip ANSI escape codes from terminal output for clean regex matching.
 *  Handles standard CSI, private-mode CSI (cursor hide/show, alt screen, etc.),
 *  OSC, DCS, and single-character ESC sequences.
 */
function stripAnsi(str: string): string {
  return str
    // CSI sequences: ESC [ (optional private marker ? > < =) params intermediate* final
    // Handles \x1b[0m, \x1b[36m, \x1b[?25l, \x1b[?1049h, \x1b[0G, \x1b[0K, etc.
    .replace(/\x1b\[[\x3c-\x3f]?[0-9;]*[\x20-\x2f]*[\x40-\x7e]/g, '')
    // OSC sequences: ESC ] ... (terminated by BEL \x07 or ST \x1b\\)
    .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, '')
    // DCS, PM, APC sequences: ESC P/^/_ ... ST
    .replace(/\x1b[P^_].*?(?:\x1b\\|\x07)/gs, '')
    // Charset selection: ESC ( or ) followed by charset designator
    .replace(/\x1b[()][A-Z0-9]/g, '')
    // Single-character ESC sequences: ESC + one byte in 0x40-0x7E
    .replace(/\x1b[\x40-\x7e]/g, '')
    // Remaining ESC + intermediate + final sequences
    .replace(/\x1b[\x20-\x2f]+[\x40-\x7e]/g, '')
    // Control characters (keep \n \r)
    .replace(/[\x00-\x09\x0b-\x0c\x0e-\x1f]/g, '')
}

// ─── Feed detail helper ──────────────────────────────────────────────────────

/** Extract a short detail string from a tool action for feed display. */
function toolDetail(action: SupervisorAction): string {
  const cmd = action.toolInput?.command
  if (cmd && typeof cmd === 'string') {
    const short = cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd
    return ` — ${short}`
  }
  const fp = action.toolInput?.file_path ?? action.toolInput?.path
  if (fp && typeof fp === 'string') {
    return ` — ${fp}`
  }
  return ''
}

// ─── Prompt detection ────────────────────────────────────────────────────────

/** Detected prompt format determines what keys the supervisor types. */
type PromptFormat = 'numbered' | 'yesno'

// Key sequences for each format × decision
const KEY_SEQUENCES: Record<PromptFormat, { allow: string; deny: string }> = {
  // Claude Code numbered select menu:
  //   Option 1 is selected by default (indicated by ">").
  //   Press Enter to select it (approve). NEVER select option 2.
  //   For deny: navigate down twice (to option 3 "No"), then Enter.
  numbered: {
    allow: '\r',                   // Enter (selects current = option 1 "Yes")
    deny: '\x1b[B\x1b[B\r',       // Down, Down, Enter (navigate to option 3 "No")
  },
  // Simple y/n: type the letter + Enter
  yesno: { allow: 'y\r', deny: 'n\r' },
}

// How many chars from the tail of the buffer to check for prompts.
// Large enough to capture a full prompt, small enough to avoid old output.
const PROMPT_CHECK_TAIL = 1500

/** Detect a Claude Code permission prompt in terminal output.
 *  Returns 'numbered' if detected, null otherwise.
 *
 *  Claude Code uses varying question text:
 *    "Do you want to proceed?"
 *    "Do you want to create <file>?"
 *    "Do you want to run <command>?"
 *    "Do you want to edit <file>?"
 *
 *  But the numbered menu format is consistent:
 *    ❯ 1. Yes
 *      2. Yes, and don't ask again... / Yes, allow all edits...
 *      3. No
 *    Esc to cancel
 *
 *  Requires TWO signals to avoid false positives:
 *  1. A numbered "Yes" option (e.g. "1. Yes")
 *  2. A numbered "No" option OR "Esc to cancel" footer
 */
function detectClaudePrompt(text: string): PromptFormat | null {
  // Only check the tail of the buffer
  const tail = text.length > PROMPT_CHECK_TAIL ? text.slice(-PROMPT_CHECK_TAIL) : text

  // Signal 1: A numbered "Yes" option
  const hasYes = /\d+\.\s*Yes\b/i.test(tail)
  if (!hasYes) return null

  // Signal 2: A numbered "No" option OR "Esc to cancel"
  const hasNo = /\d+\.\s*No\b/i.test(tail)
  const hasEsc = /Esc to cancel/i.test(tail)
  if (!hasNo && !hasEsc) return null

  return 'numbered'
}

/** Detect a Codex permission prompt in terminal output. */
function detectCodexPrompt(text: string): PromptFormat | null {
  const tail = text.length > PROMPT_CHECK_TAIL ? text.slice(-PROMPT_CHECK_TAIL) : text

  if (/approve this action/i.test(tail) || /\[y\/n\]/i.test(tail)) {
    return 'yesno'
  }
  return null
}

// ─── Internal types ──────────────────────────────────────────────────────────

/** A prompt detected in PTY output but not yet acted on. */
interface PendingPrompt {
  tabId: string
  sessionId: string
  format: PromptFormat
  detectedAt: number
}

/** An escalated decision waiting for the user to approve/deny in the Latch UI. */
interface EscalatedDecision {
  id: string
  tabId: string
  sessionId: string
  action: SupervisorAction
  format: PromptFormat
}

const OUTPUT_BUFFER_MAX = 4000 // Max chars to keep per tab
const PENDING_PROMPT_TTL_MS = 30_000 // Expire stale pending prompts after 30s

// ─── Supervisor ──────────────────────────────────────────────────────────────

export class Supervisor {
  private authzServer: AuthzServer
  private ptyManager: PtyManager
  private feedStore: FeedStore | null
  private sendToRenderer: (channel: string, payload: unknown) => void

  // Tab ↔ session mapping (tabId is the PTY key, sessionId is the Latch session)
  private tabToSession = new Map<string, string>()
  private sessionToTabs = new Map<string, Set<string>>()
  // Harness ID per session (determines which prompt patterns to use)
  private sessionHarness = new Map<string, string>()

  // Rolling output buffer per tab for prompt detection
  private outputBuffers = new Map<string, string>()

  // Prompts detected in PTY output but not yet acted on (no queued action yet)
  private pendingPrompts = new Map<string, PendingPrompt>() // sessionId → prompt

  // Escalated decisions waiting for user input in the Latch UI
  private escalatedDecisions = new Map<string, EscalatedDecision>() // approvalId → decision

  // Short-lived approval grants — when user approves a tool, subsequent calls
  // for the same tool+session auto-approve for GRANT_TTL_MS.
  // Key: `${sessionId}:${toolName}` → expiry timestamp
  private approvalGrants = new Map<string, number>()

  // Track which tabs have logged their first data (one-time diagnostic)
  private firstDataLogged = new Set<string>()

  constructor(
    authzServer: AuthzServer,
    ptyManager: PtyManager,
    sendToRenderer: (channel: string, payload: unknown) => void,
    feedStore?: FeedStore | null,
  ) {
    this.authzServer = authzServer
    this.ptyManager = ptyManager
    this.feedStore = feedStore ?? null
    this.sendToRenderer = sendToRenderer

    // Wire up PTY data watching
    ptyManager.onData((tabId, data) => this.onPtyData(tabId, data))

    // Wire up supervisor action notifications from the authz server
    authzServer.onSupervisorAction((action) => this.onSupervisorAction(action))

    console.warn('[supervisor] Initialized — watching all PTY output for permission prompts')
  }

  // ─── Tab registration ────────────────────────────────────────────────────

  /** Register a tab-to-session mapping. Called when a PTY is created for a session. */
  registerTab(tabId: string, sessionId: string, harnessId: string): void {
    this.tabToSession.set(tabId, sessionId)
    let tabs = this.sessionToTabs.get(sessionId)
    if (!tabs) {
      tabs = new Set()
      this.sessionToTabs.set(sessionId, tabs)
    }
    tabs.add(tabId)
    this.sessionHarness.set(sessionId, harnessId)
    console.warn(`[supervisor] Registered tab ${tabId} → session ${sessionId} (harness: ${harnessId})`)

    // Visible diagnostic in the feed
    this.emitFeed(sessionId, `Supervisor active — monitoring ${harnessId} session`)
  }

  /** Unregister a tab. Called when a PTY exits. */
  unregisterTab(tabId: string): void {
    const sessionId = this.tabToSession.get(tabId)
    this.tabToSession.delete(tabId)
    this.outputBuffers.delete(tabId)
    this.firstDataLogged.delete(tabId)
    if (sessionId) {
      const tabs = this.sessionToTabs.get(sessionId)
      if (tabs) {
        tabs.delete(tabId)
        if (tabs.size === 0) {
          this.sessionToTabs.delete(sessionId)
          this.sessionHarness.delete(sessionId)
          this.pendingPrompts.delete(sessionId)
          // Clean up grants for this session
          for (const key of this.approvalGrants.keys()) {
            if (key.startsWith(`${sessionId}:`)) this.approvalGrants.delete(key)
          }
        }
      }
      console.warn(`[supervisor] Unregistered tab ${tabId} (session: ${sessionId})`)
    }
  }

  // ─── PTY data handling ───────────────────────────────────────────────────

  /** Process incoming PTY data. Buffers output and checks for permission prompts. */
  private onPtyData(tabId: string, data: string): void {
    const sessionId = this.tabToSession.get(tabId)
    if (!sessionId) return // Unregistered tab — skip

    // One-time diagnostic: log when we first see data from a registered tab
    if (!this.firstDataLogged.has(tabId)) {
      this.firstDataLogged.add(tabId)
      console.warn(`[supervisor] First data from tab ${tabId} (session: ${sessionId}, ${data.length} bytes)`)
    }

    // Append to rolling buffer
    let buffer = this.outputBuffers.get(tabId) ?? ''
    buffer += data
    if (buffer.length > OUTPUT_BUFFER_MAX) {
      buffer = buffer.slice(-OUTPUT_BUFFER_MAX)
    }
    this.outputBuffers.set(tabId, buffer)

    // Strip ANSI and check for prompts
    const clean = stripAnsi(buffer)
    this.checkForPrompt(tabId, sessionId, clean)

  }

  /** Check cleaned output for harness permission prompts. */
  private checkForPrompt(tabId: string, sessionId: string, cleanOutput: string): void {
    const harnessId = this.sessionHarness.get(sessionId)

    let format: PromptFormat | null = null

    if (harnessId === 'codex') {
      format = detectCodexPrompt(cleanOutput)
    } else {
      // Default to Claude detection (covers claude + unknown harnesses)
      format = detectClaudePrompt(cleanOutput)
    }

    if (format) {
      this.onPromptDetected(tabId, sessionId, format)
    }
  }

  /** Handle a detected permission prompt. If there's a queued action, act immediately.
   *  If not, store as a pending prompt for when the action arrives.
   */
  private onPromptDetected(tabId: string, sessionId: string, format: PromptFormat): void {
    // Check if we already have a pending prompt for this session (avoid re-detection)
    const existing = this.pendingPrompts.get(sessionId)
    if (existing && (Date.now() - existing.detectedAt) < PENDING_PROMPT_TTL_MS) {
      return // Already detected, waiting for action or user decision
    }

    // Also skip if we're already waiting for a user decision on an escalated prompt
    for (const esc of this.escalatedDecisions.values()) {
      if (esc.sessionId === sessionId) return
    }

    console.warn(`[supervisor] Prompt detected in terminal (format: ${format}, session: ${sessionId}, tab: ${tabId})`)

    // Check for a queued supervisor action
    const actions = this.authzServer.peekSupervisorActions(sessionId)
    if (actions.length > 0) {
      const action = actions[0]
      console.warn(`[supervisor] Found queued action: ${action.toolName} → ${action.decision}`)
      this.actOnPrompt(tabId, sessionId, format, action)
    } else {
      // No action queued yet — store as pending prompt
      // The action will arrive shortly via onSupervisorAction
      console.warn(`[supervisor] No queued action yet — storing as pending prompt`)
      this.pendingPrompts.set(sessionId, {
        tabId,
        sessionId,
        format,
        detectedAt: Date.now(),
      })
    }
  }

  // ─── Supervisor action handling ──────────────────────────────────────────

  /** Called when a new supervisor action is queued by the authz server. */
  private onSupervisorAction(action: SupervisorAction): void {
    console.warn(`[supervisor] Action received: ${action.toolName} → ${action.decision} (session: ${action.sessionId})`)

    // Check if there's a pending prompt waiting for this action
    const pending = this.pendingPrompts.get(action.sessionId)
    if (pending && (Date.now() - pending.detectedAt) < PENDING_PROMPT_TTL_MS) {
      console.warn(`[supervisor] Found pending prompt for ${action.sessionId} — acting immediately`)
      this.pendingPrompts.delete(action.sessionId)
      this.actOnPrompt(pending.tabId, action.sessionId, pending.format, action)
      return
    }

    // No pending prompt yet. The action stays in the queue (authz server holds it).
    // When the prompt appears in the terminal, onPromptDetected will find it via peek.
    console.warn(`[supervisor] No pending prompt — waiting for terminal prompt to appear (queue size: ${this.authzServer.peekSupervisorActions(action.sessionId).length})`)
  }

  // ─── Acting on prompts ─────────────────────────────────────────────────

  /** Act on a detected prompt with a queued supervisor action. */
  private actOnPrompt(
    tabId: string,
    sessionId: string,
    format: PromptFormat,
    action: SupervisorAction,
  ): void {
    // Consume the action from the queue
    this.authzServer.popSupervisorAction(sessionId, action.toolName)

    if (action.decision === 'allow') {
      // Auto-approve: type the "yes" key sequence
      const keys = KEY_SEQUENCES[format]
      console.warn(`[supervisor] Auto-approving ${action.toolName} — typing: ${JSON.stringify(keys.allow)} to tab ${tabId}`)
      this.ptyManager.write(tabId, keys.allow)
      this.clearBuffer(tabId)

      // Post to feed so user sees what the supervisor is doing
      this.emitFeed(sessionId, `Auto-approved: ${action.toolName}${toolDetail(action)}`)

    } else if (action.decision === 'deny') {
      // Auto-deny: type the "no" key sequence
      const keys = KEY_SEQUENCES[format]
      console.warn(`[supervisor] Auto-denying ${action.toolName} — typing: ${JSON.stringify(keys.deny)} to tab ${tabId}`)
      this.ptyManager.write(tabId, keys.deny)
      this.clearBuffer(tabId)

      // Post to feed (blocked — always visible)
      this.emitFeed(sessionId, `Blocked: ${action.toolName}${toolDetail(action)} — ${action.reason}`)
      this.sendToRenderer('latch:supervisor-blocked', {
        sessionId,
        toolName: action.toolName,
        reason: action.reason,
      })

    } else if (action.decision === 'prompt') {
      // Check for a recent approval grant (user already approved this tool recently)
      const grantKey = `${sessionId}:${action.toolName}`
      const grantExpiry = this.approvalGrants.get(grantKey)
      if (grantExpiry && Date.now() < grantExpiry) {
        const keys = KEY_SEQUENCES[format]
        console.warn(`[supervisor] Grant active for ${action.toolName} — auto-approving`)
        this.ptyManager.write(tabId, keys.allow)
        this.clearBuffer(tabId)
        this.emitFeed(sessionId, `Auto-approved: ${action.toolName}${toolDetail(action)} (recent grant)`)
        return
      }

      // Escalate to user — show inline approval in Latch UI
      const approvalId = crypto.randomBytes(8).toString('hex')

      this.escalatedDecisions.set(approvalId, {
        id: approvalId,
        tabId,
        sessionId,
        action,
        format,
      })

      // Send approval request to renderer
      const approval: PendingApproval = {
        id: approvalId,
        sessionId,
        toolName: action.toolName,
        toolInput: action.toolInput,
        actionClass: action.actionClass,
        risk: action.risk,
        harnessId: this.sessionHarness.get(sessionId) ?? 'unknown',
        createdAt: new Date().toISOString(),
        timeoutMs: 120_000,
        timeoutDefault: 'deny',
        reason: action.reason ?? `Tool "${action.toolName}" requires approval per policy rule.`,
        promptTool: true,
      }

      this.sendToRenderer('latch:approval-request', approval)
      this.emitFeed(sessionId, `Needs your approval: ${action.toolName}${toolDetail(action)}`)
      console.warn(`[supervisor] Escalating to user: ${action.toolName} for session ${sessionId}`)

      // Auto-deny on timeout
      setTimeout(() => {
        if (this.escalatedDecisions.has(approvalId)) {
          this.resolveDecision(approvalId, 'deny')
        }
      }, 120_000)
    }
  }

  /** Resolve an escalated user decision. Called from IPC when user clicks Y/N. */
  resolveDecision(approvalId: string, decision: ApprovalDecision): void {
    const escalated = this.escalatedDecisions.get(approvalId)
    if (!escalated) return

    this.escalatedDecisions.delete(approvalId)

    const keys = KEY_SEQUENCES[escalated.format]

    if (decision === 'approve') {
      // User approved — type "yes" and set a 60s grant for this tool
      const grantKey = `${escalated.sessionId}:${escalated.action.toolName}`
      this.approvalGrants.set(grantKey, Date.now() + 60_000)
      console.warn(`[supervisor] User approved: ${escalated.action.toolName} — typing yes to tab ${escalated.tabId} (grant set for 60s)`)
      this.ptyManager.write(escalated.tabId, keys.allow)
      this.emitFeed(escalated.sessionId, `You approved: ${escalated.action.toolName}${toolDetail(escalated.action)}`)
    } else {
      // User denied — type "no"
      console.warn(`[supervisor] User denied: ${escalated.action.toolName} — typing no to tab ${escalated.tabId}`)
      this.ptyManager.write(escalated.tabId, keys.deny)
      this.emitFeed(escalated.sessionId, `You denied: ${escalated.action.toolName}${toolDetail(escalated.action)}`)
    }

    this.clearBuffer(escalated.tabId)
    this.sendToRenderer('latch:approval-resolved', { id: approvalId })
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** Post a supervisor status message to the feed. */
  private emitFeed(sessionId: string, message: string): void {
    const harnessId = this.sessionHarness.get(sessionId) ?? 'unknown'
    const prefixed = `[Supervisor] ${message}`
    if (this.feedStore) {
      const item = this.feedStore.record({ sessionId, message: prefixed, harnessId })
      this.sendToRenderer('latch:feed-update', item)
    } else {
      this.sendToRenderer('latch:feed-update', {
        id: crypto.randomBytes(8).toString('hex'),
        sessionId,
        timestamp: new Date().toISOString(),
        message: prefixed,
        harnessId,
      })
    }
  }

  /** Clear the output buffer for a tab after acting on a prompt. */
  private clearBuffer(tabId: string): void {
    this.outputBuffers.set(tabId, '')
  }

  /** Clean up all state. Called on app shutdown. */
  dispose(): void {
    // Auto-deny all escalated decisions
    for (const [id] of this.escalatedDecisions) {
      this.resolveDecision(id, 'deny')
    }
    this.tabToSession.clear()
    this.sessionToTabs.clear()
    this.sessionHarness.clear()
    this.outputBuffers.clear()
    this.pendingPrompts.clear()
    this.escalatedDecisions.clear()
    this.firstDataLogged.clear()
  }
}
