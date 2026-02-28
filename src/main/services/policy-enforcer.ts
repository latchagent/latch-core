/**
 * @module policy-enforcer
 * @description Generates harness-native config files so each harness enforces
 * Latch policy rules natively. Runs in the main process only (needs fs access).
 */

import fs from 'node:fs'
import path from 'node:path'
import type { PolicyDocument, PolicyPermissions, CodexPolicyConfig, HarnessesConfig, ToolRule, McpServerRule, CommandRule } from '../../types'
import type { PolicyStore } from '../stores/policy-store'

// ─── Strictest-baseline computation ──────────────────────────────────────────

/** Priority map for merging tool/MCP/command rule decisions: higher = stricter. */
const DECISION_PRIORITY: Record<string, number> = { allow: 1, prompt: 2, deny: 3 }

/** Compute the most restrictive policy from a set of policies.
 *  Used as a fallback when a session's assigned policyId is missing.
 *
 *  Merge strategy:
 *  - Boolean permissions: AND (false if ANY policy says false)
 *  - confirmDestructive: OR (true if ANY policy says true)
 *  - blockedGlobs: union of all policies
 *  - commandRules: collect all rules from all policies
 *  - toolRules: merge by pattern — deny > prompt > allow wins
 *  - mcpServerRules: merge by server — deny > prompt > allow wins
 */
export function computeStrictestBaseline(policies: PolicyDocument[], harnessId?: string): PolicyDocument {
  const permissions: PolicyPermissions = {
    allowBash: true,
    allowNetwork: true,
    allowFileWrite: true,
    confirmDestructive: false,
    blockedGlobs: [],
  }

  const allCommandRules: CommandRule[] = []
  const toolRuleMap = new Map<string, ToolRule>()
  const mcpRuleMap = new Map<string, McpServerRule>()

  for (const p of policies) {
    // AND for allow flags (false if ANY policy says false)
    permissions.allowBash = permissions.allowBash && p.permissions.allowBash
    permissions.allowNetwork = permissions.allowNetwork && p.permissions.allowNetwork
    permissions.allowFileWrite = permissions.allowFileWrite && p.permissions.allowFileWrite
    // OR for confirmDestructive (true if ANY policy says true)
    permissions.confirmDestructive = permissions.confirmDestructive || p.permissions.confirmDestructive

    // Union blockedGlobs
    for (const g of p.permissions.blockedGlobs ?? []) {
      if (!permissions.blockedGlobs.includes(g)) permissions.blockedGlobs.push(g)
    }

    // Collect all command rules
    if (p.permissions.commandRules?.length) {
      allCommandRules.push(...p.permissions.commandRules)
    }

    // Merge tool rules per harness (stricter decision wins)
    const harnessKeys = harnessId ? [harnessId] : ['claude', 'codex', 'openclaw']
    for (const hk of harnessKeys) {
      const hc = p.harnesses?.[hk as keyof HarnessesConfig] as { toolRules?: ToolRule[]; mcpServerRules?: McpServerRule[] } | undefined
      if (hc?.toolRules) {
        for (const rule of hc.toolRules) {
          const existing = toolRuleMap.get(rule.pattern)
          if (!existing || (DECISION_PRIORITY[rule.decision] ?? 0) > (DECISION_PRIORITY[existing.decision] ?? 0)) {
            toolRuleMap.set(rule.pattern, rule)
          }
        }
      }
      if (hc?.mcpServerRules) {
        for (const rule of hc.mcpServerRules) {
          const existing = mcpRuleMap.get(rule.server)
          if (!existing || (DECISION_PRIORITY[rule.decision] ?? 0) > (DECISION_PRIORITY[existing.decision] ?? 0)) {
            mcpRuleMap.set(rule.server, rule)
          }
        }
      }
    }
  }

  if (allCommandRules.length) permissions.commandRules = allCommandRules

  const harnesses: HarnessesConfig = {}
  const toolRules = Array.from(toolRuleMap.values())
  const mcpServerRules = Array.from(mcpRuleMap.values())

  if (toolRules.length || mcpServerRules.length) {
    const hc: { toolRules?: ToolRule[]; mcpServerRules?: McpServerRule[] } = {}
    if (toolRules.length) hc.toolRules = toolRules
    if (mcpServerRules.length) hc.mcpServerRules = mcpServerRules
    harnesses.claude = hc
    harnesses.openclaw = hc
  }

  return {
    id: '__strictest-baseline__',
    name: 'Strictest Baseline (auto-computed)',
    description: 'Auto-computed most restrictive merge of all policies. Used when assigned policy is missing.',
    permissions,
    harnesses,
  }
}

// ─── Session ID validation ───────────────────────────────────────────────────

