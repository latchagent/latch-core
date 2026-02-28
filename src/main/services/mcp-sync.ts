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
 *
 * When a secretContext is provided, servers whose env vars contain ${secret:KEY}
 * references are rewritten to launch via latch-mcp-wrap, which resolves secrets
 * at runtime from the authz server.
 */

import { app } from 'electron'
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

export interface SecretContext {
  authzUrl: string
  authzSecret: string
}

const SECRET_REF_RE = /\$\{secret:([^}]+)\}/

/**
 * Dispatch MCP server configs to the correct harness writer.
 */
export async function syncMcpToHarness(
  servers: McpServerForSync[],
  harnessId: string,
  targetDir?: string | null,
  secretContext?: SecretContext | null
): Promise<{ ok: boolean; path?: string; error?: string }> {
  // Filter: only enabled servers that apply to this harness
  const applicable = servers.filter((s) => {
    if (!s.enabled) return false
    if (!s.harnesses || s.harnesses.length === 0) return true
    return s.harnesses.includes(harnessId)
  })

  switch (harnessId) {
    case 'claude':
      return syncClaude(applicable, targetDir, secretContext)
    case 'codex':
      return syncCodex(applicable, targetDir, secretContext)
    case 'cursor':
      return syncCursor(applicable, secretContext)
    case 'amp':
      return syncAmp(applicable, secretContext)
    case 'gemini':
      return syncGemini(applicable, secretContext)
    case 'kiro':
      return syncKiro(applicable, secretContext)
    case 'windsurf':
      return syncWindsurf(applicable, secretContext)
    case 'openclaw':
      return { ok: false, error: 'OpenClaw does not support static MCP config files.' }
    default:
      return { ok: false, error: `Unknown harness '${harnessId}'.` }
  }
}

// ── Secret wrapping helpers ──────────────────────────────────────────────────

/** Resolve the path to latch-mcp-wrap.mjs for both dev and packaged builds. */
function getLatchMcpWrapPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', 'latch-mcp-wrap.mjs')
  }
  return path.join(__dirname, '..', 'bin', 'latch-mcp-wrap.mjs')
}

/** Check whether any env value contains a ${secret:*} reference. */
function hasSecretRefs(env: Record<string, string> | undefined): boolean {
  if (!env) return false
  return Object.values(env).some((v) => SECRET_REF_RE.test(v))
}

/**
 * Build a wrapped MCP server entry for configs that use the standard JSON
 * mcpServers format. Servers with secret refs get rewritten to launch via
 * latch-mcp-wrap; servers without secret refs pass through unchanged.
 */
function buildWrappedMcpServersObject(
  servers: McpServerForSync[],
  secretContext: SecretContext | null | undefined
): Record<string, any> {
  const wrapPath = secretContext ? getLatchMcpWrapPath() : null
  const result: Record<string, any> = {}

  for (const s of servers) {
    if (s.transport === 'stdio') {
      if (secretContext && wrapPath && hasSecretRefs(s.env)) {
        result[s.name] = buildWrappedEntry(s, wrapPath, secretContext)
      } else {
        const entry: any = { command: s.command ?? '' }
        if (s.args?.length) entry.args = s.args
        if (s.env && Object.keys(s.env).length) entry.env = stripSecretRefs(s.env)
        result[s.name] = entry
      }
    } else if (s.transport === 'http') {
      const entry: any = { url: s.url ?? '' }
      if (s.headers && Object.keys(s.headers).length) entry.headers = s.headers
      result[s.name] = entry
    }
  }
  return result
}

/** Build a single wrapped stdio entry for latch-mcp-wrap. */
function buildWrappedEntry(
  server: McpServerForSync,
  wrapPath: string,
  ctx: SecretContext
): Record<string, any> {
  // Build LATCH_RESOLVE mappings: "ENV_VAR=secret:KEY;ENV_VAR2=secret:KEY2"
  const resolveParts: string[] = []
  const passEnv: Record<string, string> = {}

  for (const [key, value] of Object.entries(server.env ?? {})) {
    const match = value.match(/^\$\{secret:([^}]+)\}$/)
    if (match) {
      // Entire value is a secret ref — resolve at runtime
      resolveParts.push(`${key}=secret:${match[1]}`)
    } else if (SECRET_REF_RE.test(value)) {
      // Value contains a secret ref mixed with other text — resolve at runtime
      // Extract all secret keys from the value
      const refs = [...value.matchAll(/\$\{secret:([^}]+)\}/g)]
      for (const ref of refs) {
        resolveParts.push(`${key}=secret:${ref[1]}`)
      }
    } else {
      // Plain env var — pass through
      passEnv[key] = value
    }
  }

  const args = [wrapPath, server.command ?? '', ...(server.args ?? [])]
  const env: Record<string, string> = {
    ...passEnv,
    LATCH_RESOLVE: resolveParts.join(';'),
    LATCH_AUTHZ_URL: ctx.authzUrl,
    LATCH_AUTHZ_SECRET: ctx.authzSecret,
  }

  return { command: 'node', args, env }
}

/** Remove ${secret:*} values from env so they don't leak into config files. */
function stripSecretRefs(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!SECRET_REF_RE.test(value)) {
      result[key] = value
    }
    // Secret refs are omitted — they would be meaningless without the wrapper
  }
  return result
}

// ── Standard JSON builder (no wrapping) ──────────────────────────────────────

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
  targetDir?: string | null,
  secretContext?: SecretContext | null
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const dir = targetDir || process.cwd()
  const filePath = path.join(dir, '.mcp.json')
  const mcpServers = secretContext
    ? buildWrappedMcpServersObject(servers, secretContext)
    : buildMcpServersObject(servers)
  return writeJsonConfig(filePath, 'mcpServers', mcpServers)
}

