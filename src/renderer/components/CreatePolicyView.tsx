import React, { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { PolicyDocument, PolicyPermissions } from '../../types'
import { POLICY_PRESETS } from '../data/policy-presets'
import type { PolicyPreset } from '../data/policy-presets'

const DEFAULT_PERMS: PolicyPermissions = {
  allowBash:          true,
  allowNetwork:       true,
  allowFileWrite:     true,
  confirmDestructive: true,
  blockedGlobs:       [],
}

type Phase = 'describe' | 'review'

export default function CreatePolicyView() {
  const { loadPolicies, setActiveView } = useAppStore()

  const [phase, setPhase]         = useState<Phase>('describe')
  const [prompt, setPrompt]       = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError]         = useState<string | null>(null)

  // Review-phase form state
  const [name, setName]   = useState('')
  const [desc, setDesc]   = useState('')
  const [perms, setPerms] = useState<PolicyPermissions>(DEFAULT_PERMS)
  const [globs, setGlobs] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const handleGenerate = async () => {
    if (!prompt.trim() || generating) return
    setGenerating(true)
    setError(null)
    try {
      const result = await window.latch?.generatePolicy?.({ prompt: prompt.trim() })
      if (result?.ok && result.policy) {
        const p = result.policy
        setName(p.name ?? '')
        setDesc(p.description ?? '')
        setPerms(p.permissions ?? DEFAULT_PERMS)
        setGlobs(p.permissions?.blockedGlobs ?? [])
        setPhase('review')
      } else {
        setError(result?.error ?? 'Generation failed. Please try again.')
      }
    } catch {
      setError('Generation failed. Please try again.')
    } finally {
      setGenerating(false)
    }
  }

  const handleSave = async () => {
    if (saving) return
    setSaving(true)
    const policy: PolicyDocument = {
      id:          `policy-${Date.now()}`,
      name:        name.trim() || 'Untitled Policy',
      description: desc.trim(),
      permissions: { ...perms, blockedGlobs: globs.filter(Boolean) },
      harnesses:   {},
    }
    try {
      await window.latch?.savePolicy?.(policy)
      await loadPolicies()
      setActiveView('policies')
    } finally {
      setSaving(false)
    }
  }

  const updatePerm = (key: keyof Omit<PolicyPermissions, 'blockedGlobs' | 'commandRules'>, val: boolean) => {
    setPerms((p) => ({ ...p, [key]: val }))
  }

  const addGlob    = () => setGlobs((g) => [...g, ''])
  const setGlob    = (i: number, v: string) => setGlobs((g) => g.map((x, j) => j === i ? v : x))
  const removeGlob = (i: number) => setGlobs((g) => g.filter((_, j) => j !== i))

  const handlePreset = (preset: PolicyPreset) => {
    setName('')
    setDesc(preset.description)
    setPerms(preset.permissions)
    setGlobs(preset.permissions.blockedGlobs ?? [])
    setPhase('review')
  }

  const handleBack = () => {
    if (phase === 'review') {
      setPhase('describe')
    } else {
      setActiveView('policies')
    }
  }

  return (
    <div className="view-container">
      <div className="cp-back-row">
        <button className="cp-back-btn" onClick={handleBack}>
          ← {phase === 'review' ? 'Regenerate' : 'Policies'}
        </button>
      </div>

      <div className="cp-page">
        {phase === 'describe' ? (
          <>
            <h2 className="cp-title">Create a Policy</h2>
            <p className="cp-subtitle">
              Start from a preset or describe what this policy should allow or restrict.
            </p>

            <div className="preset-cards">
              {POLICY_PRESETS.map((preset) => (
                <div key={preset.name} className="preset-card" onClick={() => handlePreset(preset)}>
                  <div className="preset-card-name">{preset.name}</div>
                  <div className="preset-card-desc">{preset.description}</div>
                  <button className="preset-card-btn" type="button">Use</button>
                </div>
              ))}
            </div>

            <div className="cp-section-label" style={{ marginTop: 16, marginBottom: 8 }}>Or describe your policy</div>

            <textarea
              className="cp-textarea"
              placeholder="e.g. Allow all standard operations but block network access and sensitive paths like ~/.ssh and ~/.aws"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              disabled={generating}
              autoFocus
            />

            {error && <div className="cp-error">{error}</div>}

            <div className="cp-actions">
              <button className="cp-cancel" onClick={() => setActiveView('policies')}>
                Cancel
              </button>
              <button
                className="cp-generate-btn"
                onClick={handleGenerate}
                disabled={generating || !prompt.trim()}
              >
                {generating ? 'Generating...' : 'Generate Policy'}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="cp-title">Review Policy</h2>
            <p className="cp-subtitle">
              We generated these settings from your description. Edit anything before saving.
            </p>

            <div className="cp-form">
              <label className="cp-label">Name</label>
              <input
                className="cp-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Policy name"
              />

              <label className="cp-label">Description</label>
              <input
                className="cp-input"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="Optional description"
              />

              <div className="cp-section-label">Permissions</div>
              <div className="cp-toggles">
                {(
                  [
                    ['Allow shell / bash commands', 'allowBash'],
                    ['Allow network access',        'allowNetwork'],
                    ['Allow file writes',           'allowFileWrite'],
                    ['Confirm destructive ops',     'confirmDestructive'],
                  ] as [string, keyof Omit<PolicyPermissions, 'blockedGlobs' | 'commandRules'>][]
                ).map(([label, key]) => (
                  <label key={key} className="cp-toggle">
                    <div className={`cp-switch ${perms[key] ? 'is-on' : ''}`}>
                      <div className="cp-switch-thumb" />
                    </div>
                    <span className="cp-toggle-text">{label}</span>
                    <input
                      type="checkbox"
                      checked={perms[key]}
                      onChange={(e) => updatePerm(key, e.target.checked)}
                      style={{ display: 'none' }}
                    />
                  </label>
                ))}
              </div>

              <div className="cp-section-label">Blocked Paths</div>
              <div className="cp-globs">
                {globs.map((g, i) => (
                  <div key={i} className="cp-glob-row">
                    <input
                      className="cp-input"
                      type="text"
                      placeholder="/etc/** or ~/.ssh/**"
                      value={g}
                      onChange={(e) => setGlob(i, e.target.value)}
                    />
                    <button className="cp-glob-remove" onClick={() => removeGlob(i)}>x</button>
                  </div>
                ))}
                <button className="cp-add-glob" onClick={addGlob}>+ Add path</button>
              </div>
            </div>

            <div className="cp-actions">
              <button className="cp-cancel" onClick={handleBack}>Back</button>
              <button
                className="cp-generate-btn"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save Policy'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