/** Validate that a sessionId is safe for interpolation into commands/URLs. */
function validateSessionId(sessionId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error(`Invalid sessionId: must match /^[a-zA-Z0-9_-]+$/, got "${sessionId}"`)
  }
}

// ─── Policy resolution ──────────────────────────────────────────────────────

/** Merge toolRules: override rules for the same pattern replace base rules. */
function mergeToolRules(base?: ToolRule[], override?: ToolRule[]): ToolRule[] | undefined {
  if (!base?.length && !override?.length) return undefined
  if (!override?.length) return base
  if (!base?.length) return override
  const merged = [...base]
  for (const ov of override) {
    const idx = merged.findIndex(r => r.pattern === ov.pattern)
    if (idx >= 0) merged[idx] = ov
    else merged.push(ov)
  }
  return merged
}

/** Merge mcpServerRules: override rules for the same server replace base rules. */
function mergeMcpServerRules(base?: McpServerRule[], override?: McpServerRule[]): McpServerRule[] | undefined {
  if (!base?.length && !override?.length) return undefined
  if (!override?.length) return base
  if (!base?.length) return override
  const merged = [...base]
  for (const ov of override) {
    const idx = merged.findIndex(r => r.server === ov.server)
    if (idx >= 0) merged[idx] = ov
    else merged.push(ov)
  }
  return merged
}

/** Merge a single harness config, deep-merging toolRules and mcpServerRules. */
function mergeHarnessConfig<T extends { toolRules?: ToolRule[]; mcpServerRules?: McpServerRule[] }>(
  base: T | undefined,
  override: T | undefined,
): T | undefined {
  if (!base && !override) return undefined
  const merged = { ...base, ...override } as T
  merged.toolRules = mergeToolRules(base?.toolRules, override?.toolRules)
  merged.mcpServerRules = mergeMcpServerRules(base?.mcpServerRules, override?.mcpServerRules)
  return merged
}

/** Merge base policy with a session override. Override wins per-key. */
export function resolvePolicy(base: PolicyDocument, override: PolicyDocument | null | undefined): PolicyDocument {
  if (!override) return base

  const permissions: PolicyPermissions = {
    allowBash:          override.permissions.allowBash          ?? base.permissions.allowBash,
    allowNetwork:       override.permissions.allowNetwork       ?? base.permissions.allowNetwork,
    allowFileWrite:     override.permissions.allowFileWrite     ?? base.permissions.allowFileWrite,
    confirmDestructive: override.permissions.confirmDestructive ?? base.permissions.confirmDestructive,
    blockedGlobs:       [...new Set([
      ...(base.permissions.blockedGlobs ?? []),
      ...(override.permissions.blockedGlobs ?? []),
    ])],
    // Command rules: override replaces base entirely (ordering matters)
    commandRules: override.permissions.commandRules ?? base.permissions.commandRules,
  }

  const harnesses: HarnessesConfig = {
    claude:   mergeHarnessConfig(base.harnesses?.claude,   override.harnesses?.claude),
    codex:    mergeHarnessConfig(base.harnesses?.codex,    override.harnesses?.codex),
    openclaw: mergeHarnessConfig(base.harnesses?.openclaw, override.harnesses?.openclaw),
  }

  return {
    id:          override.id ?? base.id,
    name:        override.name ?? base.name,
    description: override.description ?? base.description,
    permissions,
    harnesses,
  }
}

// ─── Claude Code enforcement ────────────────────────────────────────────────

/** Write `.claude/settings.json` with permissions derived from policy.
 *  When authzOptions is provided, injects a PreToolUse hook that calls the local authz server.
 */
// Harmless read-only tools that can always be auto-allowed without prompting.
// Everything else prompts natively — the Latch supervisor agent watches the
// terminal and types yes/no based on policy evaluation.
const CLAUDE_HARMLESS_TOOLS = [
  'Read', 'Glob', 'Grep',
  'AskUserQuestion',
  'EnterPlanMode', 'ExitPlanMode',
  'TodoRead', 'TodoWrite', 'TodoList',
  'Skill',
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop',
]

