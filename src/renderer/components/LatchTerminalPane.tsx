/**
 * @module LatchTerminalPane
 * @description The Latch Terminal — the app's Home view. Shows an interactive
 * launcher menu (arrow-key select) on start, with fallback to a Latch CLI
 * prompt on Ctrl+C.
 *
 * The banner is rendered as HTML (not terminal text) so that the browser's
 * font fallback chain handles Unicode block characters correctly.
 *
 * The terminal is mounted once and never unmounted (matching the always-mounted
 * pattern used for session terminals). It runs a CommandRunner that interprets
 * Latch CLI commands and hosts the launcher menu via promptSelect.
 */

import React, { useEffect, useRef } from 'react'
import { terminalManager } from '../terminal/TerminalManager'
import { CommandRunner } from '../terminal/CommandRunner'
import { promptSelect } from '../terminal/prompts'
import { useAppStore } from '../store/useAppStore'

// Import all command modules so they register with the command registry.
import '../terminal/commands/loader'

/** Stable tab ID for the Latch Terminal (never changes). */
export const LATCH_TAB_ID = '__latch__'

/** Module-level flag — survives React unmount/remount cycles.
 *  Prevents duplicate initialization every time the user navigates
 *  away from Home and back.
 */
let latchTerminalStarted = false

/** Module-level runner ref — survives remounts so we can re-show the launcher. */
let latchRunner: CommandRunner | null = null

/** Track whether the launcher menu is currently active (awaiting user input). */
let launcherActive = false

const ASCII_LOGO = `██╗      █████╗ ████████╗ ██████╗██╗  ██╗
██║     ██╔══██╗╚══██╔══╝██╔════╝██║  ██║
██║     ███████║   ██║   ██║     ███████║
██║     ██╔══██║   ██║   ██║     ██╔══██║
███████╗██║  ██║   ██║   ╚██████╗██║  ██║
╚══════╝╚═╝  ╚═╝   ╚═╝    ╚═════╝╚═╝  ╚═╝`

const LAUNCHER_OPTIONS = [
  { label: 'New Session',  value: 'new-session',  description: 'Start a new agent session' },
  { label: 'Open Project', value: 'open-project', description: 'Browse for a project directory' },
  { label: 'Policies',     value: 'policies',     description: 'Manage security policies' },
  { label: 'Skills',       value: 'skills',       description: 'Manage agent skills' },
  { label: 'MCP Servers',  value: 'mcp',          description: 'Manage MCP server configs' },
  { label: 'Vault',        value: 'vault',        description: 'Manage secrets' },
  { label: 'Settings',     value: 'settings',     description: 'App settings' },
]

/** Show the launcher menu, dispatch the selected action, then re-show. */
async function showLauncher(runner: CommandRunner): Promise<void> {
  if (runner.isDestroyed || launcherActive) return
  launcherActive = true

  const choice = await promptSelect(runner, 'What would you like to do?', LAUNCHER_OPTIONS)
  launcherActive = false

  if (runner.isDestroyed) return

  // Ctrl+C on the menu — drop to command line prompt
  if (!choice) {
    runner.start()
    return
  }

  const store = useAppStore.getState()

  switch (choice) {
    case 'new-session': {
      const { sessions, createSession } = store
      createSession(`Session ${sessions.size + 1}`)
      return // Don't re-show — user is now in the session
    }
    case 'open-project': {
      const result = await window.latch?.pickDirectory?.()
      if (result && !result.cancelled && result.filePath) {
        const { sessions, setPendingProjectDir, createSession } = useAppStore.getState()
        setPendingProjectDir(result.filePath)
        createSession(`Session ${sessions.size + 1}`)
        return // Don't re-show — user is now in the session
      }
      // Cancelled — re-show launcher
      break
    }
    case 'policies':
    case 'skills':
    case 'mcp':
    case 'vault':
    case 'settings':
      store.setActiveView(choice as any)
      return // Don't re-show — user navigated away
    default:
      break
  }

  // Re-show launcher after action completes (e.g. cancelled file picker)
  showLauncher(runner)
}

export default function LatchTerminalPane() {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    if (!latchTerminalStarted) {
      latchTerminalStarted = true

      // Create the command runner
      const runner = new CommandRunner(LATCH_TAB_ID)
      latchRunner = runner

      // Mount xterm.js with the runner as the input handler
      terminalManager.mount(LATCH_TAB_ID, container, (data) => {
        runner.handleInput(data)
      })

      // Show the launcher menu
      showLauncher(runner)
    } else {
      // Already started — just re-parent the existing terminal DOM node
      terminalManager.mount(LATCH_TAB_ID, container, (data) => {
        latchRunner?.handleInput(data)
      })

      // Clear and re-show launcher when navigating back to Home
      if (latchRunner && !launcherActive && !latchRunner.isDestroyed) {
        const term = terminalManager.get(LATCH_TAB_ID)
        if (term) term.clear()
        showLauncher(latchRunner)
      }
    }

    // Fit after initial mount or re-parent
    requestAnimationFrame(() => {
      terminalManager.fit(LATCH_TAB_ID)
    })

    return () => {
      // Don't unmount — keep terminal alive
    }
  }, [])

  // ResizeObserver for terminal fitting
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver(() => {
      terminalManager.fit(LATCH_TAB_ID)
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Focus terminal when component becomes visible
  useEffect(() => {
    requestAnimationFrame(() => {
      terminalManager.fit(LATCH_TAB_ID)
      terminalManager.focus(LATCH_TAB_ID)
    })
  }) // intentionally no deps — runs on every render to re-focus on visibility

  return (
    <div className="latch-terminal-pane">
      <div className="latch-terminal-banner">
        <pre className="latch-terminal-logo">{ASCII_LOGO}</pre>
        <p className="latch-terminal-version">
          Ctrl+C for command line
        </p>
      </div>
      <div className="latch-terminal-xterm" ref={containerRef} />
    </div>
  )
}