async function syncCodex(
  servers: McpServerForSync[],
  targetDir?: string | null,
  secretContext?: SecretContext | null
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

  const wrapPath = secretContext ? getLatchMcpWrapPath() : null

  // Build TOML sections
  const sections: string[] = [MARKER_START]
  for (const s of servers) {
    if (s.transport === 'stdio') {
      const useWrap = secretContext && wrapPath && hasSecretRefs(s.env)

      if (useWrap) {
        // Wrapped entry: command is 'node', args start with wrap path
        const wrappedArgs = [wrapPath, s.command ?? '', ...(s.args ?? [])]
        sections.push(`[mcp_servers.${s.name}]`)
        sections.push(`command = "node"`)
        sections.push(`args = [${wrappedArgs.map(a => `"${a}"`).join(', ')}]`)

        // Build env with LATCH_RESOLVE + pass-through vars
        const resolveParts: string[] = []
        const passEnv: Record<string, string> = {}
        for (const [key, value] of Object.entries(s.env ?? {})) {
          const match = value.match(/^\$\{secret:([^}]+)\}$/)
          if (match) {
            resolveParts.push(`${key}=secret:${match[1]}`)
          } else if (SECRET_REF_RE.test(value)) {
            const refs = [...value.matchAll(/\$\{secret:([^}]+)\}/g)]
            for (const ref of refs) {
              resolveParts.push(`${key}=secret:${ref[1]}`)
            }
          } else {
            passEnv[key] = value
          }
        }

        sections.push('')
        sections.push(`[mcp_servers.${s.name}.env]`)
        for (const [k, v] of Object.entries(passEnv)) {
          sections.push(`${k} = "${v}"`)
        }
        sections.push(`LATCH_RESOLVE = "${resolveParts.join(';')}"`)
        sections.push(`LATCH_AUTHZ_URL = "${secretContext!.authzUrl}"`)
        sections.push(`LATCH_AUTHZ_SECRET = "${secretContext!.authzSecret}"`)
        sections.push('')
      } else {
        // Standard entry
        sections.push(`[mcp_servers.${s.name}]`)
        sections.push(`command = "${s.command ?? ''}"`)
        if (s.args?.length) {
          sections.push(`args = [${s.args.map(a => `"${a}"`).join(', ')}]`)
        }
        if (s.env && Object.keys(s.env).length) {
          sections.push('')
          sections.push(`[mcp_servers.${s.name}.env]`)
          for (const [k, v] of Object.entries(s.env)) {
            if (!SECRET_REF_RE.test(v)) {
              sections.push(`${k} = "${v}"`)
            }
          }
        }
        sections.push('')
      }
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

async function syncCursor(servers: McpServerForSync[], secretContext?: SecretContext | null) {
  const filePath = path.join(os.homedir(), '.cursor', 'mcp.json')
  const mcpServers = secretContext
    ? buildWrappedMcpServersObject(servers, secretContext)
    : buildMcpServersObject(servers)
  return writeJsonConfig(filePath, 'mcpServers', mcpServers)
}

async function syncAmp(servers: McpServerForSync[], secretContext?: SecretContext | null) {
  const filePath = path.join(os.homedir(), '.config', 'amp', 'settings.json')
  const mcpServers = secretContext
    ? buildWrappedMcpServersObject(servers, secretContext)
    : buildMcpServersObject(servers)
  return writeJsonConfig(filePath, 'amp.mcpServers', mcpServers)
}

async function syncGemini(servers: McpServerForSync[], secretContext?: SecretContext | null) {
  const filePath = path.join(os.homedir(), '.gemini', 'settings.json')

  if (secretContext) {
    // Use wrapped builder but override HTTP transport to use httpUrl
    const wrapPath = getLatchMcpWrapPath()
    const mcpServers: Record<string, any> = {}
    for (const s of servers) {
      if (s.transport === 'stdio') {
        if (hasSecretRefs(s.env)) {
          mcpServers[s.name] = buildWrappedEntry(s, wrapPath, secretContext)
        } else {
          const entry: any = { command: s.command ?? '' }
          if (s.args?.length) entry.args = s.args
          if (s.env && Object.keys(s.env).length) entry.env = stripSecretRefs(s.env)
          mcpServers[s.name] = entry
        }
      } else if (s.transport === 'http') {
        const entry: any = { httpUrl: s.url ?? '' }
        if (s.headers && Object.keys(s.headers).length) entry.headers = s.headers
        mcpServers[s.name] = entry
      }
    }
    return writeJsonConfig(filePath, 'mcpServers', mcpServers)
  }

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

async function syncKiro(servers: McpServerForSync[], secretContext?: SecretContext | null) {
  const filePath = path.join(os.homedir(), '.kiro', 'settings', 'mcp.json')
  const mcpServers = secretContext
    ? buildWrappedMcpServersObject(servers, secretContext)
    : buildMcpServersObject(servers)
  return writeJsonConfig(filePath, 'mcpServers', mcpServers)
}

async function syncWindsurf(servers: McpServerForSync[], secretContext?: SecretContext | null) {
  const filePath = path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json')
  const mcpServers = secretContext
    ? buildWrappedMcpServersObject(servers, secretContext)
    : buildMcpServersObject(servers)
  return writeJsonConfig(filePath, 'mcpServers', mcpServers)
}