export function enforceForClaude(
  policy: PolicyDocument,
  targetDir: string,
  authzOptions?: { port: number; sessionId: string; secret: string },
): { configPath: string } {
  const deny: string[] = []
  const allow: string[] = []
  const p = policy.permissions
  const hc = policy.harnesses?.claude

  // Map Latch permissions → Claude deny rules
  if (!p.allowBash)      deny.push('Bash')
  if (!p.allowFileWrite) deny.push('Write', 'Edit')
  if (!p.allowNetwork)   deny.push('WebFetch', 'WebSearch')

  // Blocked globs → per-tool deny entries
  for (const glob of p.blockedGlobs ?? []) {
    deny.push(`Write(${glob})`, `Edit(${glob})`, `Read(${glob})`)
  }

  // Per-harness toolRules — only add DENY rules to Claude's native deny list.
  // Allow and prompt rules are handled by the supervisor agent at runtime.
  // This is defense-in-depth: denied tools are blocked by BOTH the hook AND
  // Claude's native permission system.
  if (hc?.toolRules) {
    for (const rule of hc.toolRules) {
      if (rule.decision === 'deny' && !deny.includes(rule.pattern)) deny.push(rule.pattern)
    }
  }

  // Per-harness legacy deniedTools (backward compat)
  if (hc?.deniedTools) {
    for (const tool of hc.deniedTools) {
      if (!deny.includes(tool)) deny.push(tool)
    }
  }
  // NOTE: hc.allowedTools is intentionally NOT added to Claude's native allow
  // list. In the supervisor model, only CLAUDE_HARMLESS_TOOLS are auto-allowed.
  // Everything else prompts natively so the supervisor can evaluate and respond.

  // Add only harmless tools to the allow list. All other tools are left out so
  // Claude's built-in permission system prompts natively. The Latch supervisor
  // agent watches the terminal and types yes/no based on policy evaluation.
  for (const tool of CLAUDE_HARMLESS_TOOLS) {
    if (!deny.includes(tool) && !allow.includes(tool)) {
      allow.push(tool)
    }
  }

  // Read existing settings to preserve non-permission keys
  const claudeDir  = path.join(targetDir, '.claude')
  const configPath = path.join(claudeDir, 'settings.json')
  let existing: Record<string, unknown> = {}

  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    existing = JSON.parse(raw)
  } catch {
    // File doesn't exist or is invalid — start fresh
  }

  // Overwrite only the permissions key
  existing.permissions = {
    ...(allow.length ? { allow } : {}),
    ...(deny.length  ? { deny }  : {}),
  }

  // Inject PreToolUse hook for supervisor notification.
  // Claude Code hook format uses 3-level nesting: event → [{ matcher, hooks: [...] }]
  //
  // The hook notifies the Latch supervisor of each tool call. The supervisor
  // evaluates policy and queues a decision. When Claude's native permission
  // prompt appears, the supervisor types yes/no into the terminal.
  //
  //   200 → exit 0 (tool proceeds to native prompt; supervisor handles it)
  //   403 → extract reason, write to stderr, exit 2 (hard deny — blocked by hook)
  //   curl failure → exit 0 (fail open so harness isn't bricked)
  //
  // --connect-timeout 3: fail fast if server is unreachable
  // --max-time 5: server always responds immediately (no held connections)
  if (authzOptions) {
    validateSessionId(authzOptions.sessionId)
    const url = `http://127.0.0.1:${authzOptions.port}/supervise/${authzOptions.sessionId}`

    const scriptPath = path.join(claudeDir, 'latch-authz.sh')
    const scriptContent = [
      '#!/bin/bash',
      '# Generated by Latch Desktop — do not edit manually.',
      '# PreToolUse hook: notifies Latch supervisor of tool calls.',
      '# Hard denies (403) are blocked here. Everything else exits 0;',
      '# the supervisor handles prompt decisions by driving the terminal.',
      `RESP=$(curl -s -w '\\n%{http_code}' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -H 'Authorization: Bearer ${authzOptions.secret}' \\`,
      `  --connect-timeout 3 --max-time 5 \\`,
      `  -d @- '${url}' 2>/dev/null) || exit 0`,
      '',
      "HTTP_CODE=$(printf '%s\\n' \"$RESP\" | tail -n1)",
      "BODY=$(printf '%s\\n' \"$RESP\" | sed '$d')",
      '',
      '# 403 = hard deny — block the tool call',
      'if [ "$HTTP_CODE" = "403" ]; then',
      '  REASON=$(printf \'%s\' "$BODY" | grep -o \'"reason":"[^"]*"\' | head -1 \\',
      '    | sed \'s/"reason":"//;s/"$//\')',
      '  printf \'%s\\n\' "${REASON:-Denied by Latch policy}" >&2',
      '  exit 2',
      'fi',
      '',
      '# 200 = supervisor notified. Output "ask" so Claude shows its native',
      '# permission prompt. The supervisor watches the terminal and types yes/no.',
      '# Without this output, exit 0 would bypass the permission check entirely.',
      "printf '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\"}}\\n'",
      'exit 0',
      '',
    ].join('\n')

    fs.writeFileSync(scriptPath, scriptContent, 'utf-8')
    try { fs.chmodSync(scriptPath, 0o755) } catch { /* Windows — non-fatal */ }

    existing.hooks = {
      ...((existing.hooks as Record<string, unknown>) ?? {}),
      PreToolUse: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: `bash '${scriptPath}'` }],
        },
      ],
    }
  }

  fs.mkdirSync(claudeDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8')

  return { configPath }
}

