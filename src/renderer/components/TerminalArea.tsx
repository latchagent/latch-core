/**
 * @module TerminalArea
 * @description Renders xterm.js terminal panes for all tabs in the active session.
 *
 * Key design decisions:
 *  - All tab panes are always mounted in the DOM (never unmounted).
 *    This preserves scrollback buffer and terminal state across tab switches.
 *  - We toggle `display: none / block` (via CSS class) instead of React mount/unmount.
 *  - xterm.js instances are managed by TerminalManager (imperative, outside React).
 *  - useEffect mounts terminals when containers become available.
 *  - A ResizeObserver on the active pane triggers fitAddon on size changes.
 *  - When showWizard is true, the terminal is still visible but keystrokes are
 *    routed to the TerminalWizard instead of the PTY.
 */

import React, { useEffect, useRef, useState } from 'react'
import { useAppStore, useTabAgentStatus } from '../store/useAppStore'
import { terminalManager } from '../terminal/TerminalManager'
import { TerminalWizard, buildWizardSteps } from '../terminal/TerminalWizard'
import type { SessionRecord, TabRecord, DockerConfig } from '../../types'
import ApprovalBar   from './ApprovalBar'
import StatusDot     from './StatusDot'

// ─── Tab pane ─────────────────────────────────────────────────────────────────

interface TabPaneProps {
  tab:        TabRecord
  isActive:   boolean
  sessionId:  string
  wizardRef:  React.MutableRefObject<TerminalWizard | null>
}

/**
 * A single terminal pane — always in the DOM, shown/hidden via CSS.
 * Mounts an xterm.js Terminal instance into the container div on first render.
 */
function TabPane({ tab, isActive, sessionId, wizardRef }: TabPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const reconnectingRef = useRef(false)
  const setTabPtyReady = useAppStore((s) => s.setTabPtyReady)

  // Mount xterm.js into the container once the DOM node is available.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // onData handler: route keystrokes to wizard or PTY.
    const onData = (data: string) => {
      const session = useAppStore.getState().sessions.get(sessionId)

      // When wizard is active, route keystrokes to it instead of the PTY
      if (session?.showWizard) {
        wizardRef.current?.handleInput(data)
        return
      }

      const t = session?.tabs.get(tab.id)
      if (!t?.ptyReady) return
      window.latch?.writePty?.({ sessionId: tab.id, data })
    }

    terminalManager.mount(tab.id, container, onData)

    // Write reconnect prompt for sessions loaded from DB.
    if (tab.needsReconnect) {
      terminalManager.writeln(tab.id, `\x1b[2m${tab.label}\x1b[0m`)
      terminalManager.writeln(tab.id, '\x1b[2mActivate to reconnect shell...\x1b[0m')
    }

    return () => {
      // Only dispose if the tab is actually being removed (not just hidden).
      // React Strict Mode double-invokes effects — unmount disposes immediately
      // which would break things. We rely on closeTab() to call unmount.
    }
  }, [tab.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // When this tab becomes active, fit the terminal and focus it.
  useEffect(() => {
    if (!isActive) return
    requestAnimationFrame(() => {
      terminalManager.fit(tab.id)
      terminalManager.focus(tab.id)

      // Reconnect if needed (guard against duplicate in-flight reconnections)
      const session = useAppStore.getState().sessions.get(sessionId)
      const t = session?.tabs.get(tab.id)
      if (t?.needsReconnect && !t.ptyReady && !reconnectingRef.current) {
        reconnectingRef.current = true

        // Clear needsReconnect synchronously BEFORE spawning PTY to prevent
        // re-renders from triggering duplicate reconnections.
        useAppStore.setState((s) => {
          const sessions = new Map(s.sessions)
          sessions.forEach((sess) => {
            if (sess.tabs.has(tab.id)) {
              const tabs = new Map(sess.tabs)
              const existingTab = tabs.get(tab.id)!
              tabs.set(tab.id, { ...existingTab, needsReconnect: false })
              sessions.set(sess.id, { ...sess, tabs })
            }
          })
          return { sessions }
        })

        const cwd = session?.worktreePath ?? session?.repoRoot ?? undefined
        terminalManager.writeln(tab.id, '\x1b[2mReconnecting...\x1b[0m')
        const { cols, rows } = terminalManager.dimensions(tab.id)
        window.latch?.createPty?.({ sessionId: tab.id, cwd, cols, rows }).then((result) => {
          reconnectingRef.current = false
          if (result?.ok) {
            setTabPtyReady(tab.id, true)
            terminalManager.writeln(tab.id, '\x1b[32mShell ready.\x1b[0m')
          }
        }).catch((err) => {
          reconnectingRef.current = false
          console.error('PTY reconnect failed:', err)
        })
      }
    })
  }, [isActive, tab.id, sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={`terminal-pane${isActive ? '' : ' is-hidden'}`}
      data-tab-id={tab.id}
      ref={containerRef}
    />
  )
}

// ─── TabButton ───────────────────────────────────────────────────────────────

interface TabButtonProps {
  tab:        TabRecord
  sessionId:  string
  isActive:   boolean
  canClose:   boolean
  onActivate: () => void
  onClose:    () => void
}

/** Single tab button with status dot — supports double-click to rename. */
function TabButton({ tab, sessionId, isActive, canClose, onActivate, onClose }: TabButtonProps) {
  const status = useTabAgentStatus(sessionId, tab.id)
  const renameTab = useAppStore((s) => s.renameTab)
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(tab.label)
  const inputRef = useRef<HTMLInputElement>(null)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const commitRename = () => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== tab.label) {
      renameTab(sessionId, tab.id, trimmed)
    }
    setEditing(false)
  }

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const handleClick = () => {
    if (editing) return
    if (clickTimer.current) {
      // Second click within window — it's a double-click
      clearTimeout(clickTimer.current)
      clickTimer.current = null
      setEditValue(tab.label)
      setEditing(true)
    } else {
      // First click — wait to see if a second follows
      clickTimer.current = setTimeout(() => {
        clickTimer.current = null
        onActivate()
      }, 250)
    }
  }

  return (
    <button
      className={`terminal-tab${isActive ? ' is-active' : ''}`}
      onClick={handleClick}
    >
      <StatusDot status={status} />
      {editing ? (
        <input
          ref={inputRef}
          className="terminal-tab-rename"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') setEditing(false)
            e.stopPropagation()
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span>{tab.label}</span>
      )}
      {canClose && !editing && (
        <span
          className="terminal-tab-close"
          onClick={(e) => { e.stopPropagation(); onClose() }}
        >
          ×
        </span>
      )}
    </button>
  )
}

