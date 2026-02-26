/**
 * @module TerminalWizard
 * @description Interactive CLI-style session setup wizard that runs inside an
 * xterm.js terminal. Renders prompts with ANSI escape codes and intercepts
 * keystrokes to collect user input step-by-step.
 */

import { terminalManager } from './TerminalManager'

// ─── ANSI helpers ────────────────────────────────────────────────────────────

const BOLD    = '\x1b[1m'
const DIM     = '\x1b[2m'
const RESET   = '\x1b[0m'
const GREEN   = '\x1b[32m'
const CYAN    = '\x1b[36m'
const YELLOW  = '\x1b[33m'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const ERASE_LINE  = '\x1b[2K\r'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WizardOption {
  label: string
  value: string
  disabled?: boolean
}

export interface WizardStep {
  id: string
  prompt: string
  type: 'text' | 'select' | 'confirm' | 'browse'
  options?: WizardOption[]
  default?: string
  hint?: string
  skip?: boolean
}

export interface WizardAnswers {
  [key: string]: string | boolean
}

type OnComplete = (answers: WizardAnswers) => void

// ─── Constants ───────────────────────────────────────────────────────────────

// ─── TerminalWizard ──────────────────────────────────────────────────────────

export class TerminalWizard {
  private tabId: string
  private steps: WizardStep[]
  private onComplete: OnComplete
  private currentStep = 0
  private answers: WizardAnswers = {}
  private destroyed = false

  // Text input state
  private inputBuffer = ''

  // Select state
  private selectIndex = 0
  private selectRendered = false

  // Escape sequence accumulator
  private escBuffer = ''

  constructor(tabId: string, steps: WizardStep[], onComplete: OnComplete) {
    this.tabId = tabId
    this.steps = steps
    this.onComplete = onComplete
  }

  /** Kick off the wizard — renders the banner and the first prompt. */
  start(): void {
    this.writeln('')
    this.writeln(`${CYAN}${BOLD}  ┌─────────────────────────────────────┐${RESET}`)
    this.writeln(`${CYAN}${BOLD}  │  Latch — New Session                │${RESET}`)
    this.writeln(`${CYAN}${BOLD}  └─────────────────────────────────────┘${RESET}`)
    this.writeln('')
    this.advanceToNextStep()
  }

  /** Route raw xterm input to the active step's handler. */
  handleInput(data: string): void {
    if (this.destroyed) return

    const step = this.steps[this.currentStep]
    if (!step) return

    // Handle escape sequences — xterm.js typically sends arrow keys as a
    // complete 3-byte string ("\x1b[A") in one onData call, but may also
    // send a lone "\x1b" followed by "[A" in a second call.
    if (this.escBuffer.length > 0) {
      this.escBuffer += data
      if (this.escBuffer.length >= 3) {
        const seq = this.escBuffer
        this.escBuffer = ''
        this.handleEscapeSequence(seq, step)
      }
      return
    }

    // Check if data starts with escape — could be full sequence or partial
    if (data.charCodeAt(0) === 0x1b) {
      if (data.length >= 3) {
        // Complete escape sequence in one call (common case)
        this.handleEscapeSequence(data.slice(0, 3), step)
      } else {
        // Partial — buffer and wait for next onData
        this.escBuffer = data
      }
      return
    }

    switch (step.type) {
      case 'text':    this.handleTextInput(data, step); break
      case 'select':  this.handleSelectInput(data, step); break
      case 'confirm': this.handleConfirmInput(data, step); break
      case 'browse':  this.handleBrowseInput(data, step); break
    }
  }

  /** Pre-fill an answer without rendering the step (used for pendingProjectDir). */
  handlePrefill(stepId: string, value: string | boolean): void {
    this.answers[stepId] = value
  }

  /** Clean up — prevents any further writes. */
  destroy(): void {
    this.destroyed = true
  }

  // ─── Input handlers ─────────────────────────────────────────────────────

  private handleTextInput(data: string, step: WizardStep): void {
    if (data === '\r') {
      // Submit
      const value = this.inputBuffer || step.default || ''
      this.answers[step.id] = value
      this.writeln('')
      this.inputBuffer = ''
      this.advance()
      return
    }

    if (data === '\x7f' || data === '\b') {
      // Backspace
      if (this.inputBuffer.length > 0) {
        this.inputBuffer = this.inputBuffer.slice(0, -1)
        this.write('\b \b')
      }
      return
    }

    // Ctrl+C — skip with default
    if (data === '\x03') {
      this.answers[step.id] = step.default || ''
      this.writeln('')
      this.inputBuffer = ''
      this.advance()
      return
    }

    // Regular printable character
    if (data >= ' ' && data <= '~') {
      this.inputBuffer += data
      this.write(data)
    }
  }

