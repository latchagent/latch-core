#!/usr/bin/env node
/**
 * @module latch-mcp-wrap
 * @description Wrapper script that resolves secret references before launching
 * an MCP server process. Written as standalone ESM so it runs under system
 * Node.js (not Electron).
 *
 * Environment variables consumed:
 *   LATCH_RESOLVE      — semicolon-delimited "ENV_VAR=secret:KEY" mappings
 *   LATCH_AUTHZ_URL    — base URL of the Latch authz server (e.g. http://127.0.0.1:54321)
 *   LATCH_AUTHZ_SECRET — bearer token for authenticating with the authz server
 *
 * Usage:
 *   node latch-mcp-wrap.mjs <command> [args...]
 *
 * The wrapper:
 *   1. Parses LATCH_RESOLVE to extract which env vars need secret resolution
 *   2. POSTs to LATCH_AUTHZ_URL/secrets/resolve with the secret keys
 *   3. Sets resolved values as env vars
 *   4. Spawns the real MCP server command with stdio inherited (critical for MCP protocol)
 *   5. Exits with the child's exit code
 */

import { spawn } from 'node:child_process'

const resolveSpec = process.env.LATCH_RESOLVE ?? ''
const authzUrl = process.env.LATCH_AUTHZ_URL ?? ''
const authzSecret = process.env.LATCH_AUTHZ_SECRET ?? ''

// The real command and args are everything after "latch-mcp-wrap.mjs"
const [command, ...args] = process.argv.slice(2)

if (!command) {
  console.error('latch-mcp-wrap: no command specified')
  process.exit(1)
}

/**
 * Resolve secrets from the authz server and return as a key-value map.
 */
async function resolveSecrets(mappings) {
  if (!mappings.length) return {}
  if (!authzUrl) {
    console.error('latch-mcp-wrap: LATCH_AUTHZ_URL not set, cannot resolve secrets')
    return {}
  }

  const keys = mappings.map((m) => m.secretKey)

  const res = await fetch(`${authzUrl}/secrets/resolve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authzSecret}`,
    },
    body: JSON.stringify({ keys }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error(`latch-mcp-wrap: secrets/resolve failed (${res.status}): ${text}`)
    return {}
  }

  const data = await res.json()
  return data.resolved ?? {}
}

async function main() {
  // Parse LATCH_RESOLVE: "ENV_VAR=secret:KEY;ENV_VAR2=secret:KEY2"
  const mappings = resolveSpec
    .split(';')
    .filter(Boolean)
    .map((entry) => {
      const eqIdx = entry.indexOf('=')
      if (eqIdx === -1) return null
      const envVar = entry.slice(0, eqIdx)
      const ref = entry.slice(eqIdx + 1)
      // ref should be "secret:KEY"
      const secretKey = ref.startsWith('secret:') ? ref.slice(7) : ref
      return { envVar, secretKey }
    })
    .filter(Boolean)

  // Resolve secrets
  const resolved = await resolveSecrets(mappings)

  // Build environment: start with current env, overlay resolved secrets,
  // remove Latch-internal vars so the child process doesn't see them
  const env = { ...process.env }
  for (const m of mappings) {
    if (resolved[m.secretKey]) {
      env[m.envVar] = resolved[m.secretKey]
    }
  }
  delete env.LATCH_RESOLVE
  delete env.LATCH_AUTHZ_URL
  delete env.LATCH_AUTHZ_SECRET

  // Spawn the real MCP server — stdio: 'inherit' is critical for MCP protocol
  const child = spawn(command, args, {
    stdio: 'inherit',
    env,
  })

  child.on('error', (err) => {
    console.error(`latch-mcp-wrap: failed to spawn "${command}": ${err.message}`)
    process.exit(1)
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
    } else {
      process.exit(code ?? 1)
    }
  })
}

main().catch((err) => {
  console.error(`latch-mcp-wrap: ${err.message}`)
  process.exit(1)
})