// ─── Codex enforcement ──────────────────────────────────────────────────────

/** Escape a string for use inside a TOML double-quoted value. */
function escapeToml(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
}

/** Map Latch permissions → Codex approval_policy config value. */
function mapCodexApprovalPolicy(p: PolicyPermissions, hx?: CodexPolicyConfig): string {
  if (hx?.approvalMode) {
    const map: Record<string, string> = { 'auto': 'never', 'read-only': 'on-request', 'full': 'untrusted' }
    return map[hx.approvalMode] ?? 'on-request'
  }
  if (!p.allowFileWrite) return 'on-request'
  if (p.confirmDestructive) return 'on-request'
  return 'never'
}

/** Map Latch permissions → Codex sandbox_mode config value. */
function mapCodexSandboxMode(p: PolicyPermissions, hx?: CodexPolicyConfig): string {
  if (hx?.sandbox) {
    const map: Record<string, string> = { 'strict': 'read-only', 'moderate': 'workspace-write', 'permissive': 'danger-full-access' }
    return map[hx.sandbox] ?? 'workspace-write'
  }
  if (!p.allowBash || !p.allowFileWrite) return 'read-only'
  if (p.confirmDestructive) return 'workspace-write'
  return 'danger-full-access'
}

/** Generate `.codex/config.toml` with policy-derived Codex settings.
 *
 *  Covers: approval_policy, sandbox_mode, [shell_environment_policy],
 *  [features], notify hook, and MCP disabled_tools.
 */
function generateCodexConfig(
  policy: PolicyDocument,
  codexDir: string,
  authzOptions?: { port: number; sessionId: string; secret: string },
): string {
  const p  = policy.permissions
  const hx = policy.harnesses?.codex
  const lines: string[] = [
    '# Generated by Latch Desktop — do not edit manually.',
    `# Policy: ${escapeToml(policy.name)}`,
    '',
  ]

  // ── Core settings ─────────────────────────────────────────────────────────
  lines.push(`approval_policy = "${mapCodexApprovalPolicy(p, hx)}"`)
  lines.push(`sandbox_mode = "${mapCodexSandboxMode(p, hx)}"`)
  lines.push('')

  // ── Shell environment policy ──────────────────────────────────────────────
  // Controls what env vars the Codex shell inherits.  "core" strips most vars
  // but keeps PATH, HOME, USER, SHELL.  Codex auto-strips vars matching
  // KEY/SECRET/TOKEN by default (ignore_default_excludes = false).
  lines.push('[shell_environment_policy]')
  const envInherit = hx?.envInherit ?? (!p.allowBash ? 'none' : 'core')
  lines.push(`inherit = "${envInherit}"`)

  const envExcludes = hx?.envExclude ?? ['AWS_*', 'AZURE_*', 'GCP_*', 'GOOGLE_*', 'OPENAI_*']
  if (envExcludes.length) {
    lines.push(`exclude = [${envExcludes.map(e => `"${escapeToml(e)}"`).join(', ')}]`)
  }
  lines.push('')

  // ── Features ──────────────────────────────────────────────────────────────
  lines.push('[features]')
  if (!p.allowBash) lines.push('shell_tool = false')
  if (!p.allowNetwork) {
    lines.push('web_search = false')
    lines.push('web_search_cached = false')
    lines.push('web_search_request = false')
  }
  if (hx?.features) {
    for (const [key, val] of Object.entries(hx.features)) {
      if (typeof val === 'string') {
        lines.push(`${key} = "${escapeToml(val)}"`)
      } else {
        lines.push(`${key} = ${val}`)
      }
    }
  }
  lines.push('')

  // ── MCP disabled tools ────────────────────────────────────────────────────
  // Codex supports per-server disabled_tools, but we use a synthetic
  // "latch-policy" server entry with disabled_tools to globally suppress tools.
  // Include both legacy disabledMcpTools and deny rules from toolRules/mcpServerRules.
  const disabledTools = [...(hx?.disabledMcpTools ?? [])]
  if (hx?.toolRules) {
    for (const rule of hx.toolRules) {
      if (rule.decision === 'deny' && !disabledTools.includes(rule.pattern)) disabledTools.push(rule.pattern)
    }
  }
  if (hx?.mcpServerRules) {
    for (const rule of hx.mcpServerRules) {
      if (rule.decision === 'deny') {
        const wildcard = `${rule.server}/*`
        if (!disabledTools.includes(wildcard)) disabledTools.push(wildcard)
      }
    }
  }
  if (disabledTools.length) {
    lines.push('# Latch policy: globally disabled MCP tools')
    lines.push('[mcp_servers.latch-policy]')
    lines.push('enabled = false')
    lines.push(`disabled_tools = [${disabledTools.map(t => `"${escapeToml(t)}"`).join(', ')}]`)
    lines.push('')
  }

  // ── Notify hook (turn-complete observation) ───────────────────────────────
  // Codex calls notify with JSON as argv[1] after each agent turn.
  // We POST it to our authz server for activity tracking.
  if (authzOptions) {
    validateSessionId(authzOptions.sessionId)
    const notifyScript = path.join(codexDir, 'latch-notify.sh')
    const url = `http://127.0.0.1:${authzOptions.port}/notify/${authzOptions.sessionId}`
    const scriptContent = [
      '#!/bin/bash',
      '# Generated by Latch Desktop — do not edit manually.',
      '# Posts Codex turn-complete events to the Latch authz server.',
      `curl -sf "${url}" \\`,
      '  -H \'Content-Type: application/json\' \\',
      `  -H 'Authorization: Bearer ${authzOptions.secret}' \\`,
      '  -d "$1" 2>/dev/null || true',
      '',
    ].join('\n')
    fs.writeFileSync(notifyScript, scriptContent, 'utf-8')
    try { fs.chmodSync(notifyScript, 0o755) } catch { /* Windows — non-fatal */ }
    lines.push(`notify = ["bash", "${escapeToml(notifyScript)}"]`)
    lines.push('')
  }

  const configPath = path.join(codexDir, 'config.toml')
  fs.writeFileSync(configPath, lines.join('\n') + '\n', 'utf-8')
  return configPath
}

