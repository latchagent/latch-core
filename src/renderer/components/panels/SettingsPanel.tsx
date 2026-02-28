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

// ─── Sandbox section ─────────────────────────────────────────────────────────

function SandboxSection() {
  const sandboxEnabled = useAppStore((s) => s.sandboxEnabled)
  const defaultDockerImage = useAppStore((s) => s.defaultDockerImage)
  const dockerAvailable = useAppStore((s) => s.dockerAvailable)
  const setSandboxEnabled = useAppStore((s) => s.setSandboxEnabled)
  const setDefaultDockerImage = useAppStore((s) => s.setDefaultDockerImage)

  return (
    <>
      <div className="section-label" style={{ marginTop: 20, marginBottom: 8 }}>Sandbox</div>
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

      {/* ── Model Providers ─────────────────────────────────────── */}
      <div className="section-label" style={{ marginBottom: 8 }}>Model Providers</div>
      <ApiKeySection />

      {/* ── Sandbox ──────────────────────────────────────────────── */}
      <SandboxSection />

      {/* ── General ─────────────────────────────────────────────── */}
      <div className="section-label" style={{ marginTop: 20, marginBottom: 8 }}>General</div>
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
