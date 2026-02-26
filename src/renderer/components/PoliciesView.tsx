import React, { useEffect } from 'react'
import { ShieldCheck } from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'
import type { PolicyDocument } from '../../types'

function PermDots({ policy }: { policy: PolicyDocument }) {
  const p = policy.permissions
  if (!p) return null

  const items = [
    { label: 'Bash',    on: p.allowBash },
    { label: 'Network', on: p.allowNetwork },
    { label: 'Writes',  on: p.allowFileWrite },
    { label: 'Confirm', on: p.confirmDestructive },
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

export default function PoliciesView() {
  const {
    activeSessionId,
    sessions,
    policies,
    policiesLoaded,
    loadPolicies,
    loadPolicyPanel,
    openPolicyEditor,
    setActiveView,
  } = useAppStore()

  useEffect(() => {
    if (!policiesLoaded) loadPolicies()
    loadPolicyPanel()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const session = activeSessionId ? sessions.get(activeSessionId) : undefined

  const handleNewPolicy = () => setActiveView('create-policy')

  const handleEditPolicy = (policy: PolicyDocument) => openPolicyEditor(policy, false)

  const handleDeletePolicy = async (id: string) => {
    const policy = policies.find((p) => p.id === id)
    const name = policy?.name ?? id
    if (!window.confirm(`Delete policy "${name}"? This cannot be undone.`)) return
    await window.latch?.deletePolicy?.({ id })
    await loadPolicies()
    await loadPolicyPanel()
  }

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h2 className="view-title">Policies</h2>
          <p className="view-subtitle">Configure permissions and guardrails for your AI agents.</p>
        </div>
        <button className="view-action-btn" onClick={handleNewPolicy}>
          + New Policy
        </button>
      </div>

      {/* ── Policy list ──────────────────────────────────────────── */}
      {policies.length === 0 ? (
        <div className="policies-empty">
          <div className="policies-empty-icon">
            <ShieldCheck size={40} weight="light" />
          </div>
          <div className="policies-empty-text">No policies yet</div>
          <div className="policies-empty-hint">
            Create your first policy to define what your AI agents can and cannot do.
          </div>
          <button className="cp-generate-btn" onClick={handleNewPolicy}>
            + New Policy
          </button>
        </div>
      ) : (
        <div className="policies-list">
          {policies.map((policy) => (
            <div
              key={policy.id}
              className={`policy-list-item${session?.policyId === policy.id ? ' is-active' : ''}`}
            >
              <div className="policy-list-left">
                <div className="policy-list-name">
                  {policy.name}
                  {session?.policyId === policy.id && (
                    <span className="policy-active-badge">Active</span>
                  )}
                </div>
                <div className="policy-list-desc">{policy.description}</div>
              </div>
              <div className="policy-list-right">
                <PermDots policy={policy} />
                <div className="policy-list-actions">
                  <button className="panel-action" onClick={() => handleEditPolicy(policy)}>
                    Edit
                  </button>
                  <button className="panel-action is-danger" onClick={() => handleDeletePolicy(policy.id)}>
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
