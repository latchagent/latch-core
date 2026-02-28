/**
 * @module ansi
 * @description Shared ANSI escape code constants, table formatter, and spinner
 * for the Latch Terminal and TerminalWizard.
 */

import { terminalManager } from './TerminalManager'

// ─── Escape codes ──────────────────────────────────────────────────────────────

export const BOLD         = '\x1b[1m'
export const DIM          = '\x1b[2m'
export const ITALIC       = '\x1b[3m'
export const UNDERLINE    = '\x1b[4m'
export const RESET        = '\x1b[0m'

export const RED          = '\x1b[31m'
export const GREEN        = '\x1b[32m'
export const YELLOW       = '\x1b[33m'
export const BLUE         = '\x1b[34m'
export const MAGENTA      = '\x1b[35m'
export const CYAN         = '\x1b[36m'
export const WHITE        = '\x1b[37m'
export const GRAY         = '\x1b[90m'

export const BG_RED       = '\x1b[41m'
export const BG_GREEN     = '\x1b[42m'
export const BG_YELLOW    = '\x1b[43m'
export const BG_BLUE      = '\x1b[44m'
export const BG_CYAN      = '\x1b[46m'

export const HIDE_CURSOR  = '\x1b[?25l'
export const SHOW_CURSOR  = '\x1b[?25h'
export const ERASE_LINE   = '\x1b[2K\r'
export const CURSOR_UP    = '\x1b[A'

// ─── Table formatter ───────────────────────────────────────────────────────────

/**
 * Format data as a box-drawing table string.
 *
 * @param headers  Column header labels.
 * @param rows     Array of row arrays (one string per column).
 * @returns        Multi-line string with box-drawing characters.
 */
export function table(headers: string[], rows: string[][]): string {
  // Calculate column widths (max of header + all row values, +2 padding)
  const widths = headers.map((h, i) => {
    const maxRow = rows.reduce((max, row) => Math.max(max, stripAnsi(row[i] ?? '').length), 0)
    return Math.max(stripAnsi(h).length, maxRow) + 2
  })

  const pad = (text: string, width: number) => {
    const len = stripAnsi(text).length
    return ' ' + text + ' '.repeat(Math.max(0, width - len - 1))
  }

  const topBorder    = '┌' + widths.map(w => '─'.repeat(w)).join('┬') + '┐'
  const headerRow    = '│' + headers.map((h, i) => `${BOLD}${pad(h, widths[i])}${RESET}`).join('│') + '│'
  const separator    = '├' + widths.map(w => '─'.repeat(w)).join('┼') + '┤'
  const bottomBorder = '└' + widths.map(w => '─'.repeat(w)).join('┴') + '┘'

  const dataRows = rows.map(
    row => '│' + row.map((cell, i) => pad(cell ?? '', widths[i])).join('│') + '│'
  )

  return [topBorder, headerRow, separator, ...dataRows, bottomBorder].join('\r\n')
}

/** Strip ANSI escape codes for length measurement. */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

// ─── Spinner ───────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * Start an animated spinner on the terminal.
 *
 * @param tabId  Terminal tab to write to.
 * @param label  Text shown next to the spinner.
 * @returns      Object with `stop(finalText?)` to end the animation.
 */
export function spinner(tabId: string, label: string): { stop: (text?: string) => void } {
  let frame = 0
  let stopped = false

  const interval = setInterval(() => {
    if (stopped) return
    const char = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]
    terminalManager.write(tabId, `${ERASE_LINE}  ${CYAN}${char}${RESET} ${label}`)
    frame++
  }, 80)

  return {
    stop(text?: string) {
      if (stopped) return
      stopped = true
      clearInterval(interval)
      if (text) {
        terminalManager.write(tabId, `${ERASE_LINE}  ${text}\r\n`)
      } else {
        terminalManager.write(tabId, `${ERASE_LINE}`)
      }
    },
  }
}

// ─── Write helpers ─────────────────────────────────────────────────────────────

/** Write raw data to a terminal tab. */
export function write(tabId: string, data: string): void {
  terminalManager.write(tabId, data)
}

/** Write a line (with \\r\\n) to a terminal tab. */
export function writeln(tabId: string, text: string): void {
  terminalManager.write(tabId, text + '\r\n')
}
