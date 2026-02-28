/**
 * @module VaultView
 * @description Top-level view for managing vault secrets (encrypted credentials).
 * Follows the McpView pattern: header + search bar + card grid.
 * Replaces the rail-based VaultPanel for global access.
 */

import React, { useEffect, useState, useMemo } from 'react'
import { MagnifyingGlass } from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'

export default function VaultView() {
  const {
    secrets,
    loadSecrets,
    openSecretEditor,
    deleteSecret,
  } = useAppStore()

  const [search, setSearch] = useState('')
  useEffect(() => { loadSecrets() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const query = search.toLowerCase().trim()

  const filtered = useMemo(() => {
    if (!query) return secrets
    return secrets.filter((s) =>
      s.name.toLowerCase().includes(query) ||
      s.key.toLowerCase().includes(query) ||
      s.description?.toLowerCase().includes(query) ||
      s.tags?.some((t) => t.toLowerCase().includes(query))
    )
  }, [secrets, query])

  const handleDelete = async (id: string) => {
    const secret = secrets.find((s) => s.id === id)
    const name = secret?.name ?? id
    if (!window.confirm(`Delete secret "${name}"? This cannot be undone.`)) return
    await deleteSecret(id)
  }

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h2 className="view-title">Secrets Vault</h2>
          <p className="view-subtitle">Manage encrypted credentials for MCP servers and agent sessions.</p>
        </div>
        <button className="view-action-btn" onClick={() => openSecretEditor(null)}>
          + Add Secret
        </button>
      </div>

      {/* ── Search bar ─────────────────────────────────────────── */}
      <div className="skills-toolbar">
        <div className="skills-search-wrapper">
          <MagnifyingGlass className="skills-search-icon" size={14} weight="light" />
          <input
            className="skills-search-input"
            type="text"
            placeholder="Search secrets..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* ── Info banner ────────────────────────────────────────── */}
      <div className="skills-info-banner">
        <p>Secrets are encrypted at rest and injected at runtime. Reference them in MCP server env vars as <code>{'${secret:KEY}'}</code>. Raw values never leave the main process.</p>
      </div>

      {/* ── Secrets grid ───────────────────────────────────────── */}
      <div className="skills-section">
        <div className="skills-section-header">
          <div className="skills-section-label">Secrets</div>
          <span className="skills-section-count">{filtered.length}</span>
        </div>
        {filtered.length === 0 ? (
          <div className="panel-empty" style={{ padding: '16px 0' }}>
            {query ? 'No secrets match your search.' : 'No secrets stored yet. Add one to get started.'}
          </div>
        ) : (
          <div className="skills-catalog-grid">
            {filtered.map((secret) => (
              <div key={secret.id} className="skill-catalog-card vault-view-card">
                <div className="skill-catalog-content">
                  <div className="skill-catalog-name">{secret.name}</div>
                  <code className="vault-view-key">{secret.key}</code>
                  {secret.description && (
                    <div className="vault-view-desc">{secret.description}</div>
                  )}
                  {secret.tags.length > 0 && (
                    <div className="vault-tags" style={{ marginTop: 6 }}>
                      {secret.tags.map((tag) => (
                        <span key={tag} className="vault-tag">{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="skill-catalog-actions">
                  <button className="skill-card-btn" onClick={() => openSecretEditor(secret)} title="Edit">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button className="skill-card-btn is-danger" onClick={() => handleDelete(secret.id)} title="Delete">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3,6 5,6 21,6" />
                      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
