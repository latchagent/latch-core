/**
 * @module CommandRunner
 * @description The Latch Terminal command interpreter. Manages the interactive
 * shell lifecycle: banner, prompt, line editing, command history, tab completion,
 * and command dispatch.
 *
 * Runs inside an xterm.js instance without a real PTY. All I/O goes through
 * TerminalManager's write() and the onData callback.
 */

import { BOLD, DIM, RESET, GREEN, CYAN, RED, ERASE_LINE, write, writeln } from './ansi'
import { resolveCommand, getCompletions, getGroups } from './commands/index'
import type { InputHandler, PromptHost } from './prompts'

// ─── Constants ──────────────────────────────────────────────────────────────

const PROMPT = `  ${GREEN}$${RESET} `
const PROMPT_LEN = 4  // visible chars: "  $ "

// ─── CommandRunner ──────────────────────────────────────────────────────────

export class CommandRunner implements PromptHost {
  tabId: string

  private inputBuffer = ''
  private cursorPos = 0
  private history: string[] = []
  private historyIndex = -1
  private historySnapshot = ''

  /** When set, keystrokes route to this handler instead of the line editor. */
  private _inputHandler: InputHandler | null = null

  private running = false
  private destroyed = false

  /** Check if the runner has been destroyed. */
  get isDestroyed(): boolean { return this.destroyed }

  // Escape sequence buffering
  private escBuffer = ''

  constructor(tabId: string) {
    this.tabId = tabId
  }

  // ── PromptHost interface ────────────────────────────────────────────────

