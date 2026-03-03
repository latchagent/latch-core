import React, { useEffect, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'

const DOCKER_IMAGE_OPTIONS = [
  { label: 'Node.js 20',   value: 'node:20' },
  { label: 'Python 3.12',  value: 'python:3.12' },
  { label: 'Ubuntu 24.04', value: 'ubuntu:24.04' },
]

// ─── Toggle ──────────────────────────────────────────────────────────────────

function Toggle({ on, onChange, label, description }: {
  on: boolean
  onChange: (v: boolean) => void
  label: string
  description?: string
}) {
  return (
    <div className="settings-toggle" onClick={() => onChange(!on)}>
      <div className={`cp-switch${on ? ' is-on' : ''}`}>
        <div className="cp-switch-thumb" />
      </div>
      <div className="settings-toggle-text">
        <span className="cp-toggle-text">{label}</span>
        {description && <span className="settings-toggle-desc">{description}</span>}
      </div>
    </div>
  )
}

// ─── Appearance section ──────────────────────────────────────────────────────

function AppearanceSection() {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)

  const options: { value: 'dark' | 'light' | 'system'; label: string; desc: string }[] = [
    { value: 'dark',   label: 'Dark',   desc: 'Always use dark theme' },
    { value: 'light',  label: 'Light',  desc: 'Always use light theme' },
    { value: 'system', label: 'System', desc: 'Follow OS preference' },
  ]

  return (
    <div className="panel-card">
      <div className="appearance-options">
        {options.map((opt) => (
          <button
            key={opt.value}
            className={`appearance-option${theme === opt.value ? ' is-active' : ''}`}
            onClick={() => setTheme(opt.value)}
          >
            <div className={`appearance-preview ${opt.value}`}>
              <div className="appearance-preview-sidebar" />
              <div className="appearance-preview-main">
                <div className="appearance-preview-line" />
                <div className="appearance-preview-line short" />
              </div>
            </div>
            <span className="appearance-label">{opt.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── API key section ─────────────────────────────────────────────────────────

type KeyStatus = 'loading' | 'none' | 'saved' | 'removed' | 'error'

function ApiKeySection() {
  const [apiKey, setApiKey]       = useState('')
  const [status, setStatus]       = useState<KeyStatus>('loading')
  const [encrypted, setEncrypted] = useState(false)
  const [busy, setBusy]           = useState(false)

  useEffect(() => {
    window.latch?.hasSetting?.({ key: 'openai-api-key' }).then((res) => {
      if (res?.ok && res.exists) {
        setStatus('saved')
        setEncrypted(res.encrypted)
      } else {
        setStatus('none')
      }
    })
  }, [])

  const handleSave = async () => {
    if (!apiKey.trim()) return
    setBusy(true)
    const res = await window.latch?.setSetting?.({ key: 'openai-api-key', value: apiKey.trim(), sensitive: true })
    setBusy(false)
    if (res?.ok) {
      setApiKey('')
      setStatus('saved')
      const check = await window.latch?.hasSetting?.({ key: 'openai-api-key' })
      setEncrypted(check?.encrypted ?? false)
    } else {
      setStatus('error')
    }
  }

  const handleRemove = async () => {
    setBusy(true)
    await window.latch?.deleteSetting?.({ key: 'openai-api-key' })
    setBusy(false)
    setApiKey('')
    setStatus('removed')
    setEncrypted(false)
    setTimeout(() => setStatus('none'), 2000)
  }

  const statusLabel = (): string => {
    switch (status) {
      case 'loading': return 'Checking...'
      case 'saved':   return encrypted ? 'Stored (encrypted)' : 'Stored (plaintext)'
      case 'removed': return 'Key removed'
      case 'error':   return 'Failed to save'
      case 'none':
      default:        return 'Not configured'
    }
  }

  return (
    <div className="panel-card">
      <div className="panel-title">OpenAI</div>
      <div className="panel-meta">Used for AI policy generation and session title suggestions.</div>

      <div className="providers-key-row">
        <input
          type="password"
          className="wizard-input"
          placeholder={status === 'saved' ? 'sk-••••••••••••' : 'sk-...'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          disabled={busy}
          style={{ flex: 1 }}
        />
        <button
          className="panel-action is-primary"
          onClick={handleSave}
          disabled={busy || !apiKey.trim()}
        >
          Save
        </button>
      </div>

      <div className="providers-status-row">
        <span className={`providers-status ${status === 'saved' ? 'is-ok' : status === 'error' ? 'is-err' : ''}`}>
          {statusLabel()}
        </span>
        {status === 'saved' && (
          <button
            className="panel-action is-danger"
            onClick={handleRemove}
            disabled={busy}
            style={{ marginTop: 0, padding: '2px 8px', fontSize: 11 }}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  )
}

// ─── 1Password section ───────────────────────────────────────────────────────

function OnePasswordSection() {
  const [status, setStatus] = useState<{ available: boolean; connected: boolean; appInstalled: boolean; cliInstalled: boolean }>({
    available: false, connected: false, appInstalled: false, cliInstalled: false,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    window.latch?.opStatus?.().then((s: any) => {
      if (s) setStatus(s)
      setLoaded(true)
    })
  }, [])

  const handleConnect = async () => {
    setBusy(true)
    setError('')
    const result = await window.latch?.opConnect?.()
    setBusy(false)
    if (result?.ok) {
      setStatus(prev => ({ ...prev, available: true, connected: true }))
    } else {
      setError(result?.error ?? 'Connection failed')
    }
  }

  const handleDisconnect = async () => {
    setBusy(true)
    await window.latch?.opDisconnect?.()
    setBusy(false)
    setStatus(prev => ({ ...prev, connected: false }))
  }

  if (!loaded) return null

  // Not installed at all
  if (!status.appInstalled && !status.cliInstalled) {
    return (
      <div className="panel-card">
        <div className="panel-title">1Password</div>
        <div className="panel-meta">
          Connect to 1Password to use existing credentials for services.
        </div>
        <div style={{ marginTop: 12, padding: '8px 10px', borderRadius: 4, background: 'var(--bg-elevated)', fontSize: 12, color: 'var(--text-secondary)' }}>
          1Password not detected. Install{' '}
          <a
            href="#"
            style={{ color: 'var(--accent)' }}
            onClick={(e) => { e.preventDefault(); window.latch?.openExternal?.('https://1password.com/downloads') }}
          >
            1Password 8+
          </a>
          {' '}to enable this integration.
        </div>
      </div>
    )
  }

  // App installed but CLI not found
  if (status.appInstalled && !status.cliInstalled) {
    return (
      <div className="panel-card">
        <div className="panel-title">1Password</div>
        <div className="panel-meta">
          Connect to 1Password to use existing credentials for services.
        </div>
        <div style={{ marginTop: 12, padding: '8px 10px', borderRadius: 4, background: 'var(--bg-elevated)', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          1Password app detected, but the CLI tool is needed:
          <ol style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }}>
            <li>Open <strong>1Password → Settings → Developer</strong></li>
            <li>Turn on <strong>"Integrate with 1Password CLI"</strong></li>
            <li>If not prompted to install, run: <code style={{ background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 3 }}>brew install --cask 1password-cli</code></li>
          </ol>
        </div>
      </div>
    )
  }

  // CLI available — show connect/disconnect
  return (
    <div className="panel-card">
      <div className="panel-title">1Password</div>
      <div className="panel-meta">
        Connect to 1Password to use existing credentials for services.
        Secrets stay managed in 1Password — Latch stores only a reference.
      </div>

      <div className="providers-status-row" style={{ marginTop: 12 }}>
        <span className={`providers-status ${status.connected ? 'is-ok' : ''}`}>
          {status.connected ? 'Connected' : 'Not connected'}
        </span>
        {status.connected ? (
          <button
            className="panel-action is-danger"
            onClick={handleDisconnect}
            disabled={busy}
            style={{ marginTop: 0, padding: '2px 8px', fontSize: 11 }}
          >
            Disconnect
          </button>
        ) : (
          <button
            className="panel-action is-primary"
            onClick={handleConnect}
            disabled={busy}
            style={{ marginTop: 0, padding: '4px 12px', fontSize: 12 }}
          >
            {busy ? 'Connecting...' : 'Connect'}
          </button>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--red)' }}>{error}</div>
      )}
    </div>
  )
}

// ─── Sandbox section ─────────────────────────────────────────────────────────

function SandboxSection() {
  const sandboxEnabled = useAppStore((s) => s.sandboxEnabled)
  const defaultDockerImage = useAppStore((s) => s.defaultDockerImage)
  const dockerAvailable = useAppStore((s) => s.dockerAvailable)
  const setSandboxEnabled = useAppStore((s) => s.setSandboxEnabled)
  const setDefaultDockerImage = useAppStore((s) => s.setDefaultDockerImage)

  return (
    <>
      <div className="view-section-label">Sandbox</div>
      <div className="panel-card">
        <div className="settings-toggles">
          <Toggle
            on={sandboxEnabled}
            onChange={setSandboxEnabled}
            label="Sandbox sessions"
            description="Run agent sessions inside Docker containers for isolation. New sessions automatically start sandboxed."
          />
        </div>

        <div style={{ marginTop: 12 }}>
          <label className="cp-toggle-text" style={{ fontSize: 12, marginBottom: 4, display: 'block' }}>Default base image</label>
          <select
            className="modal-input"
            value={defaultDockerImage}
            onChange={(e) => setDefaultDockerImage(e.target.value)}
            style={{ width: '100%', maxWidth: 240 }}
          >
            {DOCKER_IMAGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <div className="settings-toggle-desc" style={{ marginTop: 4 }}>
            Latch auto-detects from your project when possible.
          </div>
        </div>

        {!dockerAvailable && (
          <div style={{ marginTop: 12, padding: '8px 10px', borderRadius: 4, background: 'var(--bg-elevated)', fontSize: 12, color: 'var(--text-secondary)' }}>
            Docker not detected. Install{' '}
            <a
              href="#"
              style={{ color: 'var(--accent)' }}
              onClick={(e) => { e.preventDefault(); window.latch?.openExternal?.('https://www.docker.com/products/docker-desktop/') }}
            >
              Docker Desktop
            </a>
            {' '}to enable sandboxed sessions.
          </div>
        )}
      </div>
    </>
  )
}

// ─── Budget section ─────────────────────────────────────────────────────────

function BudgetSection() {
  const [sessionBudget, setSessionBudget] = useState('')
  const [projectBudget, setProjectBudget] = useState('')
  const [sloCost, setSloCost] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const load = async () => {
      const [sb, pb, slo] = await Promise.all([
        window.latch?.getSetting?.({ key: 'default-session-budget' }),
        window.latch?.getSetting?.({ key: 'daily-project-budget' }),
        window.latch?.getSetting?.({ key: 'slo-session-cost-p95' }),
      ])
      if (sb?.ok && sb.value) setSessionBudget(sb.value)
      if (pb?.ok && pb.value) setProjectBudget(pb.value)
      if (slo?.ok && slo.value) setSloCost(slo.value)
      setLoaded(true)
    }
    load()
  }, [])

  const handleSave = async () => {
    const saves: Promise<any>[] = []
    if (sessionBudget.trim()) {
      saves.push(window.latch?.setSetting?.({ key: 'default-session-budget', value: sessionBudget.trim() }))
    } else {
      saves.push(window.latch?.deleteSetting?.({ key: 'default-session-budget' }))
    }
    if (projectBudget.trim()) {
      saves.push(window.latch?.setSetting?.({ key: 'daily-project-budget', value: projectBudget.trim() }))
    } else {
      saves.push(window.latch?.deleteSetting?.({ key: 'daily-project-budget' }))
    }
    if (sloCost.trim()) {
      saves.push(window.latch?.setSetting?.({ key: 'slo-session-cost-p95', value: sloCost.trim() }))
    } else {
      saves.push(window.latch?.deleteSetting?.({ key: 'slo-session-cost-p95' }))
    }
    await Promise.all(saves)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  if (!loaded) return null

  return (
    <div className="panel-card">
      <div className="budget-field">
        <label className="cp-toggle-text" style={{ fontSize: 12, marginBottom: 4, display: 'block' }}>
          Default session budget (USD)
        </label>
        <input
          type="number"
          className="wizard-input"
          placeholder="e.g. 10"
          value={sessionBudget}
          onChange={(e) => setSessionBudget(e.target.value)}
          min="0"
          step="0.5"
          style={{ maxWidth: 160 }}
        />
        <div className="settings-toggle-desc">
          Maximum spend per session. Leave blank for no limit. Can be overridden per session.
        </div>
      </div>

      <div className="budget-field" style={{ marginTop: 16 }}>
        <label className="cp-toggle-text" style={{ fontSize: 12, marginBottom: 4, display: 'block' }}>
          Daily project budget (USD)
        </label>
        <input
          type="number"
          className="wizard-input"
          placeholder="e.g. 50"
          value={projectBudget}
          onChange={(e) => setProjectBudget(e.target.value)}
          min="0"
          step="1"
          style={{ maxWidth: 160 }}
        />
        <div className="settings-toggle-desc">
          Maximum spend per project per day across all sessions.
        </div>
      </div>

      <div className="budget-field" style={{ marginTop: 16 }}>
        <label className="cp-toggle-text" style={{ fontSize: 12, marginBottom: 4, display: 'block' }}>
          SLO: 95th percentile session cost (USD)
        </label>
        <input
          type="number"
          className="wizard-input"
          placeholder="e.g. 8"
          value={sloCost}
          onChange={(e) => setSloCost(e.target.value)}
          min="0"
          step="0.5"
          style={{ maxWidth: 160 }}
        />
        <div className="settings-toggle-desc">
          Target P95 session cost. Triggers a Radar signal when breached.
        </div>
      </div>

      <button
        className="panel-action is-primary"
        onClick={handleSave}
        style={{ marginTop: 16 }}
      >
        {saved ? 'Saved!' : 'Save budgets'}
      </button>
    </div>
  )
}

// ─── SettingsPanel ───────────────────────────────────────────────────────────

export default function SettingsPanel() {
  const [autoAccept, setAutoAccept]       = useState(true)
  const [notifications, setNotifications] = useState(true)
  const [telemetry, setTelemetry]         = useState(false)
  const [loaded, setLoaded]               = useState(false)

  const soundNotifications = useAppStore((s) => s.soundNotifications)

  // Load saved toggle states on mount
  useEffect(() => {
    const load = async () => {
      const [aa, notif, tel] = await Promise.all([
        window.latch?.getSetting?.({ key: 'auto-accept' }),
        window.latch?.getSetting?.({ key: 'notifications-enabled' }),
        window.latch?.getSetting?.({ key: 'telemetry-enabled' }),
      ])
      // Default: auto-accept ON, notifications ON, telemetry OFF
      if (aa?.ok && aa.value !== null) setAutoAccept(aa.value === 'true')
      if (notif?.ok && notif.value !== null) setNotifications(notif.value === 'true')
      if (tel?.ok && tel.value !== null) setTelemetry(tel.value === 'true')
      setLoaded(true)
    }
    load()
  }, [])

  const handleToggle = async (key: string, value: boolean, setter: (v: boolean) => void) => {
    setter(value)
    await window.latch?.setSetting?.({ key, value: String(value) })
  }

  const handleSoundToggle = async (value: boolean) => {
    useAppStore.setState({ soundNotifications: value })
    await window.latch?.setSetting?.({ key: 'sound-notifications', value: String(value) })
  }

  if (!loaded) return null

  return (
    <div className="view-container" id="settings-view">
      <div className="view-header">
        <div>
          <h2 className="view-title">Settings</h2>
          <p className="view-subtitle">Configure model providers and application preferences.</p>
        </div>
      </div>

      {/* ── Appearance ──────────────────────────────────────────── */}
      <div className="view-section-label">Appearance</div>
      <AppearanceSection />

      {/* ── Model Providers ─────────────────────────────────────── */}
      <div className="view-section-label">Model Providers</div>
      <ApiKeySection />

      {/* ── 1Password ───────────────────────────────────────────── */}
      <div className="view-section-label">1Password</div>
      <OnePasswordSection />

      {/* ── Sandbox ──────────────────────────────────────────────── */}
      <SandboxSection />

      {/* ── Budgets ──────────────────────────────────────────────── */}
      <div className="view-section-label">Budgets</div>
      <BudgetSection />

      {/* ── General ─────────────────────────────────────────────── */}
      <div className="view-section-label">General</div>
      <div className="panel-card">
        <div className="settings-toggles">
          <Toggle
            on={autoAccept}
            onChange={(v) => handleToggle('auto-accept', v, setAutoAccept)}
            label="Auto-accept"
            description="Automatically approve tool calls from harnesses."
          />
          <Toggle
            on={notifications}
            onChange={(v) => handleToggle('notifications-enabled', v, setNotifications)}
            label="Notifications"
            description="Show a system notification when a task completes."
          />
          <Toggle
            on={soundNotifications}
            onChange={handleSoundToggle}
            label="Sound notifications"
            description="Play an audible beep when a tool call needs approval."
          />
          <Toggle
            on={telemetry}
            onChange={(v) => handleToggle('telemetry-enabled', v, setTelemetry)}
            label="Anonymous telemetry"
            description="Send anonymous usage data to help improve Latch. No personal data is collected."
          />
        </div>
      </div>
    </div>
  )
}
