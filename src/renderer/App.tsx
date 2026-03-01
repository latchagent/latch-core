/**
 * @module App
 * @description Root React component for Latch Desktop.
 *
 * Responsibilities:
 *  - Register global event listeners (PTY data, window resize) once on mount.
 *  - Boot the application (load harnesses + sessions from DB).
 *  - Render the two-column layout: Sidebar | Terminal area.
 *  - Mount modal overlays (PolicyEditor, SkillEditor).
 */

import React, { useEffect } from 'react'
import { useAppStore }      from './store/useAppStore'
import { terminalManager }  from './terminal/TerminalManager'
import { playNotificationSound } from './utils/notification-sound'

import Sidebar         from './components/Sidebar'
import Topbar          from './components/Topbar'
import TerminalArea    from './components/TerminalArea'
import WelcomeScreen       from './components/WelcomeScreen'
import LatchTerminalPane   from './components/LatchTerminalPane'
import PoliciesView    from './components/PoliciesView'
import SkillsView      from './components/SkillsView'
import AgentsView      from './components/AgentsView'
import McpView         from './components/McpView'
import FeedView         from './components/FeedView'
import RadarView        from './components/RadarView'
import VaultView        from './components/VaultView'
import DocsView         from './components/DocsView'
import CreatePolicyView from './components/CreatePolicyView'
import SettingsView     from './components/panels/SettingsPanel'
import PolicyEditor    from './components/modals/PolicyEditor'
import SkillEditor     from './components/modals/SkillEditor'
import SkillDetail     from './components/modals/SkillDetail'
import McpEditor       from './components/modals/McpEditor'
import McpDetail       from './components/modals/McpDetail'
import SecretEditor    from './components/modals/SecretEditor'

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: React.ErrorInfo) { console.error('Uncaught render error:', error, info) }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: 'var(--error)', fontFamily: 'monospace', background: 'var(--bg-app)', minHeight: '100vh' }}>
          <h2>Something went wrong</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>{this.state.error.message}</pre>
          <button onClick={() => this.setState({ error: null })} style={{ marginTop: 16, padding: '8px 16px', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)', borderRadius: 4, cursor: 'pointer' }}>
            Try Again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  const {
    activeSessionId,
    sessions,
    activeView,
    handlePtyData,
    handlePtyExit,
    handleDockerStatus,
    handleActivityEvent,
    handleRadarSignal,
    handleFeedUpdate,
    handleApprovalRequest,
    handleApprovalResolved,
    loadHarnesses,
    loadSessions,
    loadSoundSetting,
    loadThemeSetting,
    detectDocker,
    appBooting,
    skillEditorOpen,
    skillDetailOpen,
    mcpEditorOpen,
    mcpDetailOpen,
    secretEditorOpen,
  } = useAppStore()

  // ── Boot ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    // Register PTY event listeners once — these route PTY output to the right
    // xterm.js instance via TerminalManager.
    const disposePtyData = window.latch?.onPtyData?.(({ sessionId: tabId, data }) => {
      handlePtyData(tabId, data)
    })
    const disposePtyExit = window.latch?.onPtyExit?.(({ sessionId: tabId }) => {
      handlePtyExit(tabId)
    })

    // Register Docker status listener
    const disposeDockerStatus = window.latch?.onDockerStatus?.(({ sessionId, status }) => {
      handleDockerStatus(sessionId, status as any)
    })

    // Register activity/radar listeners
    const disposeActivityEvent = window.latch?.onActivityEvent?.((event) => {
      handleActivityEvent(event)
    })
    const disposeRadarSignal = window.latch?.onRadarSignal?.((signal) => {
      handleRadarSignal(signal)
    })

    // Register feed listener
    const disposeFeedUpdate = window.latch?.onFeedUpdate?.((item) => {
      handleFeedUpdate(item)
    })

    // Register approval listeners
    const disposeApprovalRequest = window.latch?.onApprovalRequest?.((approval) => {
      handleApprovalRequest(approval)
      if (useAppStore.getState().soundNotifications) playNotificationSound()
    })
    const disposeApprovalResolved = window.latch?.onApprovalResolved?.((payload) => {
      handleApprovalResolved(payload)
    })

    // Load harnesses and sessions on startup, detect walkie-sh + Docker
    loadHarnesses()
      .then(() => loadSessions())
      .then(() => useAppStore.setState({ appBooting: false }))
      .catch(() => useAppStore.setState({ appBooting: false }))
    loadSoundSetting()
    loadThemeSetting()
    detectDocker()
    useAppStore.getState().loadSandboxSettings()
    useAppStore.getState().loadServices()

    return () => {
      disposePtyData?.()
      disposePtyExit?.()
      disposeDockerStatus?.()
      disposeActivityEvent?.()
      disposeRadarSignal?.()
      disposeFeedUpdate?.()
      disposeApprovalRequest?.()
      disposeApprovalResolved?.()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Global keyboard shortcuts (⌘N new session, ⌘O open project) ─────────

  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return

      if (e.key === 'n') {
        e.preventDefault()
        const { sessions, createSession } = useAppStore.getState()
        createSession(`Session ${sessions.size + 1}`)
      }

      if (e.key === 'o') {
        e.preventDefault()
        ;(async () => {
          const result = await window.latch?.pickDirectory?.()
          if (result && !result.cancelled && result.filePath) {
            const { sessions, setPendingProjectDir, createSession } = useAppStore.getState()
            setPendingProjectDir(result.filePath)
            createSession(`Session ${sessions.size + 1}`)
          }
        })()
      }

      if (e.key === 'p') {
        e.preventDefault()
        useAppStore.getState().setActiveView('policies')
      }

      if (e.key === 'i') {
        e.preventDefault()
        useAppStore.getState().setActiveView('skills')
      }

      if (e.key === 't') {
        e.preventDefault()
        const { activeSessionId, sessions, addTab } = useAppStore.getState()
        if (!activeSessionId) return
        const session = sessions.get(activeSessionId)
        if (session && !session.showWizard) {
          addTab(activeSessionId)
        }
      }
    }

    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [])

  // ── Window resize → fit active terminal ──────────────────────────────────

  useEffect(() => {
    const handleResize = () => {
      const { activeSessionId, sessions } = useAppStore.getState()
      if (!activeSessionId) return
      const session = sessions.get(activeSessionId)
      if (!session) return
      const tabId = session.activeTabId
      terminalManager.fit(tabId)
      const { cols, rows } = terminalManager.dimensions(tabId)
      const tab = session.tabs.get(tabId)
      if (tab?.ptyReady) {
        window.latch?.resizePty?.({ sessionId: tabId, cols, rows })
      }
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const activeSession = activeSessionId ? sessions.get(activeSessionId) : undefined

  // Determine main content based on activeView
  const showLatchHome = activeView === 'home' && !activeSessionId
  const isSessionView = activeView === 'home' && !!activeSessionId

  let mainContent: React.ReactNode
  if (activeView === 'policies') {
    mainContent = <PoliciesView />
  } else if (activeView === 'skills') {
    mainContent = <SkillsView />
  } else if (activeView === 'agents') {
    mainContent = <AgentsView />
  } else if (activeView === 'mcp') {
    mainContent = <McpView />
  } else if (activeView === 'feed') {
    mainContent = <FeedView />
  } else if (activeView === 'vault') {
    mainContent = <VaultView />
  } else if (activeView === 'docs') {
    mainContent = <DocsView />
  } else if (activeView === 'radar') {
    mainContent = <RadarView />
  } else if (activeView === 'create-policy') {
    mainContent = <CreatePolicyView />
  } else if (activeView === 'edit-policy') {
    mainContent = <PolicyEditor />
  } else if (activeView === 'settings') {
    mainContent = <SettingsView />
  } else if (showLatchHome) {
    mainContent = <WelcomeScreen />
  } else {
    mainContent = (
      <>
        <Topbar session={activeSession} />
        <section className="workspace">
          <div className="terminal-shell">
            <TerminalArea session={activeSession} />
          </div>
        </section>
      </>
    )
  }

  return (
    <ErrorBoundary>
      {/* ── Modal overlays ──────────────────────────────────────────────── */}
      {skillEditorOpen  && <SkillEditor />}
      {skillDetailOpen  && <SkillDetail />}
      {mcpEditorOpen    && <McpEditor />}
      {mcpDetailOpen    && <McpDetail />}
      {secretEditorOpen && <SecretEditor />}
      {/* ── App shell ───────────────────────────────────────────────────── */}
      <div className="app no-rail">
        <Sidebar />

        <main className="main">
          {mainContent}
        </main>
      </div>
    </ErrorBoundary>
  )
}
