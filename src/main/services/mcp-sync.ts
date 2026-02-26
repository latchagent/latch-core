/**
 * @module mcp-sync
 * @description Writes MCP server configs to the correct harness config file format.
 *
 * Each harness has its own config file format:
 * - Claude Code: <projectDir>/.mcp.json
 * - Codex: <projectDir>/.codex/config.toml (appended [mcp_servers.*] sections)
 * - Cursor: ~/.cursor/mcp.json
 * - Amp: ~/.config/amp/settings.json
 * - Gemini: ~/.gemini/settings.json
 * - Kiro: ~/.kiro/settings/mcp.json
 * - Windsurf: ~/.codeium/windsurf/mcp_config.json
 * - OpenClaw: no static MCP config (skip with warning)
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface McpServerForSync {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  harnesses: string[] | null
  enabled: boolean
}

/**
 * Dispatch MCP server configs to the correct harness writer.
 */
export async function syncMcpToHarness(
  servers: McpServerForSync[],
  harnessId: string,
  targetDir?: string | null
): Promise<{ ok: boolean; path?: string; error?: string }> {
  // Filter: only enabled servers that apply to this harness
  const applicable = servers.filter((s) => {
    if (!s.enabled) return false
    if (!s.harnesses || s.harnesses.length === 0) return true
    return s.harnesses.includes(harnessId)
  })

  switch (harnessId) {
    case 'claude':
      return syncClaude(applicable, targetDir)
    case 'codex':
      return syncCodex(applicable, targetDir)
    case 'cursor':
      return syncCursor(applicable)
    case 'amp':
      return syncAmp(applicable)
    case 'gemini':
      return syncGemini(applicable)
    case 'kiro':
      return syncKiro(applicable)
    case 'windsurf':
      return syncWindsurf(applicable)
    case 'openclaw':
      return { ok: false, error: 'OpenClaw does not support static MCP config files.' }
    default:
      return { ok: false, error: `Unknown harness '${harnessId}'.` }
  }
}

/**
 * Build the standard mcpServers JSON object used by most harnesses.
 */
function buildMcpServersObject(servers: McpServerForSync[]): Record<string, any> {
  const result: Record<string, any> = {}
  for (const s of servers) {
    if (s.transport === 'stdio') {
      const entry: any = { command: s.command ?? '' }
      if (s.args?.length) entry.args = s.args
      if (s.env && Object.keys(s.env).length) entry.env = s.env
      result[s.name] = entry
    } else if (s.transport === 'http') {
      const entry: any = { url: s.url ?? '' }
      if (s.headers && Object.keys(s.headers).length) entry.headers = s.headers
      result[s.name] = entry
    }
  }
  return result
}

/**
 * Write or merge a JSON file, preserving existing non-MCP keys.
 */
async function writeJsonConfig(
  filePath: string,
  mcpKey: string,
  mcpServers: Record<string, any>
): Promise<{ ok: boolean; path: string }> {
  let existing: Record<string, any> = {}
  try {
    const content = await fs.readFile(filePath, 'utf8')
    existing = JSON.parse(content)
  } catch { /* file doesn't exist or invalid JSON — start fresh */ }

  existing[mcpKey] = mcpServers

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf8')
  return { ok: true, path: filePath }
}

// ── Per-harness writers ────────────────────────────────────────────────────────

async function syncClaude(
  servers: McpServerForSync[],
  targetDir?: string | null
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const dir = targetDir || process.cwd()
  const filePath = path.join(dir, '.mcp.json')
  const mcpServers = buildMcpServersObject(servers)
  return writeJsonConfig(filePath, 'mcpServers', mcpServers)
}

async function syncCodex(
  servers: McpServerForSync[],
  targetDir?: string | null
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const dir = targetDir || process.cwd()
  const filePath = path.join(dir, '.codex', 'config.toml')

  let existing = ''
  try { existing = await fs.readFile(filePath, 'utf8') } catch { /* doesn't exist */ }

  // Remove existing [mcp_servers.*] sections between markers
  const MARKER_START = '# latch:mcp:start'
  const MARKER_END = '# latch:mcp:end'

  const startIdx = existing.indexOf(MARKER_START)
  const endIdx = existing.indexOf(MARKER_END)
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    existing = existing.slice(0, startIdx) + existing.slice(endIdx + MARKER_END.length)
  }

  // Build TOML sections
  const sections: string[] = [MARKER_START]
  for (const s of servers) {
    if (s.transport === 'stdio') {
      sections.push(`[mcp_servers.${s.name}]`)
      sections.push(`command = "${s.command ?? ''}"`)
      if (s.args?.length) {
        sections.push(`args = [${s.args.map(a => `"${a}"`).join(', ')}]`)
      }
      if (s.env && Object.keys(s.env).length) {
        sections.push('')
        sections.push(`[mcp_servers.${s.name}.env]`)
        for (const [k, v] of Object.entries(s.env)) {
          sections.push(`${k} = "${v}"`)
        }
      }
      sections.push('')
    }
  }
  sections.push(MARKER_END)

  const mcpBlock = sections.join('\n')
  const separator = existing.length && !existing.endsWith('\n\n') ? '\n\n' : ''
  const content = `${existing.trimEnd()}${separator}${mcpBlock}\n`

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf8')
  return { ok: true, path: filePath }
}

async function syncCursor(servers: McpServerForSync[]) {
  const filePath = path.join(os.homedir(), '.cursor', 'mcp.json')
  const mcpServers = buildMcpServersObject(servers)
  return writeJsonConfig(filePath, 'mcpServers', mcpServers)
}

async function syncAmp(servers: McpServerForSync[]) {
  const filePath = path.join(os.homedir(), '.config', 'amp', 'settings.json')
  const mcpServers = buildMcpServersObject(servers)
  return writeJsonConfig(filePath, 'amp.mcpServers', mcpServers)
}

async function syncGemini(servers: McpServerForSync[]) {
  const filePath = path.join(os.homedir(), '.gemini', 'settings.json')
  // Gemini uses httpUrl for HTTP transport instead of url
  const mcpServers: Record<string, any> = {}
  for (const s of servers) {
    if (s.transport === 'stdio') {
      const entry: any = { command: s.command ?? '' }
      if (s.args?.length) entry.args = s.args
      if (s.env && Object.keys(s.env).length) entry.env = s.env
      mcpServers[s.name] = entry
    } else if (s.transport === 'http') {
      const entry: any = { httpUrl: s.url ?? '' }
      if (s.headers && Object.keys(s.headers).length) entry.headers = s.headers
      mcpServers[s.name] = entry
    }
  }
  return writeJsonConfig(filePath, 'mcpServers', mcpServers)
}

async function syncKiro(servers: McpServerForSync[]) {
  const filePath = path.join(os.homedir(), '.kiro', 'settings', 'mcp.json')
  const mcpServers = buildMcpServersObject(servers)
  return writeJsonConfig(filePath, 'mcpServers', mcpServers)
}

async function syncWindsurf(servers: McpServerForSync[]) {
  const filePath = path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json')
  const mcpServers = buildMcpServersObject(servers)
  return writeJsonConfig(filePath, 'mcpServers', mcpServers)
}
