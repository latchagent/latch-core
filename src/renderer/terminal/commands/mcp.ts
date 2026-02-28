/**
 * @module commands/mcp
 * @description MCP server management commands for the Latch Terminal.
 */

import type { CommandRunner } from '../CommandRunner'
import { registerGroup } from './index'
import { BOLD, DIM, RESET, GREEN, RED, CYAN, table, spinner, writeln } from '../ansi'

async function mcpList(runner: CommandRunner): Promise<void> {
  const { tabId } = runner
  const s = spinner(tabId, 'Loading MCP servers...')
  const result = await window.latch.listMcpServers()
  s.stop()

  if (!result?.ok || !result.servers?.length) {
    writeln(tabId, `  ${DIM}No MCP servers configured.${RESET}`)
    writeln(tabId, '')
    return
  }

  const rows = result.servers.map((s: any) => [
    s.name,
    s.transport,
    s.tools?.length ? `${GREEN}${s.tools.length} tools${RESET}` : `${DIM}0 tools${RESET}`,
    s.enabled === false ? `${RED}disabled${RESET}` : `${GREEN}enabled${RESET}`,
  ])

  writeln(tabId, '')
  writeln(tabId, table(['Name', 'Transport', 'Tools', 'Status'], rows))
  writeln(tabId, '')
}

async function mcpDiscover(runner: CommandRunner, args: string[]): Promise<void> {
  const { tabId } = runner

  if (!args[0]) {
    writeln(tabId, `  ${RED}Usage:${RESET} latch mcp discover <server-id>`)
    writeln(tabId, `  ${DIM}Run 'latch mcp list' to see server IDs.${RESET}`)
    writeln(tabId, '')
    return
  }

  const serverId = args[0]
  const s = spinner(tabId, `Discovering tools for ${serverId}...`)

  const result = await window.latch.introspectMcpServer({ id: serverId })
  s.stop()

  if (!result?.ok) {
    writeln(tabId, `  ${RED}✗${RESET} Discovery failed: ${result?.error ?? 'Unknown error'}`)
    writeln(tabId, '')
    return
  }

  const tools = result.tools ?? []
  writeln(tabId, `  ${GREEN}✓${RESET} Discovered ${BOLD}${tools.length}${RESET} tools`)
  writeln(tabId, '')

  if (tools.length > 0) {
    const rows = tools.map((t: any) => [
      `${CYAN}${t.name}${RESET}`,
      t.description || `${DIM}—${RESET}`,
    ])

    writeln(tabId, table(['Tool', 'Description'], rows))
    writeln(tabId, '')
  }
}

registerGroup('mcp', {
  description: 'Manage MCP server configurations',
  commands: {
    list:     { description: 'List configured MCP servers',    usage: 'latch mcp list',               run: mcpList },
    discover: { description: 'Discover tools from a server',   usage: 'latch mcp discover <id>',      run: mcpDiscover },
  },
})
