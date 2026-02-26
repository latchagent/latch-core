import React, { useState, useEffect } from 'react'
import { useAppStore } from '../../store/useAppStore'
import type { PolicyDocument } from '../../../types'

const SEED_IDS = new Set(['default', 'strict', 'read-only'])

// ─── Permission indicators (dots) ────────────────────────────────────────────

function PermIndicators({ policy }: { policy: PolicyDocument | null }) {
  if (!policy?.permissions) return null

  const p = policy.permissions
  const items = [
    { label: 'Bash',    on: p.allowBash           },
    { label: 'Network', on: p.allowNetwork         },
    { label: 'Writes',  on: p.allowFileWrite       },
    { label: 'Confirm', on: p.confirmDestructive   },
  ]

  return (
    <div className="panel-perm-list">
      {items.map(({ label, on }) => (
        <span key={label} className={`perm-badge ${on ? 'is-on' : 'is-off'}`}>
          {label}
        </span>
      ))}
    </div>
  )
}

// ─── PolicyPanel ─────────────────────────────────────────────────────────────

export default function PolicyPanel() {
  const {
    activeSessionId,
    sessions,
    policies,
    policiesLoaded,
    activePolicyDoc,
    policyGenerating,
    loadPolicies,
    loadPolicyPanel,
    openPolicyEditor,
    clearSessionOverride,
    generatePolicy,
  } = useAppStore()

  const [genPrompt, setGenPrompt] = useState('')

  useEffect(() => {
    loadPolicyPanel()
    if (!policiesLoaded) loadPolicies()
  }, [activeSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  const session  = activeSessionId ? sessions.get(activeSessionId) : undefined
  const override = session?.policyOverride ?? null

  const handleNewPolicy = () => {
    openPolicyEditor(null, false)
  }

  const handleEditPolicy = (policy: PolicyDocument) => {
    openPolicyEditor(policy, false)
  }

  const handleDeletePolicy = async (id: string) => {
    const policy = policies.find((p) => p.id === id)
    const name = policy?.name ?? id
    if (!window.confirm(`Delete policy "${name}"? This cannot be undone.`)) return
    await window.latch?.deletePolicy?.({ id })
    await loadPolicies()
    await loadPolicyPanel()
  }

  const handleCreateOverride = () => {
    const base = activePolicyDoc
      ? { ...activePolicyDoc, name: 'Session Override', id: '__override__' }
      : null
    openPolicyEditor(base, true)
  }

  const handleGenerate = () => {
    if (!genPrompt.trim() || policyGenerating) return
    generatePolicy(genPrompt.trim())
    setGenPrompt('')
  }

  const handleGenKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleGenerate()
    }
  }

  return (
    <div className="rail-panel" id="rail-panel-policy">
      {/* ── Policy list ────────────────────────────────────────────── */}
      <div className="section-label">Policies</div>

      <div className="policy-list">
        {policies.map((policy) => (
          <div
            key={policy.id}
            className={`policy-list-item${session?.policyId === policy.id ? ' is-active' : ''}`}
          >
            <div className="panel-title">{policy.name}</div>
            <div className="panel-meta">{policy.description}</div>
            <PermIndicators policy={policy} />
            <div className="panel-actions-row">
              <button className="panel-action" onClick={() => handleEditPolicy(policy)}>
                Edit
              </button>
              {!SEED_IDS.has(policy.id) && (
                <button className="panel-action is-danger" onClick={() => handleDeletePolicy(policy.id)}>
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <button className="panel-action" onClick={handleNewPolicy}>
        New Policy
      </button>

      {/* ── Session Override ───────────────────────────────────────────── */}
      <div className="section-label">Session Override</div>
      <div className="panel-card" id="override-card">
        <div className="panel-title">{override?.name ?? 'None'}</div>
        <div className="panel-meta">
          {override ? 'Ephemeral override active' : 'No ephemeral override'}
        </div>
        {override && <PermIndicators policy={override} />}
        <div className="panel-actions-row">
          <button className="panel-action" onClick={handleCreateOverride}>
            {override ? 'Edit Override' : 'Create Override'}
          </button>
          {override && (
            <button className="panel-action is-danger" onClick={clearSessionOverride}>
              Clear
            </button>
          )}
        </div>
      </div>

      {/* ── AI Policy Generator ────────────────────────────────────── */}
      <div className="section-label">Generate Policy</div>
      <div className="policy-gen-row">
        <input
          className="wizard-input"
          placeholder="Describe a policy..."
          value={genPrompt}
          onChange={(e) => setGenPrompt(e.target.value)}
          onKeyDown={handleGenKeyDown}
          disabled={policyGenerating}
        />
        <button
          className="panel-action is-primary"
          onClick={handleGenerate}
          disabled={policyGenerating || !genPrompt.trim()}
          style={{ marginTop: 0 }}
        >
          {policyGenerating ? 'Generating...' : 'Generate'}
        </button>
      </div>
      <div className="policy-gen-hint">
        Describe what the policy should allow or restrict.
      </div>
    </div>
  )
}