/** Generate `.codex/rules/latch-policy.rules` with Starlark prefix_rule() calls.
 *
 *  Rules use Codex's execution policy engine — each rule matches a shell command
 *  prefix and returns allow / prompt / forbidden.  Most restrictive decision wins
 *  when multiple rules match.
 */
function generateCodexRules(policy: PolicyDocument, rulesDir: string): void {
  const p  = policy.permissions
  const hx = policy.harnesses?.codex
  const lines: string[] = [
    '# Generated by Latch Desktop — do not edit manually.',
    `# Policy: ${policy.name}`,
    '',
  ]

  // ── Network-access rules ────────────────────────────────────────────────
  if (!p.allowNetwork) {
    lines.push('# ── Network access denied by policy ──')
    for (const cmd of ['curl', 'wget', 'ssh', 'scp', 'nc', 'ncat', 'telnet', 'ftp', 'sftp', 'rsync']) {
      lines.push(`prefix_rule(pattern = ["${cmd}"], decision = "forbidden", justification = "Network access blocked by Latch policy")`)
    }
    // Package managers & git network ops
    for (const [a, b] of [['npm','publish'], ['npm','install'], ['pip','install'], ['git','push'], ['git','fetch'], ['git','pull'], ['git','clone']]) {
      lines.push(`prefix_rule(pattern = ["${a}", "${b}"], decision = "forbidden", justification = "Network access blocked by Latch policy")`)
    }
    lines.push('')
  }

  // ── Destructive operation rules ─────────────────────────────────────────
  if (p.confirmDestructive) {
    lines.push('# ── Destructive operations require confirmation ──')
    lines.push('prefix_rule(pattern = ["rm", "-rf"], decision = "prompt", justification = "Destructive operation — confirm before proceeding")')
    lines.push('prefix_rule(pattern = ["rm", "-r"], decision = "prompt", justification = "Recursive delete — confirm before proceeding")')
    lines.push('prefix_rule(pattern = ["git", "push", "--force"], decision = "prompt", justification = "Force push — confirm before proceeding")')
    lines.push('prefix_rule(pattern = ["git", "reset", "--hard"], decision = "prompt", justification = "Hard reset — confirm before proceeding")')
    lines.push('prefix_rule(pattern = ["git", "clean", "-f"], decision = "prompt", justification = "Git clean — confirm before proceeding")')
    lines.push('prefix_rule(pattern = ["chmod", "777"], decision = "prompt", justification = "Broad permission change — confirm before proceeding")')
    lines.push('prefix_rule(pattern = ["docker", "system", "prune"], decision = "prompt", justification = "Docker prune — confirm before proceeding")')
    lines.push('')
  }

  // ── Custom denied commands from harness config ──────────────────────────
  if (hx?.deniedCommands?.length) {
    lines.push('# ── Custom denied commands ──')
    for (const cmd of hx.deniedCommands) {
      const tokens = cmd.split(/\s+/).map(t => `"${escapeToml(t)}"`).join(', ')
      lines.push(`prefix_rule(pattern = [${tokens}], decision = "forbidden", justification = "Command blocked by Latch policy")`)
    }
    lines.push('')
  }

  // ── Custom prompt commands from harness config ──────────────────────────
  if (hx?.promptCommands?.length) {
    lines.push('# ── Commands requiring approval ──')
    for (const cmd of hx.promptCommands) {
      const tokens = cmd.split(/\s+/).map(t => `"${escapeToml(t)}"`).join(', ')
      lines.push(`prefix_rule(pattern = [${tokens}], decision = "prompt", justification = "Command requires approval per Latch policy")`)
    }
    lines.push('')
  }

  // ── toolRules-based shell command rules ────────────────────────────────
  // Only shell-like tool names (non-MCP, non-Claude built-in) can map to prefix_rule.
  if (hx?.toolRules?.length) {
    const shellPrompts: string[] = []
    const shellDenies: string[] = []
    for (const rule of hx.toolRules) {
      // Skip wildcard patterns and MCP-namespaced tools
      if (rule.pattern.includes('*') || rule.pattern.includes('__')) continue
      // Only lower-case single-word patterns that look like shell commands
      if (!/^[a-z][a-z0-9_-]*$/.test(rule.pattern)) continue
      if (rule.decision === 'prompt') shellPrompts.push(rule.pattern)
      if (rule.decision === 'deny') shellDenies.push(rule.pattern)
    }
    if (shellDenies.length) {
      lines.push('# ── Tool rules: denied shell commands ──')
      for (const cmd of shellDenies) {
        lines.push(`prefix_rule(pattern = ["${escapeToml(cmd)}"], decision = "forbidden", justification = "Tool denied by Latch policy rule")`)
      }
      lines.push('')
    }
    if (shellPrompts.length) {
      lines.push('# ── Tool rules: prompt shell commands ──')
      for (const cmd of shellPrompts) {
        lines.push(`prefix_rule(pattern = ["${escapeToml(cmd)}"], decision = "prompt", justification = "Tool requires approval per Latch policy rule")`)
      }
      lines.push('')
    }
  }

  // ── Command rules → Starlark prefix_rule() ─────────────────────────
  // Convert simple, non-regex commandRules to prefix_rule(). Complex patterns
  // (regex metacharacters) are skipped — enforced at authz server level.
  if (p.commandRules?.length) {
    const cmdDenies: { pattern: string; reason?: string }[] = []
    const cmdPrompts: { pattern: string; reason?: string }[] = []
    for (const rule of p.commandRules) {
      // Skip patterns that use regex metacharacters beyond simple literals
      if (/[\\^$*+?.()|[\]{}]/.test(rule.pattern)) continue
      if (rule.decision === 'deny') cmdDenies.push(rule)
      if (rule.decision === 'prompt') cmdPrompts.push(rule)
    }
    if (cmdDenies.length) {
      lines.push('# ── Command rules: denied ──')
      for (const rule of cmdDenies) {
        const tokens = rule.pattern.split(/\s+/).map(t => `"${escapeToml(t)}"`).join(', ')
        lines.push(`prefix_rule(pattern = [${tokens}], decision = "forbidden", justification = "${escapeToml(rule.reason ?? 'Blocked by command rule')}")`)
      }
      lines.push('')
    }
    if (cmdPrompts.length) {
      lines.push('# ── Command rules: prompt ──')
      for (const rule of cmdPrompts) {
        const tokens = rule.pattern.split(/\s+/).map(t => `"${escapeToml(t)}"`).join(', ')
        lines.push(`prefix_rule(pattern = [${tokens}], decision = "prompt", justification = "${escapeToml(rule.reason ?? 'Requires approval per command rule')}")`)
      }
      lines.push('')
    }
  }

  fs.writeFileSync(path.join(rulesDir, 'latch-policy.rules'), lines.join('\n') + '\n', 'utf-8')
}