// ─── TerminalArea ─────────────────────────────────────────────────────────────

interface TerminalAreaProps {
  session?: SessionRecord
}

export default function TerminalArea({ session }: TerminalAreaProps) {
  const { activateTab, closeTab, addTab, finalizeSession } = useAppStore()
  const wizardRef = useRef<TerminalWizard | null>(null)
  const wizardStartedRef = useRef<string | null>(null)

  // Start the terminal wizard when a session enters wizard mode.
  useEffect(() => {
    if (!session?.showWizard) {
      // Wizard done — clean up
      if (wizardRef.current) {
        wizardRef.current.destroy()
        wizardRef.current = null
      }
      wizardStartedRef.current = null
      return
    }

    const tabId = session.activeTabId
    const sessionId = session.id

    // Guard: don't start the wizard twice for the same session
    if (wizardStartedRef.current === sessionId) return
    wizardStartedRef.current = sessionId

    // Ensure policies + MCP servers are loaded before wizard starts
    const state0 = useAppStore.getState()
    state0.loadMcpServers()

    // Delay wizard start until the terminal is mounted
    const startWizard = async () => {
      const term = terminalManager.get(tabId)
      if (!term) {
        // Terminal not yet mounted — retry on next frame
        requestAnimationFrame(startWizard)
        return
      }

      // Ensure policies are loaded before building wizard steps
      const preState = useAppStore.getState()
      if (!preState.policiesLoaded) await preState.loadPolicies()

      // Fit the terminal first so it renders properly
      terminalManager.fit(tabId)

      const state = useAppStore.getState()
      const harnesses = state.harnesses
      const dockerAvailable = state.dockerAvailable
      const policies = state.policies.map(p => ({ id: p.id, name: p.name }))

      // Check for a pending project dir (set by "Open Project" button)
      const pendingProjectDir = state.pendingProjectDir

      const steps = buildWizardSteps({
        harnesses,
        policies,
        pendingProjectDir,
      })

      const onCancel = () => {
        // User pressed Ctrl+C — delete the session
        useAppStore.getState().deleteSession(sessionId)
      }

      const wizard = new TerminalWizard(tabId, steps, async (answers) => {
        // If projectDir was pre-set via pendingProjectDir, use it
        const projectDir = (pendingProjectDir || answers.projectDir as string) || undefined

        // Clear pendingProjectDir
        if (pendingProjectDir) {
          useAppStore.getState().setPendingProjectDir(null)
        }

        // Apply harness selection to session before finalizing
        const harnessId = (answers.harness as string) || harnesses.find(h => h.installed)?.id || ''
        const harness = harnesses.find(h => h.id === harnessId)

        // Build docker config — auto-enable from settings when Docker is available
        const state2 = useAppStore.getState()
        const dockerEnabled = state2.dockerAvailable && state2.sandboxEnabled && harnessId !== 'openclaw'

        // Auto-detect image from project stack when possible
        let dockerImage = state2.defaultDockerImage || 'node:20'
        if (dockerEnabled && projectDir && window.latch?.detectProjectStack) {
          try {
            const stackResult = await window.latch.detectProjectStack({ cwd: projectDir })
            if (stackResult?.ok && stackResult.stack !== 'unknown') {
              const stackImageMap: Record<string, string> = { node: 'node:20', python: 'python:3.12', go: 'golang:1.22', rust: 'rust:1.77' }
              dockerImage = stackImageMap[stackResult.stack] ?? dockerImage
            }
          } catch { /* best-effort */ }
        }

        const docker: DockerConfig | null = dockerEnabled
          ? {
              enabled: true,
              image: dockerImage,
              ports: [],
              extraVolumes: [],
              containerId: null,
              status: 'pulling',
            }
          : null

        // Warn if sandbox is enabled but Docker is not available
        if (state2.sandboxEnabled && !state2.dockerAvailable && harnessId !== 'openclaw') {
          terminalManager.writeln(tabId, '\x1b[33mSandbox enabled but Docker not detected — running without sandbox.\x1b[0m')
        }

        // Resolve policy selection
        const selectedPolicyId = (answers.policy as string) || 'none'
        const selectedPolicy = selectedPolicyId !== 'none'
          ? policies.find(p => p.id === selectedPolicyId)
          : null

        // Apply harness + docker + policy to session in store
        useAppStore.setState((s) => {
          const sessions = new Map(s.sessions)
          const sess = sessions.get(sessionId)
          if (sess) {
            sessions.set(sessionId, {
              ...sess,
              ...(harness ? {
                harnessId: harness.id,
                harness: harness.label,
                harnessCommand: harness.recommendedCommand,
              } : {}),
              policyId: selectedPolicy ? selectedPolicy.id : '',
              policy: selectedPolicy ? selectedPolicy.name : 'None',
              docker,
            })
          }
          return { sessions }
        })

        // Gather all enabled MCP server IDs automatically
        const mcpServers = useAppStore.getState().mcpServers
        const mcpServerIds = mcpServers.filter(s => s.enabled).map(s => s.id)

        const isOpenClaw = harnessId === 'openclaw'

        await finalizeSession(sessionId, {
          skipWorktree: isOpenClaw,
          goal: (answers.goal as string) || '',
          branchName: isOpenClaw ? '' : ((answers.branch as string) || ''),
          projectDir: isOpenClaw ? undefined : projectDir,
          mcpServerIds: mcpServerIds.length > 0 ? mcpServerIds : undefined,
        })
      }, onCancel)

      wizardRef.current = wizard

      // If we have a pending project dir, pre-fill the answer and the wizard
      // will skip the browse step
      if (pendingProjectDir) {
        wizard.handlePrefill('projectDir', pendingProjectDir)
      }

      wizard.start()
      terminalManager.focus(tabId)
    }

    // Give the terminal a frame to mount
    requestAnimationFrame(startWizard)
  }, [session?.showWizard, session?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Resize observer: refit active terminal when the container changes size.
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = hostRef.current
    if (!el) return

    const observer = new ResizeObserver(() => {
      if (!session?.id) return
      const currentSession = useAppStore.getState().sessions.get(session.id)
      if (!currentSession) return
      const tabId = currentSession.activeTabId
      terminalManager.fit(tabId)
      const { cols, rows } = terminalManager.dimensions(tabId)
      const tab = currentSession.tabs.get(tabId)
      if (tab?.ptyReady) {
        window.latch?.resizePty?.({ sessionId: tabId, cols, rows })
      }
    })

    observer.observe(el)
    return () => observer.disconnect()
  }, [session?.id, session?.activeTabId])

  if (!session) {
    return (
      <div className="terminal-body" id="terminal-body">
        <div className="terminal-host" id="terminal-host" />
        <div className="empty-state" id="empty-state">
          <div className="empty-state-icon" />
          <div className="empty-state-title">No sessions yet</div>
          <div className="empty-state-meta">
            Create a session to start a harness terminal
          </div>
          <button
            className="empty-state-action"
            onClick={() => useAppStore.getState().createSession('Session 1')}
          >
            + New Session
          </button>
        </div>
      </div>
    )
  }

  const tabs       = Array.from(session.tabs.values())
  const activeTabId = session.activeTabId

  const slugify = (v: string) =>
    v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

  const titleLabel = (session.harness || 'shell').toLowerCase().replace(/\s+/g, '-')
  const titleText  = `${titleLabel} · ${slugify(session.name) || 'session'}`

  return (
    <div className="terminal-body" id="terminal-body">
      {/* ── Terminal header: title, tab bar, + button ───────────────────── */}
      <div className="terminal-header">
        <span className="terminal-title">{titleText}</span>

        <div className="terminal-tabs" id="terminal-tabs">
          {tabs.map((tab) => (
            <TabButton
              key={tab.id}
              tab={tab}
              sessionId={session.id}
              isActive={tab.id === activeTabId}
              canClose={tabs.length > 1}
              onActivate={() => activateTab(session.id, tab.id)}
              onClose={() => closeTab(session.id, tab.id)}
            />
          ))}
        </div>

        {!session.showWizard && (
          <button
            className="terminal-tab-add"
            title="Add terminal"
            onClick={() => addTab(session.id)}
          >
            +
          </button>
        )}
      </div>

      {/* ── Approval bar: interactive tool-call approval ─────────────── */}
      <ApprovalBar />

      {/* ── Terminal host: always-mounted xterm panes ──────────────────── */}
      <div className="terminal-host" id="terminal-host" ref={hostRef}>
        {tabs.map((tab) => (
          <TabPane
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            sessionId={session.id}
            wizardRef={wizardRef}
          />
        ))}
      </div>
    </div>
  )
}
