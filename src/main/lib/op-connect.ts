/**
 * @module op-connect
 * @description 1Password integration via the `op` CLI.
 *
 * Uses the `op` command-line tool bundled with 1Password 8+ to browse
 * vaults/items and resolve `op://` secret references. Authentication
 * happens automatically through the 1Password desktop app (biometric
 * prompt) — no SDK, no tokens, no developer mode needed.
 *
 * All functions are safe to call when `op` is not installed — they
 * return clean error messages.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { OpVault, OpItem } from '../../types'

const execFileAsync = promisify(execFile)

// ── State ────────────────────────────────────────────────────────────────────

let connected = false
let opPath: string | null = null

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Find the `op` CLI binary. Only caches positive results so re-checks after install. */
async function findOp(): Promise<string | null> {
  if (opPath) return opPath

  // Common locations
  const candidates = [
    '/usr/local/bin/op',
    '/opt/homebrew/bin/op',
    '/usr/bin/op',
  ]

  // Also try PATH lookup
  try {
    const { stdout } = await execFileAsync('which', ['op'], { timeout: 3000 })
    const found = stdout.trim()
    if (found) candidates.unshift(found)
  } catch { /* not in PATH */ }

  const fs = await import('node:fs')
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      opPath = p  // cache only on success — null is never cached
      return p
    }
  }
  return null
}

/** Run an `op` command with JSON output. */
async function opExec(args: string[]): Promise<{ ok: boolean; data: any; error?: string }> {
  const bin = await findOp()
  if (!bin) return { ok: false, data: null, error: '1Password CLI (op) not found. Is 1Password installed?' }

  try {
    const { stdout } = await execFileAsync(bin, [...args, '--format=json'], {
      timeout: 15000,
      env: { ...process.env },
    })
    return { ok: true, data: JSON.parse(stdout) }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    // op CLI prints errors to stderr which shows up in err.message
    if (msg.includes('not signed in') || msg.includes('sign in')) {
      connected = false
      return { ok: false, data: null, error: 'Not signed in to 1Password. Open the 1Password app and sign in.' }
    }
    if (msg.includes('biometric') || msg.includes('unlock')) {
      return { ok: false, data: null, error: 'Please unlock 1Password to continue.' }
    }
    return { ok: false, data: null, error: msg }
  }
}

/** Run `op read` to resolve a secret reference (returns raw string, not JSON). */
async function opRead(ref: string): Promise<{ ok: boolean; value: string | null; error?: string }> {
  const bin = await findOp()
  if (!bin) return { ok: false, value: null, error: '1Password CLI (op) not found' }

  try {
    const { stdout } = await execFileAsync(bin, ['read', ref], {
      timeout: 15000,
      env: { ...process.env },
    })
    return { ok: true, value: stdout.trimEnd() }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, value: null, error: msg }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Check if the `op` CLI is available and whether we've verified sign-in. */
export async function opStatus(): Promise<{ available: boolean; connected: boolean; appInstalled: boolean; cliInstalled: boolean }> {
  const appInstalled = isAppInstalled()
  const bin = await findOp()
  const cliInstalled = !!bin

  if (!bin) return { available: false, connected: false, appInstalled, cliInstalled }

  // If we haven't checked yet, do a quick whoami to see if signed in
  if (!connected) {
    try {
      await execFileAsync(bin, ['whoami', '--format=json'], { timeout: 5000, env: { ...process.env } })
      connected = true
    } catch {
      connected = false
    }
  }

  return { available: true, connected, appInstalled, cliInstalled }
}

/** Check if the 1Password desktop app is installed (separate from CLI). */
function isAppInstalled(): boolean {
  const fs = require('node:fs')
  if (process.platform === 'darwin') {
    return (
      fs.existsSync('/Applications/1Password.app') ||
      fs.existsSync((process.env.HOME ?? '') + '/Applications/1Password.app')
    )
  }
  if (process.platform === 'win32') {
    return fs.existsSync('C:\\Program Files\\1Password\\app\\8\\1Password.exe')
  }
  return false
}

/**
 * Connect to 1Password. Tries `op whoami` first; if not signed in,
 * runs `op signin` which triggers the desktop app's biometric prompt.
 */
export async function opConnect(): Promise<{ ok: boolean; error?: string }> {
  const bin = await findOp()
  if (!bin) return { ok: false, error: '1Password CLI (op) not found. Is 1Password installed?' }

  // First try whoami — succeeds if already signed in
  try {
    await execFileAsync(bin, ['whoami', '--format=json'], { timeout: 15000, env: { ...process.env } })
    connected = true
    return { ok: true }
  } catch { /* not signed in yet — try signin */ }

  // Run `op signin` to trigger desktop app auth (biometric prompt)
  try {
    await execFileAsync(bin, ['signin'], { timeout: 30000, env: { ...process.env } })
    // Verify it worked
    await execFileAsync(bin, ['whoami', '--format=json'], { timeout: 5000, env: { ...process.env } })
    connected = true
    return { ok: true }
  } catch (err: unknown) {
    connected = false
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('not signed in') || msg.includes('sign in')) {
      return { ok: false, error: 'Sign in failed. Make sure the 1Password desktop app is open and unlocked.' }
    }
    return { ok: false, error: msg }
  }
}

/** List vaults the signed-in user has access to. */
export async function opListVaults(): Promise<{ ok: boolean; vaults: OpVault[]; error?: string }> {
  const result = await opExec(['vault', 'list'])
  if (!result.ok) return { ok: false, vaults: [], error: result.error }

  const vaults: OpVault[] = (result.data as any[]).map(v => ({
    id: v.id,
    name: v.name,
  }))
  return { ok: true, vaults }
}

/** List items in a specific vault. */
export async function opListItems(vaultId: string): Promise<{ ok: boolean; items: OpItem[]; error?: string }> {
  const result = await opExec(['item', 'list', `--vault=${vaultId}`])
  if (!result.ok) return { ok: false, items: [], error: result.error }

  const items: OpItem[] = (result.data as any[]).map(i => ({
    id: i.id,
    title: i.title,
    category: i.category ?? 'Login',
    vaultId: i.vault?.id ?? vaultId,
  }))
  return { ok: true, items }
}

/** Get fields for a specific item (so the user can pick which field to reference). */
export async function opGetItemFields(itemId: string, vaultId: string): Promise<{ ok: boolean; fields: Array<{ id: string; label: string; type: string; sectionLabel?: string }>; error?: string }> {
  const result = await opExec(['item', 'get', itemId, `--vault=${vaultId}`])
  if (!result.ok) return { ok: false, fields: [], error: result.error }

  const fields: Array<{ id: string; label: string; type: string; sectionLabel?: string }> = []
  const rawFields = result.data?.fields as any[] ?? []
  for (const f of rawFields) {
    // Skip internal/metadata fields
    if (!f.label && !f.id) continue
    const label = f.label || f.id || ''
    // Skip "notesPlain" and other non-secret fields unless they have a value
    if (f.purpose === 'NOTES' && !f.value) continue
    fields.push({
      id: f.id ?? label,
      label,
      type: f.type ?? 'STRING',
      sectionLabel: f.section?.label,
    })
  }
  return { ok: true, fields }
}

/**
 * Resolve an `op://` secret reference to its decrypted value.
 * Returns null if not connected or the reference is invalid.
 */
export async function opResolve(ref: string): Promise<string | null> {
  const result = await opRead(ref)
  if (!result.ok) {
    console.error('[op-connect] resolve failed:', ref, result.error)
    return null
  }
  return result.value
}

/** Mark as disconnected (clears cached state). */
export function opDisconnect(): void {
  connected = false
}
