/**
 * @module mcp-introspect
 * @description Spawns an MCP server, performs the JSON-RPC handshake, calls
 * `tools/list`, and returns the discovered tools with descriptions.
 *
 * MCP uses Content-Length header framing (like LSP):
 *   Content-Length: 123\r\n
 *   \r\n
 *   {"jsonrpc":"2.0","id":1,...}
 */

import { spawn } from 'child_process'
import type { McpServerRecord, McpToolInfo } from '../../types'
import type { SecretStore } from '../stores/secret-store'
import { resolveEnvSecrets } from './secret-resolver'

const TIMEOUT_MS = 10_000

interface IntrospectResult {
  ok: boolean
  tools?: McpToolInfo[]
  error?: string
}

/** Encode a JSON-RPC message with Content-Length header framing. */
function encodeMessage(obj: object): string {
  const body = JSON.stringify(obj)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

/** Parse Content-Length framed messages from a buffer. Returns parsed objects and remaining buffer. */
function parseMessages(buffer: string): { messages: any[]; remaining: string } {
  const messages: any[] = []
  let remaining = buffer

  while (true) {
    const headerEnd = remaining.indexOf('\r\n\r\n')
    if (headerEnd === -1) break

    const headerSection = remaining.slice(0, headerEnd)
    const match = headerSection.match(/Content-Length:\s*(\d+)/i)
    if (!match) break

    const contentLength = parseInt(match[1], 10)
    const bodyStart = headerEnd + 4
    const bodyEnd = bodyStart + contentLength

    if (remaining.length < bodyEnd) break // incomplete message

    const body = remaining.slice(bodyStart, bodyEnd)
    try {
      messages.push(JSON.parse(body))
    } catch {
      // skip malformed JSON
    }
    remaining = remaining.slice(bodyEnd)
  }

  return { messages, remaining }
}

/** Discover tools from a stdio-transport MCP server. */
async function introspectStdio(
  server: McpServerRecord,
  secretStore: SecretStore | null,
): Promise<IntrospectResult> {
  if (!server.command) {
    return { ok: false, error: 'No command configured for stdio server.' }
  }

  const env: Record<string, string> = { ...process.env as Record<string, string> }
  if (server.env) {
    const resolved = secretStore ? resolveEnvSecrets(server.env, secretStore) : server.env
    Object.assign(env, resolved)
  }

  return new Promise<IntrospectResult>((resolve) => {
    const args = server.args ?? []
    const child = spawn(server.command!, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let buffer = ''
    let settled = false
    let nextId = 1

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGTERM')
        resolve({ ok: false, error: 'Discovery timed out after 10 seconds.' })
      }
    }, TIMEOUT_MS)

    const finish = (result: IntrospectResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGTERM')
      resolve(result)
    }

    child.on('error', (err) => {
      finish({ ok: false, error: `Failed to spawn: ${err.message}` })
    })

    child.on('exit', (code) => {
      if (!settled) {
        finish({ ok: false, error: `Server exited with code ${code} before discovery completed.` })
      }
    })

    // Track protocol state
    let phase: 'init' | 'tools' = 'init'

    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const { messages, remaining } = parseMessages(buffer)
      buffer = remaining

      for (const msg of messages) {
        if (phase === 'init' && msg.id === 1) {
          // Got initialize response — send initialized notification + tools/list
          phase = 'tools'
          const initialized = encodeMessage({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
          })
          const toolsList = encodeMessage({
            jsonrpc: '2.0',
            id: ++nextId,
            method: 'tools/list',
          })
          child.stdin!.write(initialized)
          child.stdin!.write(toolsList)
        } else if (phase === 'tools' && msg.id === 2) {
          // Got tools/list response
          const rawTools = msg.result?.tools ?? []
          const tools: McpToolInfo[] = rawTools.map((t: any) => ({
            name: typeof t.name === 'string' ? t.name : '',
            description: typeof t.description === 'string' ? t.description : '',
          })).filter((t: McpToolInfo) => t.name)
          finish({ ok: true, tools })
        }
      }
    })

    child.stderr!.on('data', () => {
      // Ignore stderr — many MCP servers log here
    })

    // Send initialize request
    const initMsg = encodeMessage({
      jsonrpc: '2.0',
      id: nextId,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'latch-desktop', version: '1.0.0' },
      },
    })
    child.stdin!.write(initMsg)
  })
}

/** Discover tools from an HTTP-transport MCP server. */
async function introspectHttp(
  server: McpServerRecord,
  secretStore: SecretStore | null,
): Promise<IntrospectResult> {
  if (!server.url) {
    return { ok: false, error: 'No URL configured for HTTP server.' }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...server.headers,
  }

  // Resolve secret refs in headers
  if (secretStore) {
    for (const [k, v] of Object.entries(headers)) {
      headers[k] = resolveEnvSecrets({ v }, secretStore).v
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    // 1. Initialize
    const initRes = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'latch-desktop', version: '1.0.0' },
        },
      }),
      signal: controller.signal,
    })
    if (!initRes.ok) {
      return { ok: false, error: `Initialize failed: HTTP ${initRes.status}` }
    }

    // 2. Initialized notification
    await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
      signal: controller.signal,
    })

    // 3. tools/list
    const toolsRes = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      }),
      signal: controller.signal,
    })
    if (!toolsRes.ok) {
      return { ok: false, error: `tools/list failed: HTTP ${toolsRes.status}` }
    }

    const body = await toolsRes.json() as any
    const rawTools = body.result?.tools ?? []
    const tools: McpToolInfo[] = rawTools
      .map((t: any) => ({
        name: typeof t.name === 'string' ? t.name : '',
        description: typeof t.description === 'string' ? t.description : '',
      }))
      .filter((t: McpToolInfo) => t.name)

    return { ok: true, tools }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return { ok: false, error: 'Discovery timed out after 10 seconds.' }
    }
    return { ok: false, error: `HTTP discovery failed: ${err.message}` }
  } finally {
    clearTimeout(timer)
  }
}

/** Discover tools from an MCP server by performing the protocol handshake. */
export async function introspectMcpServer(
  server: McpServerRecord,
  secretStore: SecretStore | null,
): Promise<IntrospectResult> {
  if (server.transport === 'http') {
    return introspectHttp(server, secretStore)
  }
  return introspectStdio(server, secretStore)
}
