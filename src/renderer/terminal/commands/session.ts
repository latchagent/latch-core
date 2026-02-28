/**
 * @module commands/session
 * @description Session management commands for the Latch Terminal.
 */

import type { CommandRunner } from '../CommandRunner'
import { registerGroup } from './index'
import { BOLD, DIM, RESET, GREEN, RED, CYAN, table, spinner, writeln } from '../ansi'
import { useAppStore } from '../../store/useAppStore'

async function sessionList(runner: CommandRunner): Promise<void> {
  const { tabId } = runner
  const sessions = useAppStore.getState().sessions

  if (sessions.size === 0) {
    writeln(tabId, `  ${DIM}No active sessions. Create one with:${RESET} ${GREEN}latch session create${RESET}`)
    writeln(tabId, '')
    return
  }

  const rows: string[][] = []
  sessions.forEach((s) => {
    rows.push([
      s.name,
      s.harness || `${DIM}—${RESET}`,
      s.policy || `${DIM}—${RESET}`,
      `${s.tabs.size} tab(s)`,
    ])
  })

  writeln(tabId, '')
  writeln(tabId, table(['Name', 'Harness', 'Policy', 'Tabs'], rows))
  writeln(tabId, '')
}

async function sessionCreate(runner: CommandRunner): Promise<void> {
  const { tabId } = runner

  // Trigger the session creation flow through the app store
  const store = useAppStore.getState()
  const sessionId = store.createSession('New Session')

  writeln(tabId, `  ${GREEN}✓${RESET} Session created. Switching to session wizard...`)
  writeln(tabId, '')

  // Navigate to the session
  store.activateSession(sessionId)
  store.setActiveView('home')
}

async function sessionStatus(runner: CommandRunner): Promise<void> {
  const { tabId } = runner
  const s = spinner(tabId, 'Loading status...')

  const [sessions, policies, mcpServers, secrets] = await Promise.all([
    Promise.resolve(useAppStore.getState().sessions),
    window.latch.listPolicies(),
    window.latch.listMcpServers(),
    window.latch.listSecrets(),
  ])

  s.stop()

  const mcpWithTools = (mcpServers?.servers ?? []).filter((s: any) => s.tools?.length > 0)

  writeln(tabId, '')
  writeln(tabId, `  ${BOLD}Latch Status${RESET}`)
  writeln(tabId, `  ${DIM}${'─'.repeat(30)}${RESET}`)
  writeln(tabId, '')
  writeln(tabId, `  ${CYAN}Sessions:${RESET}    ${sessions.size} active`)
  writeln(tabId, `  ${CYAN}Policies:${RESET}    ${policies?.policies?.length ?? 0} defined`)
  writeln(tabId, `  ${CYAN}MCP Servers:${RESET} ${mcpServers?.servers?.length ?? 0} configured (${mcpWithTools.length} with discovered tools)`)
  writeln(tabId, `  ${CYAN}Vault:${RESET}       ${secrets?.secrets?.length ?? 0} secrets`)
  writeln(tabId, '')
}

registerGroup('session', {
  description: 'Manage agent sessions',
  commands: {
    list:   { description: 'List active sessions',      usage: 'latch session list',      run: sessionList },
    create: { description: 'Create a new session',      usage: 'latch session create',    run: sessionCreate },
  },
})

registerGroup('status', {
  description: 'Show app overview',
  commands: {
    default: { description: 'Show status dashboard',    usage: 'latch status',            run: sessionStatus },
  },
})