  private handleSelectInput(data: string, step: WizardStep): void {
    const options = (step.options ?? []).filter(o => !o.disabled)
    if (options.length === 0) return

    if (data === '\r') {
      // Submit selection
      const selected = options[this.selectIndex]
      if (selected) {
        this.answers[step.id] = selected.value
        this.write(SHOW_CURSOR)
        this.writeln('')
        this.advance()
      }
      return
    }

    // Ctrl+C — select first
    if (data === '\x03') {
      this.answers[step.id] = options[0]?.value ?? ''
      this.write(SHOW_CURSOR)
      this.writeln('')
      this.advance()
      return
    }
  }

  private handleConfirmInput(data: string, step: WizardStep): void {
    const lower = data.toLowerCase()

    if (lower === 'y') {
      this.answers[step.id] = true
      this.writeln(`${GREEN}y${RESET}`)
      this.advance()
      return
    }

    if (lower === 'n' || data === '\r') {
      // Enter defaults to 'no' (y/N)
      this.answers[step.id] = data === '\r' ? (step.default === 'y') : false
      this.writeln(`${DIM}n${RESET}`)
      this.advance()
      return
    }

    // Ctrl+C
    if (data === '\x03') {
      this.answers[step.id] = step.default === 'y'
      this.writeln('')
      this.advance()
      return
    }
  }

  private handleBrowseInput(data: string, step: WizardStep): void {
    if (data === '\r') {
      // Open native file picker
      this.openDirectoryPicker(step)
      return
    }

    // Ctrl+C — skip with empty
    if (data === '\x03') {
      this.answers[step.id] = ''
      this.writeln('')
      this.advance()
      return
    }
  }

  private handleEscapeSequence(seq: string, step: WizardStep): void {
    if (step.type !== 'select') return

    const options = (step.options ?? []).filter(o => !o.disabled)
    if (options.length === 0) return

    if (seq === '\x1b[A') {
      // Up arrow
      this.selectIndex = (this.selectIndex - 1 + options.length) % options.length
      this.renderSelect(step)
    } else if (seq === '\x1b[B') {
      // Down arrow
      this.selectIndex = (this.selectIndex + 1) % options.length
      this.renderSelect(step)
    }
  }

  // ─── Directory picker ───────────────────────────────────────────────────

  private async openDirectoryPicker(step: WizardStep): Promise<void> {
    if (!window.latch?.pickDirectory) {
      this.answers[step.id] = ''
      this.writeln(`${YELLOW}Directory picker not available${RESET}`)
      this.advance()
      return
    }

    const result = await window.latch.pickDirectory()
    if (result?.cancelled || !result?.filePath) {
      // User cancelled — re-prompt
      this.writeln(`${DIM}  No directory selected. Press Enter to try again.${RESET}`)
      return
    }

    const dir = result.filePath
    this.answers[step.id] = dir
    this.writeln(`  ${GREEN}>${RESET} ${dir}`)

    // Check git status
    if (window.latch?.getGitStatus) {
      const status = await window.latch.getGitStatus({ cwd: dir })
      if (status?.isRepo) {
        this.writeln(`  ${GREEN}✓${RESET} ${DIM}Git repo detected${RESET}`)
      } else {
        this.writeln(`  ${DIM}No git repo — will start without worktree${RESET}`)
      }
    }

    this.writeln('')
    this.advance()
  }

  // ─── Rendering ──────────────────────────────────────────────────────────

  private renderPrompt(step: WizardStep): void {
    this.writeln(`  ${BOLD}${step.prompt}${RESET}`)

    if (step.hint) {
      this.writeln(`  ${DIM}${step.hint}${RESET}`)
    }

    switch (step.type) {
      case 'text':
        this.inputBuffer = ''
        if (step.default) {
          this.write(`  ${GREEN}>${RESET} ${DIM}${step.default}${RESET}\r  ${GREEN}>${RESET} `)
        } else {
          this.write(`  ${GREEN}>${RESET} `)
        }
        break

      case 'browse':
        this.writeln(`  ${DIM}Press Enter to browse...${RESET}`)
        break

      case 'select':
        this.selectIndex = 0
        this.selectRendered = false
        // Pre-select default if one exists
        if (step.default && step.options) {
          const enabledOptions = step.options.filter(o => !o.disabled)
          const idx = enabledOptions.findIndex(o => o.value === step.default)
          if (idx >= 0) this.selectIndex = idx
        }
        this.write(HIDE_CURSOR)
        this.renderSelect(step)
        break

      case 'confirm':
        this.write(`  ${GREEN}>${RESET} ${DIM}(y/N)${RESET} `)
        break
    }
  }

