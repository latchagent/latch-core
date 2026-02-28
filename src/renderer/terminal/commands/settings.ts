/**
 * @module commands/settings
 * @description Settings management commands for the Latch Terminal.
 */

import type { CommandRunner } from '../CommandRunner'
import { registerGroup } from './index'
import { BOLD, DIM, RESET, GREEN, RED, CYAN, writeln } from '../ansi'
import { promptText } from '../prompts'

const SENSITIVE_KEYS = new Set(['openai-api-key'])

async function settingsSet(runner: CommandRunner, args: string[]): Promise<void> {
  const { tabId } = runner
  let key = args[0]

  if (!key) {
    writeln(tabId, `  ${RED}Usage:${RESET} latch settings set <key>`)
    writeln(tabId, `  ${DIM}Available keys: openai-api-key, default-docker-image, sandbox-enabled${RESET}`)
    writeln(tabId, '')
    return
  }

  const isSensitive = SENSITIVE_KEYS.has(key)
  const value = await promptText(runner, `Value for ${CYAN}${key}${RESET}`, {
    mask: isSensitive,
    hint: isSensitive ? 'Input is hidden' : undefined,
  })

  if (!value) {
    writeln(tabId, `  ${DIM}Cancelled.${RESET}`)
    writeln(tabId, '')
    return
  }

  const result = await window.latch.setSetting({ key, value, sensitive: isSensitive })
  if (result?.ok) {
    writeln(tabId, `  ${GREEN}✓${RESET} Setting "${key}" saved.`)
  } else {
    writeln(tabId, `  ${RED}✗${RESET} ${result?.error ?? 'Failed to save'}`)
  }
  writeln(tabId, '')
}

async function settingsGet(runner: CommandRunner, args: string[]): Promise<void> {
  const { tabId } = runner
  const key = args[0]

  if (!key) {
    writeln(tabId, `  ${RED}Usage:${RESET} latch settings get <key>`)
    writeln(tabId, '')
    return
  }

  const result = await window.latch.hasSetting({ key })
  if (!result?.ok || !result.exists) {
    writeln(tabId, `  ${DIM}Not set:${RESET} ${key}`)
    writeln(tabId, '')
    return
  }

  if (SENSITIVE_KEYS.has(key)) {
    writeln(tabId, `  ${CYAN}${key}${RESET}: ${DIM}[set, encrypted]${RESET}`)
  } else {
    const getResult = await window.latch.getSetting({ key })
    writeln(tabId, `  ${CYAN}${key}${RESET}: ${getResult?.value ?? `${DIM}(empty)${RESET}`}`)
  }
  writeln(tabId, '')
}

registerGroup('settings', {
  description: 'Manage app settings',
  commands: {
    set: { description: 'Set a configuration value',   usage: 'latch settings set <key>',    run: settingsSet },
    get: { description: 'Get a configuration value',   usage: 'latch settings get <key>',    run: settingsGet },
  },
})
