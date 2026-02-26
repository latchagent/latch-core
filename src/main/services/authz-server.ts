/**
 * @module authz-server
 * @description Local HTTP authorization server for runtime tool-call interception.
 * Claude Code's PreToolUse hook POSTs to this server before every tool use.
 * The server evaluates the request against the session's effective policy,
 * returns 200 (allow) or 403 (deny), logs the decision, and pushes events
 * to the renderer in real time.
 */

import crypto from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import type { PolicyDocument, ActionClass, RiskLevel, AuthzDecision, PendingApproval, ApprovalDecision, ToolRule, McpServerRule, CommandRule } from '../../types'
import type { PolicyStore } from '../stores/policy-store'
import { resolvePolicy } from './policy-enforcer'
import type { ActivityStore } from '../stores/activity-store'
import type { Radar } from './radar'
import type { FeedStore } from '../stores/feed-store'
import type { SettingsStore } from '../stores/settings-store'

const MAX_BODY_BYTES = 64 * 1024 // 64 KB max request body
const APPROVAL_TIMEOUT_MS = 120_000 // 120 seconds for interactive approval

// ─── Tool classification ─────────────────────────────────────────────────────

// Claude Code uses PascalCase tool names, OpenClaw uses lowercase.
// We normalize to a canonical key for lookup.
const TOOL_ACTION_MAP: Record<string, ActionClass> = {
  // Claude Code — file & search tools
  bash:      'execute',
  write:     'write',
  edit:      'write',
  read:      'read',
  glob:      'read',
  grep:      'read',
  webfetch:  'send',
  websearch: 'send',
  task:      'execute',
  // Claude Code — planning & navigation (harmless, auto-allow)
  enterplanmode:    'read',
  exitplanmode:     'read',
  todoread:         'read',
  todowrite:        'read',
  todolist:         'read',
  askuserquestion:  'read',
  notebookedit:     'write',
  skill:            'read',
  taskcreate:       'read',
  taskupdate:       'read',
  taskget:          'read',
  tasklist:         'read',
  taskoutput:       'read',
  taskstop:         'read',
  // OpenClaw-specific names (underscores stripped by normalizeToolKey)
  exec:       'execute',
  browser:    'send',
}

const ACTION_RISK_MAP: Record<ActionClass, RiskLevel> = {
  read:    'low',
  write:   'medium',
  execute: 'high',
  send:    'medium',
}

// Heuristic patterns for classifying unknown tools (e.g. MCP tools).
// Checked in order; first match wins.
const HEURISTIC_PATTERNS: [RegExp, ActionClass][] = [
  [/\b(delete|remove|drop|destroy|kill|purge|reset|force)\b/i, 'execute'],
  [/\b(create|write|update|set|put|post|insert|modify|edit|patch|rename|move)\b/i, 'write'],
  [/\b(send|email|notify|publish|push|deploy|upload)\b/i, 'send'],
  [/\b(read|get|list|search|find|query|fetch|show|describe|view|inspect|check|status|count|head|tail|cat|ls)\b/i, 'read'],
]

// ─── Default command rules ────────────────────────────────────────────────────
// Applied when policy.permissions.commandRules is undefined (opt-out with []).

export const DEFAULT_COMMAND_RULES: CommandRule[] = [
  { pattern: 'rm\\s+-[^\\s]*r[^\\s]*\\s+/', decision: 'deny', reason: 'Recursive delete of root paths' },
  { pattern: '\\b(mkfs|dd\\s+of=/dev)', decision: 'deny', reason: 'Disk formatting' },
  { pattern: '\\bcat\\s+.*(\\.env|id_rsa|\\.pem|\\.key)\\b', decision: 'deny', reason: 'Secret exfiltration' },
  { pattern: '(curl|wget)\\s+.*\\|\\s*(sh|bash|zsh)', decision: 'deny', reason: 'Pipe-to-shell' },
  { pattern: '\\b(shutdown|reboot|halt|poweroff)\\b', decision: 'deny', reason: 'System power' },
  { pattern: 'chmod\\s+(777|\\+s)\\b', decision: 'deny', reason: 'Broad permission change' },
  { pattern: '\\bsudo\\b', decision: 'prompt', reason: 'Privilege escalation' },
  { pattern: 'git\\s+push\\s+.*--force', decision: 'prompt', reason: 'Destructive git' },
  { pattern: 'git\\s+reset\\s+--hard', decision: 'prompt', reason: 'Destructive git' },
]