  private renderSelect(step: WizardStep): void {
    const allOptions = step.options ?? []

    // On re-render (arrow key), erase previous option lines
    if (this.selectRendered) {
      const lineCount = allOptions.length
      for (let i = 0; i < lineCount; i++) {
        this.write(`\x1b[A${ERASE_LINE}`)
      }
    }
    this.selectRendered = true

    let enabledIdx = 0
    for (const opt of allOptions) {
      if (opt.disabled) {
        this.writeln(`    ${DIM}${opt.label}${RESET}`)
      } else {
        const marker = enabledIdx === this.selectIndex ? `${GREEN}>${RESET}` : ' '
        const style = enabledIdx === this.selectIndex ? BOLD : ''
        this.writeln(`  ${marker} ${style}${opt.label}${RESET}`)
        enabledIdx++
      }
    }
  }

  // ─── Step navigation ───────────────────────────────────────────────────

  private advance(): void {
    // Dynamically update skip flags based on collected answers
    const justCompleted = this.steps[this.currentStep]

    // After harness selection, skip irrelevant steps for OpenClaw
    if (justCompleted?.id === 'harness' && this.answers.harness === 'openclaw') {
      for (const step of this.steps) {
        if (step.id === 'projectDir' || step.id === 'branch') {
          step.skip = true
        }
        if (step.id === 'goal') {
          step.prompt = 'What do you want to do?'
          step.hint = 'e.g. Research the latest trends in AI safety'
        }
      }
    }

    this.currentStep++
    this.advanceToNextStep()
  }

  private advanceToNextStep(): void {
    // Skip steps marked as skip
    while (this.currentStep < this.steps.length && this.steps[this.currentStep].skip) {
      this.currentStep++
    }

    if (this.currentStep >= this.steps.length) {
      this.complete()
      return
    }

    this.renderPrompt(this.steps[this.currentStep])
  }

  private complete(): void {
    this.writeln('')
    this.writeln(`  ${GREEN}${BOLD}Starting session...${RESET}`)
    this.writeln('')
    this.onComplete(this.answers)
  }

  // ─── Write helpers ──────────────────────────────────────────────────────

  private write(data: string): void {
    if (this.destroyed) return
    terminalManager.write(this.tabId, data)
  }

  private writeln(text: string): void {
    if (this.destroyed) return
    terminalManager.writeln(this.tabId, text)
  }
}

// ─── Step builder ────────────────────────────────────────────────────────────

export interface WizardStepBuilderOpts {
  harnesses: { id: string; label: string; installed: boolean }[]
  pendingProjectDir?: string | null
}

/**
 * Build the wizard steps array from current app state.
 * Called once when the wizard starts.
 */
export function buildWizardSteps(opts: WizardStepBuilderOpts): WizardStep[] {
  const { harnesses } = opts

  const harnessOptions: WizardOption[] = harnesses.map(h => ({
    label: `${h.label}${h.installed ? '' : ` ${DIM}(not detected)${RESET}`}`,
    value: h.id,
    disabled: !h.installed,
  }))

  const defaultHarness = harnesses.find(h => h.installed)?.id

  // Auto-select harness when only one is available
  const autoSelectedHarness = harnessOptions.filter(o => !o.disabled).length <= 1
    ? defaultHarness
    : undefined

  const steps: WizardStep[] = [
    {
      id: 'harness',
      prompt: 'Preferred harness',
      type: 'select',
      options: harnessOptions,
      default: defaultHarness,
      skip: !!autoSelectedHarness,
    },
    {
      id: 'projectDir',
      prompt: 'Project directory',
      type: 'browse',
      skip: !!opts.pendingProjectDir,
    },
    {
      id: 'goal',
      prompt: 'What are you trying to build?',
      type: 'text',
      hint: 'e.g. Build a REST API for user authentication',
    },
    {
      id: 'branch',
      prompt: 'Branch name',
      type: 'text',
      hint: 'Leave blank to auto-generate',
    },
  ]

  // If harness is auto-selected (only one available), apply adaptive skips now
  if (autoSelectedHarness === 'openclaw') {
    for (const step of steps) {
      if (step.id === 'projectDir' || step.id === 'branch') {
        step.skip = true
      }
      if (step.id === 'goal') {
        step.prompt = 'What do you want to do?'
        step.hint = 'e.g. Research the latest trends in AI safety'
      }
    }
  }

  return steps
}
