/**
 * @module commands
 * @description Command registry for the Latch Terminal.
 * Maps `resource action` pairs to handler functions.
 */

import type { CommandRunner } from '../CommandRunner'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CommandHandler {
  description: string
  usage: string
  run: (runner: CommandRunner, args: string[]) => Promise<void>
}

export interface CommandGroup {
  description: string
  commands: Record<string, CommandHandler>
}

// ─── Registry ───────────────────────────────────────────────────────────────

const registry: Record<string, CommandGroup> = {}

/** Register a command group (e.g. 'policy', 'mcp'). */
export function registerGroup(name: string, group: CommandGroup): void {
  registry[name] = group
}

/** Get all registered groups. */
export function getGroups(): Record<string, CommandGroup> {
  return registry
}

/** Resolve a command from input tokens (e.g. ['latch', 'policy', 'create']). */
export function resolveCommand(tokens: string[]): { handler: CommandHandler; args: string[] } | null {
  // Support both "latch policy create" and "policy create"
  let start = 0
  if (tokens[0] === 'latch') start = 1

  const groupName = tokens[start]
  const actionName = tokens[start + 1]
  const args = tokens.slice(start + 2)

  if (!groupName) return null

  const group = registry[groupName]
  if (!group) return null

  // If no action specified, try 'default' or return null
  if (!actionName) {
    if (group.commands['default']) {
      return { handler: group.commands['default'], args }
    }
    return null
  }

  const handler = group.commands[actionName]
  if (!handler) return null

  return { handler, args }
}

/** Get completions for partial input. */
export function getCompletions(tokens: string[]): string[] {
  let start = 0
  if (tokens[0] === 'latch') start = 1

  const partial = tokens[start] ?? ''

  // No group yet — suggest group names
  if (tokens.length <= start + 1) {
    const groups = Object.keys(registry)
    if (!partial) return groups
    return groups.filter(g => g.startsWith(partial))
  }

  // Group entered — suggest actions
  const groupName = tokens[start]
  const group = registry[groupName]
  if (!group) return []

  const actionPartial = tokens[start + 1] ?? ''
  const actions = Object.keys(group.commands).filter(a => a !== 'default')
  if (!actionPartial) return actions
  return actions.filter(a => a.startsWith(actionPartial))
}
