/**
 * @module VaultPanel
 * @description Rail panel for managing vault secrets (encrypted credentials).
 * Lists secret metadata — raw values never reach the renderer.
 */

import React, { useEffect } from 'react'
import { useAppStore } from '../../store/useAppStore'

export default function VaultPanel() {
  const {
    secrets,
    loadSecrets,
    openSecretEditor,
    deleteSecret,
  } = useAppStore()

  useEffect(() => {
    loadSecrets()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleDelete = async (id: string) => {
    const secret = secrets.find((s) => s.id === id)
    const name = secret?.name ?? id
    if (!window.confirm(`Delete secret "${name}"? This cannot be undone.`)) return
    await deleteSecret(id)
  }

  return (
    <div className="rail-panel" id="rail-panel-vault">
      <div className="section-label">Secrets Vault</div>

      <div className="vault-list">
        {secrets.length === 0 && (
          <div className="vault-empty">No secrets stored yet.</div>
        )}
        {secrets.map((secret) => (
          <div key={secret.id} className="vault-card">
            <div className="panel-title">{secret.name}</div>
            <div className="vault-key">{secret.key}</div>
            {secret.tags.length > 0 && (
              <div className="vault-tags">
                {secret.tags.map((tag) => (
                  <span key={tag} className="vault-tag">{tag}</span>
                ))}
              </div>
            )}
            <div className="panel-actions-row">
              <button className="panel-action" onClick={() => openSecretEditor(secret)}>
                Edit
              </button>
              <button className="panel-action is-danger" onClick={() => handleDelete(secret.id)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      <button className="panel-action" onClick={() => openSecretEditor(null)}>
        Add Secret
      </button>

      <div className="vault-hint">
        Reference secrets in MCP env vars as <code>{'${secret:KEY}'}</code>
      </div>
    </div>
  )
}
