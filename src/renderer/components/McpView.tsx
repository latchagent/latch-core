/**
 * @module McpView
 * @description Top-level view for managing MCP servers.
 * Follows the SkillsView pattern: search bar, sync dropdown, installed + catalog grid.
 */

import React, { useEffect, useRef, useState, useMemo } from 'react'
import { ArrowsClockwise, CaretDown, MagnifyingGlass } from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'
import { MCP_CATALOG } from '../data/mcp-catalog'
import type { McpServerRecord } from '../../types'

function McpSyncDropdown() {
  const { harnesses } = useAppStore()
  const installed = harnesses.filter((h) => h.installed)
  const [open, setOpen] = useState(false)
  const [syncStates, setSyncStates] = useState<Record<string, 'idle' | 'syncing' | 'ok' | 'err'>>({})
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleSync = async (harnessId: string) => {
    setSyncStates((s) => ({ ...s, [harnessId]: 'syncing' }))
    const result = await window.latch?.syncMcpServers?.({ harnessId })
    setSyncStates((s) => ({ ...s, [harnessId]: result?.ok ? 'ok' : 'err' }))
    setTimeout(() => setSyncStates((s) => ({ ...s, [harnessId]: 'idle' })), 2500)
  }

  const handleSyncAll = async () => {
    for (const h of installed) {
      await handleSync(h.id)
    }
  }

  const anySyncing = Object.values(syncStates).some((s) => s === 'syncing')

  return (
    <div className="sync-dropdown" ref={ref}>
      <button
        className="sync-dropdown-trigger"
        onClick={() => setOpen(!open)}
        disabled={!installed.length}
        title={!installed.length ? 'No harnesses detected' : 'Sync MCP servers to harnesses'}
      >
        <ArrowsClockwise size={14} weight="light" />
        Sync
        <CaretDown className="sync-dropdown-chevron" size={10} weight="light" />
      </button>
      {open && (
        <div className="sync-dropdown-menu">
          {installed.length > 1 && (
            <button
              className="sync-dropdown-item"
              onClick={handleSyncAll}
              disabled={anySyncing}
            >
              <span>Sync All</span>
              <span className="sync-dropdown-hint">{installed.length} harnesses</span>
            </button>
          )}
          {installed.map((h) => {
            const state = syncStates[h.id] ?? 'idle'
            return (
              <button
                key={h.id}
                className={`sync-dropdown-item${state !== 'idle' ? ` is-${state}` : ''}`}
                onClick={() => handleSync(h.id)}
                disabled={state === 'syncing'}
              >
                <span>{h.label}</span>
                {state === 'syncing' && <span className="sync-dropdown-status">Syncing...</span>}
                {state === 'ok'      && <span className="sync-dropdown-status is-ok">Done</span>}
                {state === 'err'     && <span className="sync-dropdown-status is-err">Failed</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function McpView() {
  const {
    mcpServers,
    loadMcpServers,
    openMcpEditor,
    deleteMcpServer,
    saveMcpServer,
    openMcpDetail,
    mcpInstallFlash,
  } = useAppStore()

  const [search, setSearch] = useState('')
  useEffect(() => { loadMcpServers() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const installedIds = useMemo(() => new Set(mcpServers.map((s) => s.id)), [mcpServers])

  const query = search.toLowerCase().trim()

  const filteredInstalled = useMemo(() => {
    if (!query) return mcpServers
    return mcpServers.filter((s) =>
      s.name.toLowerCase().includes(query) ||
      s.description?.toLowerCase().includes(query) ||
      s.tags?.some((t) => t.toLowerCase().includes(query))
    )
  }, [mcpServers, query])

  const filteredCatalog = useMemo(() => {
    const available = MCP_CATALOG.filter((s) => !installedIds.has(s.id))
    if (!query) return available
    return available.filter((s) =>
      s.name.toLowerCase().includes(query) ||
      s.description.toLowerCase().includes(query) ||
      s.tags.some((t) => t.toLowerCase().includes(query))
    )
  }, [installedIds, query])

  const handleDelete = async (server: McpServerRecord) => {
    if (!confirm(`Remove MCP server "${server.name}"?`)) return
    await deleteMcpServer(server.id)
  }

  const handleInstall = async (catalogServer: typeof MCP_CATALOG[number]) => {
    await saveMcpServer({
      id: catalogServer.id,
      name: catalogServer.name,
      description: catalogServer.description,
      transport: catalogServer.transport,
      command: catalogServer.command,
      args: catalogServer.args,
      env: catalogServer.env,
      url: catalogServer.url,
      headers: catalogServer.headers,
      harnesses: null,
      enabled: true,
      tags: catalogServer.tags,
      tools: catalogServer.tools ?? [],
      catalogId: catalogServer.id,
    } as McpServerRecord)
  }

  const handleInstallAll = async () => {
    const toInstall = MCP_CATALOG.filter((s) => !installedIds.has(s.id))
    for (const server of toInstall) {
      await handleInstall(server)
    }
  }

  const handleToggleEnabled = async (server: McpServerRecord) => {
    await saveMcpServer({ ...server, enabled: !server.enabled })
  }

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h2 className="view-title">MCP Servers</h2>
          <p className="view-subtitle">Connect your agents to external tools via the Model Context Protocol.</p>
        </div>
        <button className="view-action-btn" onClick={() => openMcpEditor(null)}>
          + New Server
        </button>
      </div>

      {/* ── Search + Sync bar ──────────────────────────────────── */}
      <div className="skills-toolbar">
        <div className="skills-search-wrapper">
          <MagnifyingGlass className="skills-search-icon" size={14} weight="light" />
          <input
            className="skills-search-input"
            type="text"
            placeholder="Search MCP servers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <McpSyncDropdown />
      </div>

      {/* ── Info banner ───────────────────────────────────────── */}
      <div className="skills-info-banner">
        <p>MCP servers give your coding agents access to external tools like GitHub, databases, Slack, and more. Install a server, configure its env vars, then sync to your harnesses.</p>
      </div>

      {/* ── Installed section ─────────────────────────────────── */}
      <div className="skills-section">
        <div className="skills-section-header">
          <div className="skills-section-label">Installed</div>
          <span className="skills-section-count">{filteredInstalled.length}</span>
        </div>
        {filteredInstalled.length === 0 ? (
          <div className="panel-empty" style={{ padding: '16px 0' }}>
            {query ? 'No installed servers match your search.' : 'No MCP servers installed yet. Browse the catalog below.'}
          </div>
        ) : (
          <div className="skills-catalog-grid">
            {filteredInstalled.map((server) => (
              <div
                key={server.id}
                className={`skill-catalog-card is-installed${server.id === mcpInstallFlash ? ' is-just-installed' : ''}${!server.enabled ? ' is-disabled' : ''}`}
                onClick={() => openMcpDetail(server)}
              >
                <div className="skill-catalog-content">
                  <div className="skill-catalog-name">{server.name}</div>
                  {server.description && (
                    <div className="skill-catalog-desc">{server.description}</div>
                  )}
                </div>
                <span className={`mcp-transport-badge is-${server.transport}`}>{server.transport}</span>
                <div className="skill-catalog-actions">
                  <button
                    className={`skill-card-btn${server.enabled ? '' : ' is-muted'}`}
                    onClick={(e) => { e.stopPropagation(); handleToggleEnabled(server) }}
                    title={server.enabled ? 'Disable' : 'Enable'}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      {server.enabled ? (
                        <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                      ) : (
                        <circle cx="12" cy="12" r="10" />
                      )}
                      {server.enabled && <polyline points="22 4 12 14.01 9 11.01" />}
                    </svg>
                  </button>
                  <button className="skill-card-btn" onClick={(e) => { e.stopPropagation(); openMcpEditor(server) }} title="Edit">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button className="skill-card-btn is-danger" onClick={(e) => { e.stopPropagation(); handleDelete(server) }} title="Remove">
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

      {/* ── Recommended section ───────────────────────────────── */}
      <div className="skills-section">
        <div className="skills-section-header">
          <div className="skills-section-label">Recommended</div>
          <span className="skills-section-count">{filteredCatalog.length}</span>
          {filteredCatalog.length > 0 && (
            <button className="skills-install-all-btn" onClick={handleInstallAll}>
              Install All
            </button>
          )}
        </div>
        {filteredCatalog.length === 0 ? (
          <div className="panel-empty" style={{ padding: '16px 0' }}>
            {query ? 'No catalog servers match your search.' : 'All catalog servers are installed.'}
          </div>
        ) : (
          <div className="skills-catalog-grid">
            {filteredCatalog.map((server) => (
              <div
                key={server.id}
                className="skill-catalog-card"
                onClick={() => openMcpDetail(server)}
              >
                <div className="skill-catalog-content">
                  <div className="skill-catalog-name">{server.name}</div>
                  <div className="skill-catalog-desc">{server.description}</div>
                </div>
                <span className={`mcp-transport-badge is-${server.transport}`}>{server.transport}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