/** Normalize tool name to lowercase key for classification lookup. */
function normalizeToolKey(toolName: string): string {
  return toolName.toLowerCase().replace(/_/g, '')
}

function classifyTool(toolName: string): { actionClass: ActionClass; risk: RiskLevel } {
  const key = normalizeToolKey(toolName)
  let actionClass = TOOL_ACTION_MAP[key]

  // If not in the static map, try heuristic classification based on tool name
  if (!actionClass) {
    for (const [pattern, cls] of HEURISTIC_PATTERNS) {
      if (pattern.test(toolName)) {
        actionClass = cls
        break
      }
    }
  }

  // Final fallback: unknown tools default to 'execute' (conservative)
  if (!actionClass) actionClass = 'execute'

  const risk = ACTION_RISK_MAP[actionClass]
  return { actionClass, risk }
}

// ─── Tool rule helpers ───────────────────────────────────────────────────────

/** Extract MCP server name from Claude's `mcp__servername__toolname` format. */
function extractMcpServer(toolName: string): string | null {
  const m = toolName.match(/^mcp__([^_]+)__/)
  return m ? m[1] : null
}

/** Match a tool name against a pattern (exact, trailing wildcard, case-insensitive fallback). */
function matchToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === toolName) return true
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1)
    if (toolName.startsWith(prefix)) return true
    if (toolName.toLowerCase().startsWith(prefix.toLowerCase())) return true
  }
  if (pattern.toLowerCase() === toolName.toLowerCase()) return true
  return false
}

/** Resolve per-tool decision from toolRules, mcpServerRules, then legacy arrays.
 *  Returns the decision or undefined if no rule matched.
 */
function resolveToolDecision(
  toolName: string,
  harnessConfig: { toolRules?: ToolRule[]; mcpServerRules?: McpServerRule[]; allowedTools?: string[]; deniedTools?: string[] } | undefined,
): 'allow' | 'deny' | 'prompt' | undefined {
  if (!harnessConfig) return undefined

  // 1. Check toolRules (first matching pattern wins)
  if (harnessConfig.toolRules?.length) {
    for (const rule of harnessConfig.toolRules) {
      if (matchToolPattern(rule.pattern, toolName)) {
        return rule.decision
      }
    }
  }

  // 2. Check mcpServerRules (if tool is MCP-namespaced)
  const mcpServer = extractMcpServer(toolName)
  if (mcpServer && harnessConfig.mcpServerRules?.length) {
    for (const rule of harnessConfig.mcpServerRules) {
      if (rule.server.toLowerCase() === mcpServer.toLowerCase()) {
        return rule.decision
      }
    }
  }

  // 3. Fall through to legacy arrays
  if (harnessConfig.deniedTools?.includes(toolName)) return 'deny'
  if (harnessConfig.allowedTools && !harnessConfig.allowedTools.includes(toolName)) return 'deny'

  return undefined
}

// ─── Authorization logic ─────────────────────────────────────────────────────

