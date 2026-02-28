/**
 * @module commands/vault
 * @description Secrets vault management commands for the Latch Terminal.
 */

import type { CommandRunner } from '../CommandRunner'
import { registerGroup } from './index'
import { BOLD, DIM, RESET, GREEN, RED, CYAN, table, spinner, writeln } from '../ansi'
import { promptText, promptConfirm } from '../prompts'

async function vaultList(runner: CommandRunner): Promise<void> {
  const { tabId } = runner
  const s = spinner(tabId, 'Loading secrets...')
  const result = await window.latch.listSecrets()
  s.stop()

  if (!result?.ok || !result.secrets?.length) {
    writeln(tabId, `  ${DIM}No secrets stored. Add one with:${RESET} ${GREEN}latch vault add${RESET}`)
    writeln(tabId, '')
    return
  }

  const rows = result.secrets.map((s: any) => [
    s.name,
    `${CYAN}${s.key}${RESET}`,
    s.scope || `${DIM}global${RESET}`,
  ])

  writeln(tabId, '')
  writeln(tabId, table(['Name', 'Key', 'Scope'], rows))
  writeln(tabId, `  ${DIM}Reference in MCP env: \${secret:KEY_NAME}${RESET}`)
  writeln(tabId, '')
}

async function vaultAdd(runner: CommandRunner): Promise<void> {
  const { tabId } = runner

  writeln(tabId, '')
  const name = await promptText(runner, 'Secret name', { hint: 'e.g. GitHub Token' })
  if (!name) { writeln(tabId, `  ${DIM}Cancelled.${RESET}`); writeln(tabId, ''); return }

  const key = await promptText(runner, 'Environment variable key', { hint: 'e.g. GITHUB_TOKEN (uppercase, underscores)' })
  if (!key) { writeln(tabId, `  ${DIM}Cancelled.${RESET}`); writeln(tabId, ''); return }

  const value = await promptText(runner, 'Secret value', { mask: true })
  if (!value) { writeln(tabId, `  ${DIM}Cancelled.${RESET}`); writeln(tabId, ''); return }

  const s = spinner(tabId, 'Saving secret...')
  const result = await window.latch.saveSecret({
    id: `secret-${Date.now()}`,
    name,
    key: key.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
    value,
  })
  s.stop()

  if (result?.ok) {
    writeln(tabId, `  ${GREEN}✓${RESET} Secret "${name}" saved.`)
  } else {
    writeln(tabId, `  ${RED}✗${RESET} ${result?.error ?? 'Failed to save'}`)
  }
  writeln(tabId, '')
}

async function vaultDelete(runner: CommandRunner, args: string[]): Promise<void> {
  const { tabId } = runner
  const id = args[0]

  if (!id) {
    writeln(tabId, `  ${RED}Usage:${RESET} latch vault delete <secret-id>`)
    writeln(tabId, '')
    return
  }

  const confirm = await promptConfirm(runner, `Delete secret "${id}"?`)
  if (!confirm) {
    writeln(tabId, `  ${DIM}Cancelled.${RESET}`)
    writeln(tabId, '')
    return
  }

  const result = await window.latch.deleteSecret({ id })
  if (result?.ok) {
    writeln(tabId, `  ${GREEN}✓${RESET} Secret deleted.`)
  } else {
    writeln(tabId, `  ${RED}✗${RESET} ${result?.error ?? 'Failed to delete'}`)
  }
  writeln(tabId, '')
}

registerGroup('vault', {
  description: 'Manage the secrets vault',
  commands: {
    list:   { description: 'List stored secrets',         usage: 'latch vault list',          run: vaultList },
    add:    { description: 'Add a new secret',            usage: 'latch vault add',           run: vaultAdd },
    delete: { description: 'Delete a secret',             usage: 'latch vault delete <id>',   run: vaultDelete },
  },
})