/** Write `.codex/config.toml`, `.codex/rules/latch-policy.rules`, and optionally
 *  a notify script.  Also returns modified command string with CLI flags for
 *  critical settings (highest precedence, applies even if project isn't trusted).
 */
export function enforceForCodex(
  policy: PolicyDocument,
  baseCommand: string,
  targetDir: string,
  authzOptions?: { port: number; sessionId: string; secret: string },
): { harnessCommand: string; configPath: string } {
  const p  = policy.permissions
  const hx = policy.harnesses?.codex
  const flags: string[] = []

  // CLI flags for critical settings — highest precedence, always applies
  // regardless of project trust level.
  if (hx?.approvalMode) {
    flags.push(`--approval-mode ${hx.approvalMode}`)
  } else if (!p.allowFileWrite) {
    flags.push('--approval-mode read-only')
  } else if (p.confirmDestructive) {
    flags.push('--approval-mode full')
  }

  if (hx?.sandbox) {
    flags.push(`--sandbox ${hx.sandbox}`)
  } else if (!p.allowBash || !p.allowFileWrite) {
    flags.push('--sandbox strict')
  } else if (p.confirmDestructive) {
    flags.push('--sandbox moderate')
  }

  // Generate config files in the worktree's .codex/ directory
  const codexDir = path.join(targetDir, '.codex')
  const rulesDir = path.join(codexDir, 'rules')
  fs.mkdirSync(rulesDir, { recursive: true })

  const configPath = generateCodexConfig(policy, codexDir, authzOptions)
  generateCodexRules(policy, rulesDir)

  const harnessCommand = flags.length
    ? `${baseCommand} ${flags.join(' ')}`
    : baseCommand

  return { harnessCommand, configPath }
}

