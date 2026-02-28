/**
 * @module commands/policy
 * @description Policy management commands for the Latch Terminal.
 * Includes the interactive policy creation wizard.
 */

import type { CommandRunner } from '../CommandRunner'
import { registerGroup } from './index'
import {
  BOLD, DIM, RESET, GREEN, CYAN, YELLOW, RED,
  table, spinner, writeln,
} from '../ansi'
import {
  promptText, promptSelect, promptConfirm, promptMultiSelect, promptCycleGrid,
} from '../prompts'
import type { PolicyDocument, PolicyPermissions, ToolRule, McpServerRule, HarnessesConfig } from '../../../types'

// ─── Constants ──────────────────────────────────────────────────────────────

const CLAUDE_TOOLS   = ['Read', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit']
const OPENCLAW_TOOLS = ['read', 'write', 'exec', 'web_search', 'web_fetch', 'browser']

// ─── Helpers ────────────────────────────────────────────────────────────────

function ruleCountSummary(rules: ToolRule[]): string {
  const allow = rules.filter(r => r.decision === 'allow').length
  const prompt = rules.filter(r => r.decision === 'prompt').length
  const deny = rules.filter(r => r.decision === 'deny').length
  const parts: string[] = []
  if (allow)  parts.push(`${GREEN}${allow} allow${RESET}`)
  if (prompt) parts.push(`${YELLOW}${prompt} prompt${RESET}`)
  if (deny)   parts.push(`${RED}${deny} deny${RESET}`)
  return parts.join(', ') || `${DIM}none${RESET}`
}

// ─── Commands ───────────────────────────────────────────────────────────────

async function policyList(runner: CommandRunner): Promise<void> {
  const { tabId } = runner
  const s = spinner(tabId, 'Loading policies...')

  const result = await window.latch.listPolicies()
  s.stop()

  if (!result.ok || !result.policies?.length) {
    writeln(tabId, `  ${DIM}No policies defined. Create one with:${RESET} ${GREEN}latch policy create${RESET}`)
    writeln(tabId, '')
    return
  }

  const rows = result.policies.map((p: any) => [
    p.name,
    p.id,
    p.description || `${DIM}—${RESET}`,
  ])

  writeln(tabId, '')
  writeln(tabId, table(['Name', 'ID', 'Description'], rows))
  writeln(tabId, '')
}

async function policyCreate(runner: CommandRunner): Promise<void> {
  const { tabId } = runner

  writeln(tabId, '')
  writeln(tabId, `  ${CYAN}${BOLD}Create a new policy${RESET}`)
  writeln(tabId, `  ${DIM}${'─'.repeat(30)}${RESET}`)
  writeln(tabId, '')

  // ── Step 1: Basics ──────────────────────────────────────────────────

  const name = await promptText(runner, 'Policy name')
  const desc = await promptText(runner, 'Description (optional)', { hint: 'What does this policy do?' })

  // ── Step 2: Permission gates ────────────────────────────────────────

  const permChoices = await promptMultiSelect(runner, 'Permission gates', [
    { label: 'Allow shell commands (bash/exec)', value: 'allowBash', checked: true },
    { label: 'Allow network access', value: 'allowNetwork', checked: true },
    { label: 'Allow file writes', value: 'allowFileWrite', checked: true },
    { label: 'Require approval for destructive operations', value: 'confirmDestructive', checked: true },
  ])

  const permissions: PolicyPermissions = {
    allowBash:          permChoices.includes('allowBash'),
    allowNetwork:       permChoices.includes('allowNetwork'),
    allowFileWrite:     permChoices.includes('allowFileWrite'),
    confirmDestructive: permChoices.includes('confirmDestructive'),
    blockedGlobs:       [],
  }

  // ── Step 3: MCP server rules ────────────────────────────────────────

  const harnesses: HarnessesConfig = {}
  const allToolRules: ToolRule[] = []
  const allMcpServerRules: McpServerRule[] = []

  const mcpResult = await window.latch.listMcpServers()
  const mcpServers = mcpResult?.ok ? (mcpResult.servers ?? []) : []
  const serversWithTools = mcpServers.filter((s: any) => s.tools?.length > 0)

  if (serversWithTools.length > 0) {
    writeln(tabId, '')
    writeln(tabId, `  ${BOLD}MCP Server Rules${RESET}`)
    writeln(tabId, '')

    // Show detected servers
    const serverRows = serversWithTools.map((s: any) => [
      s.name,
      String(s.tools.length),
      `${GREEN}Tools discovered${RESET}`,
    ])

    writeln(tabId, table(['Server', 'Tools', 'Status'], serverRows))
    writeln(tabId, '')

    for (const server of serversWithTools) {
      const serverKey = server.name.toLowerCase().replace(/\s+/g, '-')

      const action = await promptSelect(runner, `Rules for ${BOLD}${server.name}${RESET}:`, [
        { label: 'Configure per-tool rules', value: 'per-tool' },
        { label: 'Allow all tools', value: 'allow' },
        { label: 'Block all tools', value: 'deny' },
        { label: 'Prompt for all tools', value: 'prompt' },
        { label: 'Skip this server', value: 'skip' },
      ])

      if (action === 'skip') continue

      if (action === 'allow' || action === 'deny' || action === 'prompt') {
        allMcpServerRules.push({ server: serverKey, decision: action as 'allow' | 'deny' | 'prompt' })
        continue
      }

      // Per-tool configuration
      if (action === 'per-tool') {
        const items = server.tools.map((tool: string) => ({
          key: `mcp__${serverKey}__${tool}`,
          label: tool,
          description: server.toolDescriptions?.[tool] ?? '',
        }))

        const toolStates = await promptCycleGrid(runner, `${server.name} tools:`, items)

        for (const [pattern, decision] of toolStates) {
          allToolRules.push({ pattern, decision: decision as 'allow' | 'deny' | 'prompt' })
        }
      }
    }
  }

  // ── Step 4: Harness tool rules ──────────────────────────────────────

  const harnessResult = await window.latch.detectHarnesses()
  const installedHarnesses = (harnessResult?.harnesses ?? []).filter((h) => h.installed)

  for (const harness of installedHarnesses) {
    const builtinTools = harness.id === 'claude' ? CLAUDE_TOOLS
                       : harness.id === 'openclaw' ? OPENCLAW_TOOLS
                       : []

    if (builtinTools.length === 0) continue

    writeln(tabId, '')
    const items = builtinTools.map(tool => ({
      key: tool,
      label: tool,
    }))

    const toolStates = await promptCycleGrid(runner, `${harness.label} built-in tools:`, items)

    const harnessToolRules: ToolRule[] = []
    for (const [pattern, decision] of toolStates) {
      harnessToolRules.push({ pattern, decision: decision as 'allow' | 'deny' | 'prompt' })
    }

    // Merge MCP tool rules into harness config
    const combinedRules = [...harnessToolRules, ...allToolRules]

    if (harness.id === 'claude') {
      harnesses.claude = {}
      if (combinedRules.length) harnesses.claude.toolRules = combinedRules
      if (allMcpServerRules.length) harnesses.claude.mcpServerRules = allMcpServerRules
    } else if (harness.id === 'openclaw') {
      harnesses.openclaw = {}
      if (combinedRules.length) harnesses.openclaw.toolRules = combinedRules
      if (allMcpServerRules.length) harnesses.openclaw.mcpServerRules = allMcpServerRules
    } else if (harness.id === 'codex') {
      harnesses.codex = {}
      if (allMcpServerRules.length) harnesses.codex.mcpServerRules = allMcpServerRules
    }
  }

  // ── Step 5: Advanced (optional) ─────────────────────────────────────

  writeln(tabId, '')
  const doAdvanced = await promptConfirm(runner, 'Configure advanced rules? (blocked paths, command patterns)')

  if (doAdvanced) {
    // Blocked globs
    writeln(tabId, '')
    writeln(tabId, `  ${BOLD}Blocked paths${RESET}`)
    writeln(tabId, `  ${DIM}Enter glob patterns to block (empty to finish)${RESET}`)

    const globs: string[] = []
    let adding = true
    while (adding) {
      const glob = await promptText(runner, `Glob ${globs.length + 1}`, { hint: 'e.g. /etc/** or ~/.ssh/**' })
      if (!glob) {
        adding = false
      } else {
        globs.push(glob)
      }
    }
    if (globs.length) permissions.blockedGlobs = globs
  }

  // ── Step 6: Review + save ───────────────────────────────────────────

  writeln(tabId, '')
  writeln(tabId, `  ${BOLD}Policy Summary${RESET}`)
  writeln(tabId, `  ${DIM}${'─'.repeat(30)}${RESET}`)
  writeln(tabId, '')
  writeln(tabId, `  ${BOLD}Name:${RESET}        ${name || 'Untitled Policy'}`)
  if (desc) writeln(tabId, `  ${BOLD}Description:${RESET} ${desc}`)

  const permFlags = [
    permissions.allowBash          ? `${GREEN}bash ✓${RESET}` : `${RED}bash ✗${RESET}`,
    permissions.allowNetwork       ? `${GREEN}net ✓${RESET}`  : `${RED}net ✗${RESET}`,
    permissions.allowFileWrite     ? `${GREEN}files ✓${RESET}`: `${RED}files ✗${RESET}`,
    permissions.confirmDestructive ? `${YELLOW}confirm ✓${RESET}` : `${DIM}confirm ✗${RESET}`,
  ]
  writeln(tabId, `  ${BOLD}Permissions:${RESET} ${permFlags.join('  ')}`)

  if (allMcpServerRules.length) {
    writeln(tabId, `  ${BOLD}MCP servers:${RESET} ${allMcpServerRules.map(r => `${r.server}: ${r.decision}`).join(', ')}`)
  }
  if (allToolRules.length) {
    writeln(tabId, `  ${BOLD}Tool rules:${RESET}  ${ruleCountSummary(allToolRules)}`)
  }
  if (permissions.blockedGlobs.length) {
    writeln(tabId, `  ${BOLD}Blocked:${RESET}     ${permissions.blockedGlobs.join(', ')}`)
  }

  writeln(tabId, '')
  const confirm = await promptConfirm(runner, 'Save this policy?', true)

  if (!confirm) {
    writeln(tabId, `  ${DIM}Policy discarded.${RESET}`)
    writeln(tabId, '')
    return
  }

  const policy: PolicyDocument = {
    id:          `policy-${Date.now()}`,
    name:        name.trim() || 'Untitled Policy',
    description: desc.trim(),
    permissions,
    harnesses,
  }

  const saveSpinner = spinner(tabId, 'Saving policy...')
  const saveResult = await window.latch.savePolicy(policy)
  saveSpinner.stop()

  if (saveResult?.ok) {
    writeln(tabId, `  ${GREEN}✓${RESET} Policy "${name}" saved.`)
  } else {
    writeln(tabId, `  ${RED}✗${RESET} Failed to save: ${saveResult?.error ?? 'Unknown error'}`)
  }
  writeln(tabId, '')
}

async function policyEdit(runner: CommandRunner, args: string[]): Promise<void> {
  const { tabId } = runner
  const idOrName = args[0]

  if (!idOrName) {
    writeln(tabId, `  ${RED}Usage:${RESET} latch policy edit <policy-id>`)
    writeln(tabId, `  ${DIM}Run 'latch policy list' to see available policies.${RESET}`)
    writeln(tabId, '')
    return
  }

  const s = spinner(tabId, 'Loading policy...')
  const result = await window.latch.getPolicy({ id: idOrName })
  s.stop()

  if (!result?.ok || !result.policy) {
    writeln(tabId, `  ${RED}Policy not found:${RESET} ${idOrName}`)
    writeln(tabId, '')
    return
  }

  // For now, show summary. Full edit wizard is a future enhancement.
  const p = result.policy
  writeln(tabId, '')
  writeln(tabId, `  ${BOLD}${p.name}${RESET} ${DIM}(${p.id})${RESET}`)
  if (p.description) writeln(tabId, `  ${p.description}`)
  writeln(tabId, '')
  writeln(tabId, `  ${DIM}Full edit wizard coming soon. Use the GUI PolicyEditor for now.${RESET}`)
  writeln(tabId, '')
}

async function policyDelete(runner: CommandRunner, args: string[]): Promise<void> {
  const { tabId } = runner
  const id = args[0]

  if (!id) {
    writeln(tabId, `  ${RED}Usage:${RESET} latch policy delete <policy-id>`)
    writeln(tabId, '')
    return
  }

  const confirm = await promptConfirm(runner, `Delete policy "${id}"?`)
  if (!confirm) {
    writeln(tabId, `  ${DIM}Cancelled.${RESET}`)
    writeln(tabId, '')
    return
  }

  const result = await window.latch.deletePolicy({ id })
  if (result?.ok) {
    writeln(tabId, `  ${GREEN}✓${RESET} Policy deleted.`)
  } else {
    writeln(tabId, `  ${RED}✗${RESET} Failed to delete policy.`)
  }
  writeln(tabId, '')
}

// ─── Register ───────────────────────────────────────────────────────────────

registerGroup('policy', {
  description: 'Manage authorization policies',
  commands: {
    list:   { description: 'List all policies',              usage: 'latch policy list',              run: policyList },
    create: { description: 'Create a new policy (wizard)',   usage: 'latch policy create',            run: policyCreate },
    edit:   { description: 'View/edit an existing policy',   usage: 'latch policy edit <id>',         run: policyEdit },
    delete: { description: 'Delete a policy',                usage: 'latch policy delete <id>',       run: policyDelete },
  },
})
