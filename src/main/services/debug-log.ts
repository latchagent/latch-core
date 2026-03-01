/**
 * @module debug-log
 * @description File-based debug logger for the main process.
 *
 * Writes timestamped log entries to `<userData>/debug_logs/`. Each app session
 * creates a new log file named `latch-<ISO-date>.log`. Old logs are pruned
 * on startup (keeps the last 10 files).
 *
 * The logger also patches `console.warn` and `console.error` to mirror output
 * to the log file so all existing logging is captured automatically.
 *
 * Log files are gitignored and never leave the user's machine.
 */

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const MAX_LOG_FILES = 10

let logStream: fs.WriteStream | null = null
let logDir: string | null = null

/**
 * Initialise the debug logger. Call once during app startup.
 * Creates the log directory and opens a write stream for this session.
 */
export function initDebugLog(): void {
  try {
    logDir = path.join(app.getPath('userData'), 'debug_logs')
    fs.mkdirSync(logDir, { recursive: true })

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const logPath = path.join(logDir, `latch-${timestamp}.log`)
    logStream = fs.createWriteStream(logPath, { flags: 'a' })

    // Write session header
    logStream.write(`=== Latch Desktop — ${new Date().toISOString()} ===\n`)
    logStream.write(`Platform: ${process.platform} ${process.arch}\n`)
    logStream.write(`Electron: ${process.versions.electron}\n`)
    logStream.write(`Node: ${process.versions.node}\n\n`)

    // Patch console.warn and console.error to mirror to file
    const originalWarn = console.warn
    const originalError = console.error

    console.warn = (...args: unknown[]) => {
      originalWarn(...args)
      writeLog('WARN', args)
    }

    console.error = (...args: unknown[]) => {
      originalError(...args)
      writeLog('ERROR', args)
    }

    // Prune old log files
    pruneOldLogs()
  } catch (err: unknown) {
    console.error('[debug-log] Failed to initialise:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Write a structured log entry.
 */
export function debugLog(level: 'INFO' | 'WARN' | 'ERROR', message: string, data?: unknown): void {
  if (!logStream) return
  const ts = new Date().toISOString()
  let line = `[${ts}] ${level}: ${message}`
  if (data !== undefined) {
    try {
      line += ` ${JSON.stringify(data)}`
    } catch {
      line += ' [unserializable data]'
    }
  }
  logStream.write(line + '\n')
}

/** Internal: format console args and write to log stream. */
function writeLog(level: string, args: unknown[]): void {
  if (!logStream) return
  const ts = new Date().toISOString()
  const parts = args.map(a => {
    if (typeof a === 'string') return a
    try { return JSON.stringify(a) } catch { return String(a) }
  })
  logStream.write(`[${ts}] ${level}: ${parts.join(' ')}\n`)
}

/** Remove old log files, keeping only the most recent MAX_LOG_FILES. */
function pruneOldLogs(): void {
  if (!logDir) return
  try {
    const files = fs.readdirSync(logDir)
      .filter(f => f.startsWith('latch-') && f.endsWith('.log'))
      .sort()
    const toRemove = files.slice(0, Math.max(0, files.length - MAX_LOG_FILES))
    for (const file of toRemove) {
      fs.unlinkSync(path.join(logDir!, file))
    }
  } catch { /* best-effort cleanup */ }
}

/** Flush and close the log stream. Call on app quit. */
export function closeDebugLog(): void {
  if (logStream) {
    logStream.write(`\n=== Session ended — ${new Date().toISOString()} ===\n`)
    logStream.end()
    logStream = null
  }
}