  setInputHandler(handler: InputHandler | null): void {
    this._inputHandler = handler
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Render the banner and first prompt. */
  start(): void {
    if (this.destroyed) return
    this.renderPrompt()
  }

  /** Stop accepting input. */
  destroy(): void {
    this.destroyed = true
    this._inputHandler = null
  }

  // ── Input routing ─────────────────────────────────────────────────────

  /** Handle raw keystroke data from xterm.js. */
  handleInput(data: string): void {
    if (this.destroyed) return

    // If a prompt is active, delegate to it
    if (this._inputHandler) {
      this._inputHandler(data)
      return
    }

    // Escape sequence buffering
    if (this.escBuffer.length > 0) {
      this.escBuffer += data
      if (this.escBuffer.length >= 3) {
        const seq = this.escBuffer
        this.escBuffer = ''
        this.handleEscape(seq)
      }
      return
    }

    if (data.charCodeAt(0) === 0x1b) {
      if (data.length >= 3) {
        this.handleEscape(data.slice(0, 3))
      } else {
        this.escBuffer = data
      }
      return
    }

    // Enter
    if (data === '\r') {
      writeln(this.tabId, '')
      const line = this.inputBuffer.trim()
      this.inputBuffer = ''
      this.cursorPos = 0
      this.historyIndex = -1
      if (line) {
        this.history.push(line)
        this.processLine(line)
      } else {
        this.renderPrompt()
      }
      return
    }

    // Backspace
    if (data === '\x7f' || data === '\b') {
      if (this.cursorPos > 0) {
        this.inputBuffer = this.inputBuffer.slice(0, this.cursorPos - 1) + this.inputBuffer.slice(this.cursorPos)
        this.cursorPos--
        this.redrawLine()
      }
      return
    }

    // Ctrl+C — cancel current line
    if (data === '\x03') {
      write(this.tabId, `${DIM}^C${RESET}`)
      writeln(this.tabId, '')
      this.inputBuffer = ''
      this.cursorPos = 0
      this.historyIndex = -1
      this.renderPrompt()
      return
    }

    // Ctrl+L — clear screen
    if (data === '\x0c') {
      write(this.tabId, '\x1b[2J\x1b[H')
      this.renderPrompt()
      write(this.tabId, this.inputBuffer)
      return
    }

    // Ctrl+A — move to start
    if (data === '\x01') {
      this.cursorPos = 0
      this.redrawLine()
      return
    }

    // Ctrl+E — move to end
    if (data === '\x05') {
      this.cursorPos = this.inputBuffer.length
      this.redrawLine()
      return
    }

    // Ctrl+U — clear line
    if (data === '\x15') {
      this.inputBuffer = ''
      this.cursorPos = 0
      this.redrawLine()
      return
    }

    // Tab — completion
    if (data === '\t') {
      this.handleTab()
      return
    }

    // Printable characters
    if (data >= ' ' && data <= '~') {
      this.inputBuffer = this.inputBuffer.slice(0, this.cursorPos) + data + this.inputBuffer.slice(this.cursorPos)
      this.cursorPos++
      this.redrawLine()
    }
  }

  // ── Escape sequences ──────────────────────────────────────────────────

  private handleEscape(seq: string): void {
    if (seq.length < 3) return
    const code = seq.charAt(2)

    // Up arrow — history back
    if (code === 'A') {
      if (this.history.length === 0) return
      if (this.historyIndex === -1) {
        this.historySnapshot = this.inputBuffer
        this.historyIndex = this.history.length - 1
      } else if (this.historyIndex > 0) {
        this.historyIndex--
      }
      this.inputBuffer = this.history[this.historyIndex]
      this.cursorPos = this.inputBuffer.length
      this.redrawLine()
      return
    }

    // Down arrow — history forward
    if (code === 'B') {
      if (this.historyIndex === -1) return
      if (this.historyIndex < this.history.length - 1) {
        this.historyIndex++
        this.inputBuffer = this.history[this.historyIndex]
      } else {
        this.historyIndex = -1
        this.inputBuffer = this.historySnapshot
      }
      this.cursorPos = this.inputBuffer.length
      this.redrawLine()
      return
    }

    // Left arrow
    if (code === 'D') {
      if (this.cursorPos > 0) {
        this.cursorPos--
        write(this.tabId, '\x1b[D')
      }
      return
    }

    // Right arrow
    if (code === 'C') {
      if (this.cursorPos < this.inputBuffer.length) {
        this.cursorPos++
        write(this.tabId, '\x1b[C')
      }
      return
    }
  }

  // ── Line editing ──────────────────────────────────────────────────────

  private redrawLine(): void {
    // Single write: erase line + prompt + buffer + cursor reposition
    const moveBack = this.inputBuffer.length - this.cursorPos
    const cursorMove = moveBack > 0 ? `\x1b[${moveBack}D` : ''
    write(this.tabId, ERASE_LINE + PROMPT + this.inputBuffer + cursorMove)
  }

  private renderPrompt(): void {
    write(this.tabId, PROMPT)
  }

  // ── Tab completion ────────────────────────────────────────────────────

  private handleTab(): void {
    const tokens = this.inputBuffer.split(/\s+/).filter(Boolean)
    const completions = getCompletions(tokens)

    if (completions.length === 0) return

    if (completions.length === 1) {
      // Auto-complete
      const lastToken = tokens[tokens.length - 1] ?? ''
      const completion = completions[0]
      const suffix = completion.slice(lastToken.length) + ' '
      this.inputBuffer += suffix
      this.cursorPos = this.inputBuffer.length
      this.redrawLine()
    } else {
      // Show all options
      writeln(this.tabId, '')
      writeln(this.tabId, `  ${completions.join('  ')}`)
      this.renderPrompt()
      write(this.tabId, this.inputBuffer)
    }
  }

  // ── Command dispatch ──────────────────────────────────────────────────

  private async processLine(line: string): Promise<void> {
    if (this.running) return
    this.running = true

    try {
      // Built-in commands
      if (line === 'help') {
        this.showHelp()
        return
      }

      if (line === 'clear') {
        write(this.tabId, '\x1b[2J\x1b[H')
        return
      }

      const tokens = line.split(/\s+/)
      const resolved = resolveCommand(tokens)

      if (!resolved) {
        writeln(this.tabId, `  ${RED}Unknown command:${RESET} ${line}`)
        writeln(this.tabId, `  ${DIM}Type 'help' for available commands.${RESET}`)
        writeln(this.tabId, '')
        return
      }

      await resolved.handler.run(this, resolved.args)
    } catch (err: unknown) {
      writeln(this.tabId, `  ${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}`)
      writeln(this.tabId, '')
    } finally {
      this.running = false
      if (!this.destroyed) {
        this.renderPrompt()
      }
    }
  }

  // ── Help ──────────────────────────────────────────────────────────────

  private showHelp(): void {
    writeln(this.tabId, '')
    writeln(this.tabId, `  ${BOLD}Latch Terminal Commands${RESET}`)
    writeln(this.tabId, `  ${DIM}${'─'.repeat(40)}${RESET}`)
    writeln(this.tabId, '')

    const groups = getGroups()
    for (const [name, group] of Object.entries(groups)) {
      writeln(this.tabId, `  ${CYAN}${BOLD}${name}${RESET}  ${DIM}${group.description}${RESET}`)
      for (const [action, cmd] of Object.entries(group.commands)) {
        if (action === 'default') continue
        writeln(this.tabId, `    ${GREEN}latch ${name} ${action}${RESET}  ${DIM}${cmd.description}${RESET}`)
      }
      writeln(this.tabId, '')
    }

    writeln(this.tabId, `  ${GREEN}help${RESET}   ${DIM}Show this help message${RESET}`)
    writeln(this.tabId, `  ${GREEN}clear${RESET}  ${DIM}Clear the terminal${RESET}`)
    writeln(this.tabId, '')
  }
}