export function authorizeToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  policy: PolicyDocument,
  harnessId: string,
): { decision: AuthzDecision; reason: string | null; needsPrompt?: boolean } {
  const { actionClass } = classifyTool(toolName)
  const p = policy.permissions

  // Check permission flags by action class
  if (actionClass === 'execute' && !p.allowBash) {
    return { decision: 'deny', reason: 'Policy disallows shell execution.' }
  }
  if (actionClass === 'write' && !p.allowFileWrite) {
    return { decision: 'deny', reason: 'Policy disallows file writes.' }
  }
  if (actionClass === 'send' && !p.allowNetwork) {
    return { decision: 'deny', reason: 'Policy disallows network access.' }
  }

  // Check per-tool rules (toolRules → mcpServerRules → legacy arrays)
  const harnessConfig = policy.harnesses?.[harnessId as keyof typeof policy.harnesses] as any
  const toolDecision = resolveToolDecision(toolName, harnessConfig)
  if (toolDecision === 'deny') {
    return { decision: 'deny', reason: `Tool "${toolName}" is denied by policy rule.` }
  }
  if (toolDecision === 'prompt') {
    // Allow but flag for interactive approval even if confirmDestructive is off
    return { decision: 'allow', reason: `Tool "${toolName}" requires approval per policy rule.`, needsPrompt: true }
  }
  // toolDecision === 'allow' → skip further tool checks (still check blocked globs)

  // Check blocked globs for file-path-aware tools (works with both
  // Claude Code PascalCase and OpenClaw lowercase names)
  const normKey = normalizeToolKey(toolName)
  if (p.blockedGlobs?.length && (normKey === 'write' || normKey === 'edit' || normKey === 'read')) {
    const filePath = String(toolInput?.file_path ?? toolInput?.path ?? '')
    if (filePath) {
      for (const glob of p.blockedGlobs) {
        if (matchGlob(filePath, glob)) {
          return { decision: 'deny', reason: `Path "${filePath}" is blocked by glob "${glob}".` }
        }
      }
    }
  }

  // Check command rules for shell/exec tools
  if (normKey === 'bash' || normKey === 'exec' || normKey === 'execute') {
    const command = String(toolInput?.command ?? '')
    // undefined = use defaults, [] = no rules (opt-out)
    const rules = p.commandRules !== undefined ? p.commandRules : DEFAULT_COMMAND_RULES
    for (const rule of rules) {
      try {
        if (new RegExp(rule.pattern, 'i').test(command)) {
          if (rule.decision === 'deny') return { decision: 'deny', reason: rule.reason ?? `Command blocked by rule: ${rule.pattern}` }
          if (rule.decision === 'prompt') return { decision: 'allow', reason: rule.reason ?? `Command requires approval: ${rule.pattern}`, needsPrompt: true }
          break // 'allow' = skip remaining rules
        }
      } catch { /* bad regex — skip */ }
    }
  }

  return { decision: 'allow', reason: null }
}

/** Simple glob matching for blocked paths. Supports ** and * wildcards. */
export function matchGlob(filePath: string, glob: string): boolean {
  // Expand ~ to actual home directory
  const expanded = glob.replace(/^~/, os.homedir())
  // Convert glob to regex
  const regex = expanded
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')
  return new RegExp(`^${regex}$`).test(filePath)
}

// ─── Session registry ────────────────────────────────────────────────────────

interface RegisteredSession {
  sessionId: string
  harnessId: string
  policyId: string
  policyOverride: PolicyDocument | null
}

// ─── Server ──────────────────────────────────────────────────────────────────

export class AuthzServer {
  private server: http.Server | null = null
  private port = 0
  private secret: string
  private sessions = new Map<string, RegisteredSession>()
  private pendingApprovals = new Map<string, {
    approval: PendingApproval
    res: http.ServerResponse
    timer: ReturnType<typeof setTimeout>
  }>()
  private policyStore: PolicyStore
  private activityStore: ActivityStore
  private radar: Radar | null = null
  private feedStore: FeedStore | null = null
  private settingsStore: SettingsStore | null = null
  private sendToRenderer: (channel: string, payload: unknown) => void

  constructor(
    policyStore: PolicyStore,
    activityStore: ActivityStore,
    sendToRenderer: (channel: string, payload: unknown) => void,
  ) {
    this.policyStore = policyStore
    this.activityStore = activityStore
    this.sendToRenderer = sendToRenderer
    this.secret = crypto.randomBytes(16).toString('hex')
  }

