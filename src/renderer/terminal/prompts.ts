/**
 * @module prompts
 * @description Promise-based interactive prompt primitives for the Latch Terminal.
 * Each function takes control of terminal input until the user completes the prompt,
 * then resolves with the collected value.
 *
 * All prompts work by registering an `inputHandler` on the CommandRunner, which
 * forwards raw xterm.js keystrokes to the prompt's internal handler.
 */

import {
  BOLD, DIM, RESET, GREEN, CYAN, YELLOW, RED,
  HIDE_CURSOR, SHOW_CURSOR, ERASE_LINE, CURSOR_UP,
  write, writeln,
} from './ansi'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SelectOption {
  label: string
  value: string
  description?: string
  disabled?: boolean
}

export interface MultiSelectOption {
  label: string
  value: string
  description?: string
  checked?: boolean
}

export interface CycleGridItem {
  key: string
  label: string
  description?: string
  initialState?: string
}

export interface TextPromptOpts {
  default?: string
  hint?: string
  mask?: boolean   // mask input with asterisks (for secrets)
}

/** Function signature that the CommandRunner provides to pipe keystrokes. */
export type InputHandler = (data: string) => void

/** Interface the prompts use to register/unregister input handlers. */
export interface PromptHost {
  setInputHandler: (handler: InputHandler | null) => void
  tabId: string
}

// ─── Escape sequence helper ─────────────────────────────────────────────────

function isEscapeStart(data: string): boolean {
  return data.charCodeAt(0) === 0x1b
}

function parseArrowKey(data: string): 'up' | 'down' | 'left' | 'right' | null {
  if (data.length >= 3 && data.charCodeAt(0) === 0x1b && data.charAt(1) === '[') {
    const code = data.charAt(2)
    if (code === 'A') return 'up'
    if (code === 'B') return 'down'
    if (code === 'C') return 'right'
    if (code === 'D') return 'left'
  }
  return null
}

// ─── Text input ─────────────────────────────────────────────────────────────

/** Prompt for a single line of text. */
export function promptText(host: PromptHost, label: string, opts: TextPromptOpts = {}): Promise<string> {
  return new Promise((resolve) => {
    const { tabId } = host
    let buffer = ''

    writeln(tabId, `  ${BOLD}${label}${RESET}`)
    if (opts.hint) writeln(tabId, `  ${DIM}${opts.hint}${RESET}`)

    if (opts.default) {
      write(tabId, `  ${GREEN}>${RESET} ${DIM}${opts.default}${RESET}\r  ${GREEN}>${RESET} `)
    } else {
      write(tabId, `  ${GREEN}>${RESET} `)
    }

    const handler: InputHandler = (data) => {
      // Enter — submit
      if (data === '\r') {
        const value = buffer || opts.default || ''
        writeln(tabId, '')
        host.setInputHandler(null)
        resolve(value)
        return
      }

      // Backspace
      if (data === '\x7f' || data === '\b') {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1)
          write(tabId, '\b \b')
        }
        return
      }

      // Ctrl+C — cancel with default
      if (data === '\x03') {
        writeln(tabId, '')
        host.setInputHandler(null)
        resolve(opts.default || '')
        return
      }

      // Ignore escape sequences
      if (isEscapeStart(data)) return

      // Printable character
      if (data >= ' ' && data <= '~') {
        buffer += data
        write(tabId, opts.mask ? '*' : data)
      }
    }

    host.setInputHandler(handler)
  })
}

// ─── Select (single) ───────────────────────────────────────────────────────

