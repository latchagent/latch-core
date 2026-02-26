import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const HARNESS_DEFINITIONS = [
  { id: 'claude',   label: 'Claude Code', dotDir: '.claude',   commands: ['claude', 'claude-code'], url: 'https://claude.ai/code' },
  { id: 'codex',    label: 'Codex',       dotDir: '.codex',    commands: ['codex'],                 url: 'https://openai.com/codex' },
  { id: 'openclaw', label: 'OpenClaw',    dotDir: '.openclaw', commands: ['openclaw'],              url: '' },
  { id: 'droid',    label: 'Droid',       dotDir: '.factory',  commands: ['droid'],                 url: 'https://droid.dev' },
  { id: 'opencode', label: 'OpenCode',    dotDir: '.opencode', commands: ['opencode'],              url: 'https://opencode.ai' },
]

async function pathExists(target: string): Promise<boolean> {
  try { await fs.access(target); return true } catch { return false }
}

async function which(cmd: string): Promise<string | null> {
  const bin = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(bin, [cmd])
    const first = stdout.split(/\r?\n/).find(Boolean)
    return first ? first.trim() : null
  } catch { return null }
}

async function detectHarness(definition: typeof HARNESS_DEFINITIONS[number], homeDir: string) {
  const dotDirPath = path.join(homeDir, definition.dotDir)
  const hasDotDir = await pathExists(dotDirPath)
  const commandChecks = await Promise.all(
    definition.commands.map(async (command) => {
      const resolved = await which(command)
      return resolved ? { command, path: resolved } : null
    })
  )
  const availableCommands = commandChecks.filter(Boolean) as { command: string; path: string }[]
  const installed = availableCommands.length > 0 || hasDotDir

  // Fall back to the first defined command name if dot dir exists but binary isn't in PATH
  let recommendedCommand = availableCommands[0]?.command ?? (hasDotDir ? definition.commands[0] : null)
  if (definition.id === 'openclaw' && recommendedCommand) {
    recommendedCommand = `${recommendedCommand} tui`
  }

  return {
    id: definition.id,
    label: definition.label,
    dotDir: definition.dotDir,
    dotDirPath,
    hasDotDir,
    availableCommands,
    recommendedCommand,
    installed,
    url: definition.url
  }
}

export async function detectAllHarnesses() {
  const homeDir = os.homedir()
  return Promise.all(HARNESS_DEFINITIONS.map((def) => detectHarness(def, homeDir)))
}

export { HARNESS_DEFINITIONS }
