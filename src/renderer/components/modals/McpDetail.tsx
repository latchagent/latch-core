/**
 * @module McpDetail
 * @description Read-only preview modal for a catalog or installed MCP server.
 * Shows config fields. Footer offers "Install" (catalog) or "Edit" (installed).
 */

import React, { useMemo, useState, KeyboardEvent } from 'react'
import { useAppStore } from '../../store/useAppStore'
import type { McpServerRecord } from '../../../types'

export default function McpDetail() {
  const {
    mcpDetailServer: server,
    closeMcpDetail,
    mcpServers,
    saveMcpServer,
    openMcpEditor,
    introspectMcpServer,
  } = useAppStore()

  const [discovering, setDiscovering] = useState(false)
  const [discoverError, setDiscoverError] = useState<string | null>(null)

  const installedIds = useMemo(() => new Set(mcpServers.map((s) => s.id)), [mcpServers])
  const isInstalled = server ? installedIds.has(server.id) : false

  const handleInstall = async () => {
    if (!server) return
    await saveMcpServer({
      id: server.id,
      name: server.name,
      description: server.description ?? '',
      transport: server.transport,
      command: 'command' in server ? server.command : undefined,
      args: 'args' in server ? server.args : undefined,
      env: 'env' in server ? server.env : undefined,
      url: 'url' in server ? server.url : undefined,
      headers: 'headers' in server ? server.headers : undefined,
      harnesses: null,
      enabled: true,
      tags: 'tags' in server ? server.tags ?? [] : [],
      tools: 'tools' in server && Array.isArray(server.tools) ? server.tools : [],
      toolDescriptions: 'toolDescriptions' in server ? (server as McpServerRecord).toolDescriptions : {},
      catalogId: server.id,
    } as McpServerRecord)
    useAppStore.setState({ mcpInstallFlash: server.id })
    setTimeout(() => useAppStore.setState({ mcpInstallFlash: null }), 2500)
    closeMcpDetail()
  }

  const handleEdit = () => {
    if (!server) return
    const installed = mcpServers.find((s) => s.id === server.id)
    openMcpEditor(installed ?? (server as McpServerRecord))
    closeMcpDetail()
  }

  const handleDiscover = async () => {
    if (!server || !isInstalled) return
    setDiscovering(true)
    setDiscoverError(null)
    const result = await introspectMcpServer(server.id)
    setDiscovering(false)
    if (!result.ok) setDiscoverError(result.error ?? 'Discovery failed.')
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeMcpDetail()
  }

  if (!server) return null

  // Use installed server data for tools/descriptions (fresh from store after discover)
  const installed = mcpServers.find((s) => s.id === server.id)
  const serverTools = installed?.tools ?? ('tools' in server ? (server as McpServerRecord).tools : []) ?? []
  const serverToolDescs = installed?.toolDescriptions ?? ('toolDescriptions' in server ? (server as McpServerRecord).toolDescriptions : {}) ?? {}

  const icon = 'icon' in server ? (server as any).icon : server.name.charAt(0).toUpperCase()
  const envHints = 'envHints' in server ? (server as any).envHints : null

  return (
    <div
      className="modal-backdrop"
      onKeyDown={handleKeyDown}
      onClick={(e) => { if (e.target === e.currentTarget) closeMcpDetail() }}
    >
      <div className="modal" id="mcp-detail-modal">
        <div className="modal-header">
          <div className="skill-detail-header-row">
            <div className="skill-catalog-icon">{icon}</div>
            <span className="modal-title">{server.name}</span>
            <span className={`mcp-transport-badge is-${server.transport}`}>{server.transport}</span>
          </div>
          <button className="modal-close" onClick={closeMcpDetail}>x</button>
        </div>

        <div className="modal-body">
          {server.description && (
            <p className="skill-detail-desc">{server.description}</p>
          )}

          {'tags' in server && (server.tags as string[])?.length > 0 && (
            <div className="skill-card-tags" style={{ marginBottom: 16 }}>
              {(server.tags as string[]).map((tag) => (
                <span key={tag} className="skill-tag">{tag}</span>
              ))}
            </div>
          )}

          {/* Configuration details */}
          <div className="mcp-detail-config">
            {server.transport === 'stdio' && (
              <>
                {'command' in server && server.command && (
                  <div className="mcp-detail-row">
                    <span className="mcp-detail-label">Command</span>
                    <code className="mcp-detail-value">{server.command}</code>
                  </div>
                )}
                {'args' in server && server.args?.length ? (
                  <div className="mcp-detail-row">
                    <span className="mcp-detail-label">Args</span>
                    <code className="mcp-detail-value">{server.args.join(' ')}</code>
                  </div>
                ) : null}
              </>
            )}

            {server.transport === 'http' && 'url' in server && server.url && (
              <div className="mcp-detail-row">
                <span className="mcp-detail-label">URL</span>
                <code className="mcp-detail-value">{server.url}</code>
              </div>
            )}

            {'env' in server && server.env && Object.keys(server.env).length > 0 && (
              <div className="mcp-detail-row">
                <span className="mcp-detail-label">Env vars</span>
                <div className="mcp-detail-env-list">
                  {Object.entries(server.env).map(([k, v]) => (
                    <div key={k} className="mcp-detail-env-item">
                      <code>{k}</code>
                      {v ? <span className="mcp-detail-env-set">set</span> : <span className="mcp-detail-env-unset">needs value</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {envHints && Object.keys(envHints).length > 0 && (
              <div className="mcp-detail-row">
                <span className="mcp-detail-label">Setup hints</span>
                <div className="mcp-detail-env-list">
                  {Object.entries(envHints).map(([k, hint]) => (
                    <div key={k} className="mcp-detail-env-item">
                      <code>{k}</code>
                      <span className="mcp-detail-env-hint">{hint as string}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {'enabled' in server && (
              <div className="mcp-detail-row">
                <span className="mcp-detail-label">Status</span>
                <span className={`mcp-detail-status${server.enabled ? ' is-enabled' : ' is-disabled'}`}>
                  {server.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
            )}
          </div>

          {/* Tools section */}
          <div className="mcp-detail-config" style={{ marginTop: 16 }}>
            <div className="mcp-detail-row">
              <span className="mcp-detail-label">Tools</span>
              {isInstalled && (
                <button
                  className="mcp-discover-btn"
                  type="button"
                  disabled={discovering}
                  onClick={handleDiscover}
                  style={{ marginLeft: 'auto' }}
                >
                  {discovering ? 'Discovering...' : 'Discover Tools'}
                </button>
              )}
            </div>
            {discoverError && <div className="mcp-discover-error">{discoverError}</div>}
            {serverTools.length > 0 ? (
              <div className="mcp-detail-tools-list">
                {serverTools.map((tool) => (
                  <div key={tool} className="mcp-detail-tool-item">
                    <code className="mcp-detail-tool-name">{tool}</code>
                    {serverToolDescs[tool] && (
                      <span className="mcp-detail-tool-desc">{serverToolDescs[tool]}</span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="panel-empty" style={{ padding: '8px 0', fontSize: 12 }}>
                No tools discovered yet.
              </div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button className="modal-btn" onClick={closeMcpDetail}>Close</button>
          {isInstalled ? (
            <button className="modal-btn is-primary" onClick={handleEdit}>Edit</button>
          ) : (
            <button className="modal-btn is-primary" onClick={handleInstall}>Install Server</button>
          )}
        </div>
      </div>
    </div>
  )
}