/** Prompt to select one option from a list. */
export function promptSelect(host: PromptHost, label: string, options: SelectOption[]): Promise<string> {
  return new Promise((resolve) => {
    const { tabId } = host
    const enabled = options.filter(o => !o.disabled)
    if (enabled.length === 0) { resolve(''); return }

    let index = 0
    let rendered = false

    writeln(tabId, `  ${BOLD}${label}${RESET}`)
    write(tabId, HIDE_CURSOR)
    renderOptions()

    function renderOptions() {
      // Erase previous lines on re-render
      if (rendered) {
        for (let i = 0; i < options.length; i++) {
          write(tabId, `${CURSOR_UP}${ERASE_LINE}`)
        }
      }
      rendered = true

      let enabledIdx = 0
      for (const opt of options) {
        if (opt.disabled) {
          writeln(tabId, `    ${DIM}${opt.label}${RESET}`)
        } else {
          const marker = enabledIdx === index ? `${GREEN}>${RESET}` : ' '
          const style = enabledIdx === index ? BOLD : ''
          const desc = enabledIdx === index && opt.description ? `  ${DIM}${opt.description}${RESET}` : ''
          writeln(tabId, `  ${marker} ${style}${opt.label}${RESET}${desc}`)
          enabledIdx++
        }
      }
    }

    const handler: InputHandler = (data) => {
      const arrow = parseArrowKey(data)

      if (arrow === 'up') {
        index = (index - 1 + enabled.length) % enabled.length
        renderOptions()
        return
      }

      if (arrow === 'down') {
        index = (index + 1) % enabled.length
        renderOptions()
        return
      }

      // Enter — submit
      if (data === '\r') {
        write(tabId, SHOW_CURSOR)
        writeln(tabId, '')
        host.setInputHandler(null)
        resolve(enabled[index].value)
        return
      }

      // Ctrl+C — cancel
      if (data === '\x03') {
        write(tabId, SHOW_CURSOR)
        writeln(tabId, '')
        host.setInputHandler(null)
        resolve('')
        return
      }
    }

    host.setInputHandler(handler)
  })
}

// ─── Multi-select (checkboxes) ──────────────────────────────────────────────

/** Prompt to select multiple options (toggle with space). */
export function promptMultiSelect(host: PromptHost, label: string, options: MultiSelectOption[]): Promise<string[]> {
  return new Promise((resolve) => {
    const { tabId } = host
    let index = 0
    let rendered = false
    const checked = new Set(options.filter(o => o.checked).map(o => o.value))

    writeln(tabId, `  ${BOLD}${label}${RESET}`)
    writeln(tabId, `  ${DIM}(space to toggle, enter to confirm)${RESET}`)
    write(tabId, HIDE_CURSOR)
    renderOptions()

    function renderOptions() {
      if (rendered) {
        for (let i = 0; i < options.length; i++) {
          write(tabId, `${CURSOR_UP}${ERASE_LINE}`)
        }
      }
      rendered = true

      for (let i = 0; i < options.length; i++) {
        const opt = options[i]
        const marker = i === index ? `${GREEN}>${RESET}` : ' '
        const box = checked.has(opt.value) ? `${GREEN}[x]${RESET}` : `${DIM}[ ]${RESET}`
        const style = i === index ? BOLD : ''
        writeln(tabId, `  ${marker} ${box} ${style}${opt.label}${RESET}`)
      }
    }

    const handler: InputHandler = (data) => {
      const arrow = parseArrowKey(data)

      if (arrow === 'up') {
        index = (index - 1 + options.length) % options.length
        renderOptions()
        return
      }

      if (arrow === 'down') {
        index = (index + 1) % options.length
        renderOptions()
        return
      }

      // Space — toggle
      if (data === ' ') {
        const val = options[index].value
        if (checked.has(val)) checked.delete(val)
        else checked.add(val)
        renderOptions()
        return
      }

      // Enter — submit
      if (data === '\r') {
        write(tabId, SHOW_CURSOR)
        writeln(tabId, '')
        host.setInputHandler(null)
        resolve(Array.from(checked))
        return
      }

      // Ctrl+C — submit current selection
      if (data === '\x03') {
        write(tabId, SHOW_CURSOR)
        writeln(tabId, '')
        host.setInputHandler(null)
        resolve(Array.from(checked))
        return
      }
    }

    host.setInputHandler(handler)
  })
}

// ─── Confirm (Y/n) ─────────────────────────────────────────────────────────

/** Prompt for a yes/no confirmation. */
export function promptConfirm(host: PromptHost, label: string, defaultYes = false): Promise<boolean> {
  return new Promise((resolve) => {
    const { tabId } = host
    const hint = defaultYes ? '(Y/n)' : '(y/N)'
    write(tabId, `  ${BOLD}${label}${RESET} ${DIM}${hint}${RESET} `)

    const handler: InputHandler = (data) => {
      const lower = data.toLowerCase()

      if (lower === 'y') {
        writeln(tabId, `${GREEN}y${RESET}`)
        host.setInputHandler(null)
        resolve(true)
        return
      }

      if (lower === 'n') {
        writeln(tabId, `${DIM}n${RESET}`)
        host.setInputHandler(null)
        resolve(false)
        return
      }

      if (data === '\r') {
        writeln(tabId, defaultYes ? `${GREEN}y${RESET}` : `${DIM}n${RESET}`)
        host.setInputHandler(null)
        resolve(defaultYes)
        return
      }

      // Ctrl+C — default
      if (data === '\x03') {
        writeln(tabId, '')
        host.setInputHandler(null)
        resolve(defaultYes)
        return
      }
    }

    host.setInputHandler(handler)
  })
}