// ─── OpenClaw enforcement ───────────────────────────────────────────────────

/** Write `openclaw.json` with tool permissions and install the latch-authz plugin
 *  for runtime tool-call interception via the `before_tool_call` plugin API.
 */
export function enforceForOpenClaw(
  policy: PolicyDocument,
  targetDir: string,
  authzOptions?: { port: number; sessionId: string; secret: string },
): { configPath: string } {
  const deny: string[]  = []
  const allow: string[] = []
  const p  = policy.permissions
  const ho = policy.harnesses?.openclaw

  if (!p.allowBash)      deny.push('exec')
  if (!p.allowFileWrite) deny.push('write')
  if (!p.allowNetwork)   deny.push('web_search', 'web_fetch', 'browser')

  // Per-harness toolRules (new system — defense-in-depth)
  if (ho?.toolRules) {
    for (const rule of ho.toolRules) {
      if (rule.decision === 'deny' && !deny.includes(rule.pattern)) deny.push(rule.pattern)
      if (rule.decision === 'allow' && !allow.includes(rule.pattern)) allow.push(rule.pattern)
      // 'prompt' rules are NOT added to deny — runtime plugin handles them
    }
  }

  if (ho?.deniedTools) {
    for (const tool of ho.deniedTools) {
      if (!deny.includes(tool)) deny.push(tool)
    }
  }
  if (ho?.allowedTools) {
    for (const tool of ho.allowedTools) {
      if (!allow.includes(tool)) allow.push(tool)
    }
  }

  const configPath = path.join(targetDir, 'openclaw.json')
  let existing: Record<string, unknown> = {}

  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    existing = JSON.parse(raw)
  } catch {
    // File doesn't exist — start fresh
  }

  existing.tools = {
    ...(allow.length ? { allow } : {}),
    ...(deny.length  ? { deny }  : {}),
  }

  // Install the latch-authz plugin for runtime before_tool_call interception.
  // OpenClaw plugins use api.on('before_tool_call', handler) and return
  // { action: 'allow' | 'block', reason?: string }.
  if (authzOptions) {
    validateSessionId(authzOptions.sessionId)
    const pluginDir = path.join(targetDir, '.openclaw', 'plugins', 'latch-authz')
    fs.mkdirSync(pluginDir, { recursive: true })

    const authzUrl = `http://127.0.0.1:${authzOptions.port}/authorize/${authzOptions.sessionId}`

    // Plugin entry point — registers a before_tool_call handler that POSTs
    // to the Latch authz server and maps the response to OpenClaw's decision format.
    const pluginTimeout = policy.permissions.confirmDestructive ? 120000 : 5000

    const pluginSrc = `// Generated by Latch Desktop — do not edit manually.
const http = require('http');
const AUTHZ_URL = '${authzUrl}';
const AUTHZ_SECRET = '${authzOptions.secret}';
const PLUGIN_TIMEOUT = ${pluginTimeout};

module.exports = function latchAuthzPlugin(api) {
  api.on('before_tool_call', function(event) {
    return new Promise(function(resolve) {
      const body = JSON.stringify({ toolName: event.toolName, args: event.args || {} });
      const url = new URL(AUTHZ_URL);
      const opts = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': 'Bearer ' + AUTHZ_SECRET },
        timeout: PLUGIN_TIMEOUT,
      };

      const req = http.request(opts, function(res) {
        let data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
          if (res.statusCode === 200) {
            resolve({ action: 'allow' });
          } else {
            let reason = 'Latch policy denied this tool call.';
            try { reason = JSON.parse(data).reason || reason; } catch { /* non-JSON response body */ }
            resolve({ action: 'block', reason: reason });
          }
        });
      });

      req.on('error', function() {
        resolve({ action: 'block', reason: 'Latch authz server unreachable — failing closed.' });
      });
      req.on('timeout', function() {
        req.destroy();
        resolve({ action: 'block', reason: 'Latch authz server timed out — failing closed.' });
      });

      req.write(body);
      req.end();
    });
  });
};
`

    fs.writeFileSync(path.join(pluginDir, 'index.js'), pluginSrc, 'utf-8')

    // Enable the plugin in the config
    const plugins = (existing.plugins as Record<string, unknown>) ?? {}
    const entries = (plugins.entries as Record<string, unknown>) ?? {}
    entries['latch-authz'] = { enabled: true }
    plugins.entries = entries
    existing.plugins = plugins
  }

  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
  return { configPath }
}