  /** Get the shared secret for authenticating requests. */
  getSecret(): string {
    return this.secret
  }

  /** Wire up the radar for event-count triggers. */
  setRadar(radar: Radar): void {
    this.radar = radar
  }

  /** Wire up the feed store for agent status updates. */
  setFeedStore(feedStore: FeedStore): void {
    this.feedStore = feedStore
  }

  /** Wire up the settings store to read auto-accept preference. */
  setSettingsStore(store: SettingsStore): void {
    this.settingsStore = store
  }

  /** Start listening on 127.0.0.1 with an OS-assigned port. */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res))

      this.server.on('error', reject)

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address()
        this.port = typeof addr === 'object' && addr ? addr.port : 0
        console.log(`Authz server listening on port ${this.port}`)

        // Replace the startup error handler with a persistent runtime handler
        this.server!.removeAllListeners('error')
        this.server!.on('error', (err: any) => console.error('Authz server runtime error:', err?.message))

        resolve(this.port)
      })
    })
  }

  /** Stop the server. Auto-deny all pending approvals. */
  stop(): void {
    for (const [id] of this.pendingApprovals) {
      this.resolveApproval(id, 'deny')
    }
    this.server?.close()
    ;(this.server as any)?.closeAllConnections?.()
    this.server = null
  }

  /** Get the port the server is listening on. */
  getPort(): number {
    return this.port
  }

  /** Register a session for authorization. */
  registerSession(sessionId: string, harnessId: string, policyId: string, policyOverride?: PolicyDocument | null): void {
    this.sessions.set(sessionId, { sessionId, harnessId, policyId, policyOverride: policyOverride ?? null })
  }

  /** Unregister a session. Auto-deny all pending approvals for this session. */
  unregisterSession(sessionId: string): void {
    for (const [id, entry] of this.pendingApprovals) {
      if (entry.approval.sessionId === sessionId) {
        this.resolveApproval(id, 'deny')
      }
    }
    this.sessions.delete(sessionId)
  }

  /** Check if a tool call needs interactive approval based on policy. */
  private needsApproval(policy: PolicyDocument, actionClass: ActionClass, toolNeedsPrompt?: boolean): boolean {
    if (toolNeedsPrompt) return true
    if (!policy.permissions.confirmDestructive) return false
    return actionClass === 'execute' || actionClass === 'write'
  }

  /** Emit a policy-decision feed item so blocks/approvals appear in the feed timeline. */
  private emitPolicyFeed(sessionId: string, harnessId: string, message: string): void {
    if (!this.feedStore) return
    const item = this.feedStore.record({ sessionId, message, harnessId })
    this.sendToRenderer('latch:feed-update', item)
  }

  /** Resolve a pending approval (called from IPC or timeout). */
  resolveApproval(id: string, decision: ApprovalDecision): void {
    const entry = this.pendingApprovals.get(id)
    if (!entry) return

    clearTimeout(entry.timer)
    this.pendingApprovals.delete(id)

    const { approval, res } = entry
    const authzDecision: AuthzDecision = decision === 'approve' ? 'allow' : 'deny'
    const reason = decision === 'approve' ? 'User approved.' : 'User denied.'

    // Record activity event
    const event = this.activityStore.record({
      sessionId: approval.sessionId,
      toolName: approval.toolName,
      actionClass: approval.actionClass,
      risk: approval.risk,
      decision: authzDecision,
      reason,
      harnessId: approval.harnessId,
    })
    this.sendToRenderer('latch:activity-event', event)
    this.radar?.onEvent()

    // Surface in feed
    const verb = decision === 'approve' ? 'Approved' : 'Denied'
    this.emitPolicyFeed(approval.sessionId, approval.harnessId, `${verb}: ${approval.toolName}`)

    // Complete the held HTTP response
    try {
      if (authzDecision === 'allow') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ decision: 'allow' }))
      } else {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ decision: 'deny', reason }))
      }
    } catch {
      // Connection may have been closed by the client
    }

    this.sendToRenderer('latch:approval-resolved', { id })
  }

  /** Handle incoming HTTP requests. */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Authenticate via shared secret
    const authHeader = req.headers['authorization']
    if (!authHeader || authHeader !== `Bearer ${this.secret}`) {
      res.writeHead(401)
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    // Route: POST /authorize/:sessionId — tool-call authorization (Claude Code / OpenClaw)
    const authzMatch = req.url?.match(/^\/authorize\/([^/]+)$/)
    // Route: POST /notify/:sessionId — turn-complete observation (Codex notify hook)
    const notifyMatch = !authzMatch ? req.url?.match(/^\/notify\/([^/]+)$/) : null
    // Route: POST /feed/:sessionId — agent status update
    const feedMatch = (!authzMatch && !notifyMatch) ? req.url?.match(/^\/feed\/([^/]+)$/) : null

    if (!authzMatch && !notifyMatch && !feedMatch) {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    const sessionId = decodeURIComponent((authzMatch ?? notifyMatch ?? feedMatch)![1])
    let body = ''
    let bodyBytes = 0

    req.on('data', (chunk) => {
      bodyBytes += Buffer.byteLength(chunk)
      if (bodyBytes > MAX_BODY_BYTES) {
        res.writeHead(413)
        res.end(JSON.stringify({ error: 'Request body too large' }))
        req.destroy()
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (bodyBytes > MAX_BODY_BYTES) return // already responded
      try {
        if (authzMatch) {
          this.processAuthorize(sessionId, body, res)
        } else if (notifyMatch) {
          this.processNotify(sessionId, body, res)
        } else if (feedMatch) {
          this.processFeed(sessionId, body, res)
        }
      } catch (err: any) {
        console.error('Authz error:', err?.message)
        res.writeHead(500)
        res.end(JSON.stringify({ error: err?.message ?? 'Internal error' }))
      }
    })
  }

  /** Process an agent status-update feed post. */
  private processFeed(sessionId: string, body: string, res: http.ServerResponse): void {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(body)
    } catch {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Invalid JSON' }))
      return
    }

    const message = String(payload.status ?? payload.message ?? '').trim()
    if (!message) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Missing status message' }))
      return
    }

    const registered = this.sessions.get(sessionId)
    const harnessId = registered?.harnessId ?? 'unknown'

    if (this.feedStore) {
      const item = this.feedStore.record({ sessionId, message, harnessId })
      this.sendToRenderer('latch:feed-update', item)
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  }

  /** Process a Codex notify (turn-complete) event.
   *  Records it as an activity event so it appears in the Activity panel.
   */
  private processNotify(sessionId: string, body: string, res: http.ServerResponse): void {
    const registered = this.sessions.get(sessionId)

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(body)
    } catch {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Invalid JSON' }))
      return
    }

    const eventType = String(payload.type ?? 'unknown')

    // Record as an activity event for the Activity panel
    const event = this.activityStore.record({
      sessionId,
      toolName: `_codex:${eventType}`,
      actionClass: 'execute',
      risk: 'low',
      decision: 'allow',
      reason: eventType === 'agent-turn-complete'
        ? `Turn complete. ${String(payload['last-assistant-message'] ?? '').slice(0, 120)}`
        : null,
      harnessId: registered?.harnessId ?? 'codex',
    })
    this.sendToRenderer('latch:activity-event', event)
    this.radar?.onEvent()

    res.writeHead(200)
    res.end(JSON.stringify({ ok: true }))
  }

  /** Process an authorization request. */
  private processAuthorize(sessionId: string, body: string, res: http.ServerResponse): void {
    const registered = this.sessions.get(sessionId)
    if (!registered) {
      // Unknown session — denied by default
      res.writeHead(403)
      res.end(JSON.stringify({ decision: 'deny', reason: 'Unknown session — denied by default.' }))
      return
    }

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(body)
    } catch {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Invalid JSON' }))
      return
    }

    // Accept both Claude Code format (tool_name/tool_input) and
    // OpenClaw format (toolName/args)
    const toolName  = String(payload.tool_name ?? payload.toolName ?? 'unknown')
    const toolInput = (payload.tool_input ?? payload.args ?? {}) as Record<string, unknown>
    const { actionClass, risk } = classifyTool(toolName)

    // Resolve effective policy
    const result = this.policyStore.getPolicy(registered.policyId)
    if (!result.ok || !result.policy) {
      // Can't resolve policy — deny by default
      const denyReason = 'Policy not found — denied by default.'
      const event = this.activityStore.record({
        sessionId,
        toolName,
        actionClass,
        risk,
        decision: 'deny',
        reason: denyReason,
        harnessId: registered.harnessId,
      })
      this.sendToRenderer('latch:activity-event', event)
      this.radar?.onEvent()
      this.emitPolicyFeed(sessionId, registered.harnessId, `Blocked: ${toolName} — ${denyReason}`)

      res.writeHead(403)
      res.end(JSON.stringify({ decision: 'deny', reason: denyReason }))
      return
    }

    const effective = resolvePolicy(result.policy, registered.policyOverride)
    const { decision, reason, needsPrompt } = authorizeToolCall(toolName, toolInput, effective, registered.harnessId)

    // If policy denies outright, record and respond immediately
    if (decision === 'deny') {
      const event = this.activityStore.record({
        sessionId,
        toolName,
        actionClass,
        risk,
        decision,
        reason,
        harnessId: registered.harnessId,
      })
      this.sendToRenderer('latch:activity-event', event)
      this.radar?.onEvent()
      this.emitPolicyFeed(sessionId, registered.harnessId, `Blocked: ${toolName} — ${reason}`)

      res.writeHead(403)
      res.end(JSON.stringify({ decision: 'deny', reason }))
      return
    }

    // If interactive approval is needed, check auto-accept first
    if (this.needsApproval(effective, actionClass, needsPrompt)) {
      // Auto-accept: skip the interactive prompt and approve immediately
      const autoAccept = this.settingsStore?.get('auto-accept')
      if (autoAccept === null || autoAccept === 'true') {
        // Default is ON (null = never explicitly set = default ON)
        const event = this.activityStore.record({
          sessionId,
          toolName,
          actionClass,
          risk,
          decision: 'allow',
          reason: 'Auto-accepted.',
          harnessId: registered.harnessId,
        })
        this.sendToRenderer('latch:activity-event', event)
        this.radar?.onEvent()

        res.writeHead(200)
        res.end(JSON.stringify({ decision: 'allow' }))
        return
      }

      const approvalId = crypto.randomBytes(8).toString('hex')
      const timeoutDefault: ApprovalDecision = risk === 'high' ? 'deny' : 'approve'

      const approval: PendingApproval = {
        id: approvalId,
        sessionId,
        toolName,
        toolInput,
        actionClass,
        risk,
        harnessId: registered.harnessId,
        createdAt: new Date().toISOString(),
        timeoutMs: APPROVAL_TIMEOUT_MS,
        timeoutDefault,
      }

      const timer = setTimeout(() => {
        this.resolveApproval(approvalId, timeoutDefault)
      }, APPROVAL_TIMEOUT_MS)

      this.pendingApprovals.set(approvalId, { approval, res, timer })

      // Push to renderer for interactive UI
      this.sendToRenderer('latch:approval-request', approval)
      return
    }

    // Auto-allow — record event and respond
    const event = this.activityStore.record({
      sessionId,
      toolName,
      actionClass,
      risk,
      decision,
      reason,
      harnessId: registered.harnessId,
    })
    this.sendToRenderer('latch:activity-event', event)
    this.radar?.onEvent()

    res.writeHead(200)
    res.end(JSON.stringify({ decision: 'allow' }))
  }
}