// ─── Cycle grid (allow/prompt/deny for tools) ──────────────────────────────

const CYCLE_STATES = ['─', 'Allow', 'Prompt', 'Deny']
const CYCLE_COLORS: Record<string, string> = {
  '─':      DIM,
  'Allow':  GREEN,
  'Prompt': YELLOW,
  'Deny':   RED,
}

/**
 * Show a grid of items that can be cycled through states (e.g. Allow/Prompt/Deny).
 * Space cycles the current item, Enter confirms all.
 */
export function promptCycleGrid(
  host: PromptHost,
  label: string,
  items: CycleGridItem[],
): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    const { tabId } = host
    if (items.length === 0) { resolve(new Map()); return }

    let index = 0
    let rendered = false
    const states = new Map(items.map(item => [item.key, item.initialState ?? '─']))

    writeln(tabId, `  ${BOLD}${label}${RESET}`)
    writeln(tabId, `  ${DIM}(↑↓ navigate, space to cycle, a=allow all, d=deny all, p=prompt all, enter to confirm)${RESET}`)
    write(tabId, HIDE_CURSOR)
    renderGrid()

    function renderGrid() {
      const totalLines = items.length
      if (rendered) {
        for (let i = 0; i < totalLines; i++) {
          write(tabId, `${CURSOR_UP}${ERASE_LINE}`)
        }
      }
      rendered = true

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const state = states.get(item.key) ?? '─'
        const color = CYCLE_COLORS[state] ?? DIM
        const marker = i === index ? `${GREEN}>${RESET}` : ' '
        const stateStr = `${color}[${state.padEnd(6)}]${RESET}`
        const nameStr = i === index ? `${BOLD}${item.label}${RESET}` : item.label
        const desc = item.description ? `  ${DIM}${item.description}${RESET}` : ''
        writeln(tabId, `  ${marker} ${stateStr} ${nameStr}${i === index ? desc : ''}`)
      }
    }

    function cycleState(key: string) {
      const current = states.get(key) ?? '─'
      const idx = CYCLE_STATES.indexOf(current)
      states.set(key, CYCLE_STATES[(idx + 1) % CYCLE_STATES.length])
    }

    function setAll(state: string) {
      for (const item of items) states.set(item.key, state)
      renderGrid()
    }

    const handler: InputHandler = (data) => {
      const arrow = parseArrowKey(data)

      if (arrow === 'up') {
        index = (index - 1 + items.length) % items.length
        renderGrid()
        return
      }

      if (arrow === 'down') {
        index = (index + 1) % items.length
        renderGrid()
        return
      }

      // Space — cycle current item
      if (data === ' ') {
        cycleState(items[index].key)
        renderGrid()
        return
      }

      // Shortcuts
      if (data === 'a') { setAll('Allow'); return }
      if (data === 'd') { setAll('Deny'); return }
      if (data === 'p') { setAll('Prompt'); return }
      if (data === 'r') { setAll('─'); return }

      // Enter — confirm
      if (data === '\r') {
        write(tabId, SHOW_CURSOR)
        writeln(tabId, '')
        host.setInputHandler(null)
        // Filter out unset items
        const result = new Map<string, string>()
        for (const [key, state] of states) {
          if (state !== '─') result.set(key, state.toLowerCase())
        }
        resolve(result)
        return
      }

      // Ctrl+C — confirm current state
      if (data === '\x03') {
        write(tabId, SHOW_CURSOR)
        writeln(tabId, '')
        host.setInputHandler(null)
        const result = new Map<string, string>()
        for (const [key, state] of states) {
          if (state !== '─') result.set(key, state.toLowerCase())
        }
        resolve(result)
        return
      }
    }

    host.setInputHandler(handler)
  })
}