/** Generate `.openclaw/exec-approvals.json` to skip interactive prompts.
 *  Sets `security: full` + `ask: off` so OpenClaw doesn't double-prompt —
 *  the latch-authz plugin handles gating via `before_tool_call`.
 */
function generateOpenClawApprovals(targetDir: string): void {
  const approvals = {
    tools: {
      exec: { security: 'full', ask: 'off' },
      write: { security: 'full', ask: 'off' },
      read: { security: 'full', ask: 'off' },
    },
  }
  const approvalsDir = path.join(targetDir, '.openclaw')
  fs.mkdirSync(approvalsDir, { recursive: true })
  fs.writeFileSync(
    path.join(approvalsDir, 'exec-approvals.json'),
    JSON.stringify(approvals, null, 2) + '\n',
    'utf-8',
  )
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function enforcePolicy(
  policyStore: PolicyStore,
  payload: {
    policyId: string
    policyOverride?: PolicyDocument | null
    harnessId: string
    harnessCommand: string
    worktreePath: string | null
    projectDir?: string | null
    authzPort?: number
    authzSecret?: string
    sessionId?: string
  }
): Promise<{ ok: boolean; harnessCommand?: string; configPath?: string; error?: string }> {
  const { policyOverride, harnessId, harnessCommand, worktreePath, projectDir, authzPort, authzSecret, sessionId } = payload

  // Merge ALL top-level policies using strictest-wins semantics.
  // All policies are always active — session overrides are applied on top.
  const allResult = policyStore.listPolicies()
  if (!allResult.ok || !allResult.policies?.length) {
    return { ok: false, error: 'No policies available for enforcement.' }
  }

  const basePolicy = computeStrictestBaseline(allResult.policies, harnessId)
  const effective = resolvePolicy(basePolicy, policyOverride)

  const targetDir = worktreePath ?? projectDir

  try {
    switch (harnessId) {
      case 'claude': {
        if (!targetDir) return { ok: false, error: 'No project directory or worktree available for policy enforcement.' }
        const authzOpts = (authzPort && sessionId && authzSecret) ? { port: authzPort, sessionId, secret: authzSecret } : undefined
        const { configPath } = enforceForClaude(effective, targetDir, authzOpts)
        // Supervisor model: minimal allow list (harmless tools only), deny list from
        // policy, everything else prompts natively. The PreToolUse hook notifies the
        // supervisor, which types yes/no into the terminal based on policy evaluation.
        return { ok: true, harnessCommand, configPath }
      }
      case 'codex': {
        if (!targetDir) return { ok: false, error: 'No project directory or worktree available for policy enforcement.' }
        const authzOpts = (authzPort && sessionId && authzSecret) ? { port: authzPort, sessionId, secret: authzSecret } : undefined
        const { harnessCommand: enforced, configPath } = enforceForCodex(effective, harnessCommand, targetDir, authzOpts)
        // --full-auto skips interactive approval prompts. Config files (.codex/config.toml,
        // .rules) are still loaded and respected.  This prevents double-prompting since
        // Latch controls enforcement via config files + rules.
        const codexCmd = enforced
          ? `${enforced} --full-auto`
          : enforced
        return { ok: true, harnessCommand: codexCmd, configPath }
      }
      case 'openclaw': {
        if (!targetDir) {
          // No project directory — skip file-based enforcement, pass through command
          return { ok: true, harnessCommand }
        }
        const authzOpts = (authzPort && sessionId && authzSecret) ? { port: authzPort, sessionId, secret: authzSecret } : undefined
        const { configPath } = enforceForOpenClaw(effective, targetDir, authzOpts)
        // Generate exec-approvals config to skip interactive prompts. The before_tool_call
        // plugin (latch-authz) still fires independently of exec approvals.
        generateOpenClawApprovals(targetDir)
        return { ok: true, harnessCommand, configPath }
      }
      case 'droid': {
        // Droid (Factory.ai) — launch with --auto high --skip-permissions-unsafe.
        // --auto high sets the permission scope (what ops are allowed).
        // --skip-permissions-unsafe disables interactive approval prompts so
        // Latch's authz server handles policy enforcement without double-prompting.
        const droidCmd = harnessCommand
          ? `${harnessCommand} --auto high --skip-permissions-unsafe`
          : harnessCommand
        return { ok: true, harnessCommand: droidCmd }
      }
      default:
        // Unknown harness — no enforcement, pass through
        return { ok: true, harnessCommand }
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Policy enforcement failed.' }
  }
}
