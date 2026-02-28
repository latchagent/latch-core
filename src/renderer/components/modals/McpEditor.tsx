/**
 * @module McpEditor
 * @description Modal for creating / editing an MCP server configuration.
 */

import React, { useEffect, useState, KeyboardEvent } from 'react'
import { useAppStore } from '../../store/useAppStore'
import type { McpServerRecord, McpTransport } from '../../../types'

const SECRET_REF_RE = /^\$\{secret:[^}]+\}$/

export default function McpEditor() {
  const { mcpEditorServer, closeMcpEditor, saveMcpServer, secrets, loadSecrets, introspectMcpServer } = useAppStore()

  const base = mcpEditorServer
  const [name,      setName]      = useState(base?.name        ?? '')
  const [desc,      setDesc]      = useState(base?.description ?? '')
  const [transport, setTransport] = useState<McpTransport>(base?.transport ?? 'stdio')
  const [command,   setCommand]   = useState(base?.command      ?? '')
  const [args,      setArgs]      = useState(base?.args?.join(', ') ?? '')
  const [url,       setUrl]       = useState(base?.url          ?? '')
  const [tools,     setTools]     = useState(base?.tools?.join(', ')     ?? '')
  const [tags,      setTags]      = useState(base?.tags?.join(', ')      ?? '')
  const [harnesses, setHarnesses] = useState(base?.harnesses?.join(', ') ?? '')
  const [enabled,   setEnabled]   = useState(base?.enabled !== false)
  const [toolDescs, setToolDescs] = useState<Record<string, string>>(base?.toolDescriptions ?? {})
  const [discovering, setDiscovering] = useState(false)
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const [discoverCount, setDiscoverCount] = useState<number | null>(null)

  // Env vars as array of [key, value] pairs
  const [envRows, setEnvRows] = useState<[string, string][]>(() => {
    if (base?.env && Object.keys(base.env).length) {
      return Object.entries(base.env)
    }
    return []
  })

  // Headers as array of [key, value] pairs
  const [headerRows, setHeaderRows] = useState<[string, string][]>(() => {
    if (base?.headers && Object.keys(base.headers).length) {
      return Object.entries(base.headers)
    }
    return []
  })

  useEffect(() => {
    loadSecrets()
    setName(base?.name        ?? '')
    setDesc(base?.description ?? '')
    setTransport(base?.transport ?? 'stdio')
    setCommand(base?.command   ?? '')
    setArgs(base?.args?.join(', ') ?? '')
    setTools(base?.tools?.join(', ') ?? '')
    setUrl(base?.url           ?? '')
    setTags(base?.tags?.join(', ')      ?? '')
    setHarnesses(base?.harnesses?.join(', ') ?? '')
    setEnabled(base?.enabled !== false)
    setToolDescs(base?.toolDescriptions ?? {})
    setDiscovering(false)
    setDiscoverError(null)
    setDiscoverCount(null)
    setEnvRows(base?.env && Object.keys(base.env).length ? Object.entries(base.env) : [])
    setHeaderRows(base?.headers && Object.keys(base.headers).length ? Object.entries(base.headers) : [])
  }, [mcpEditorServer]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    if (!name.trim()) return

    const env: Record<string, string> = {}
    envRows.forEach(([k, v]) => { if (k.trim()) env[k.trim()] = v })

    const headers: Record<string, string> = {}
    headerRows.forEach(([k, v]) => { if (k.trim()) headers[k.trim()] = v })

    const server: McpServerRecord = {
      id:          base?.id ?? `mcp-${Date.now()}`,
      name:        name.trim(),
      description: desc.trim(),
      transport,
      command:     transport === 'stdio' ? command.trim() || undefined : undefined,
      args:        transport === 'stdio' ? args.split(',').map((a) => a.trim()).filter(Boolean) : undefined,
      tools:       tools.split(',').map((t) => t.trim()).filter(Boolean),
      toolDescriptions: toolDescs,
      env:         Object.keys(env).length ? env : undefined,
      url:         transport === 'http' ? url.trim() || undefined : undefined,
      headers:     transport === 'http' && Object.keys(headers).length ? headers : undefined,
      harnesses:   harnesses.trim() ? harnesses.split(',').map((h) => h.trim()).filter(Boolean) : null,
      enabled,
      tags:        tags.split(',').map((t) => t.trim()).filter(Boolean),
      catalogId:   base?.catalogId ?? null,
    }
    await saveMcpServer(server)
  }

  const handleDiscover = async () => {
    if (!base?.id) return
    setDiscovering(true)
    setDiscoverError(null)
    setDiscoverCount(null)
    const result = await introspectMcpServer(base.id)
    setDiscovering(false)
    if (result.ok && result.tools) {
      const names = result.tools.map((t) => t.name)
      setTools(names.join(', '))
      const descs: Record<string, string> = {}
      result.tools.forEach((t) => { if (t.description) descs[t.name] = t.description })
      setToolDescs(descs)
      setDiscoverCount(names.length)
    } else {
      setDiscoverError(result.error ?? 'Discovery failed.')
    }
  }

  const canDiscover = !!base?.id && (
    (transport === 'stdio' && command.trim()) ||
    (transport === 'http' && url.trim())
  )

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeMcpEditor()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave()
  }

  const addEnvRow = () => setEnvRows([...envRows, ['', '']])
  const removeEnvRow = (i: number) => setEnvRows(envRows.filter((_, idx) => idx !== i))
  const updateEnvRow = (i: number, field: 0 | 1, value: string) => {
    const next = [...envRows] as [string, string][]
    next[i] = [...next[i]] as [string, string]
    next[i][field] = value
    setEnvRows(next)
  }

  const addHeaderRow = () => setHeaderRows([...headerRows, ['', '']])
  const removeHeaderRow = (i: number) => setHeaderRows(headerRows.filter((_, idx) => idx !== i))
  const updateHeaderRow = (i: number, field: 0 | 1, value: string) => {
    const next = [...headerRows] as [string, string][]
    next[i] = [...next[i]] as [string, string]
    next[i][field] = value
    setHeaderRows(next)
  }

  return (
    <div
      className="modal-backdrop"
      onKeyDown={handleKeyDown}
      onClick={(e) => { if (e.target === e.currentTarget) closeMcpEditor() }}
    >
      <div className="modal" id="mcp-editor-modal">
        <div className="modal-header">
          <span className="modal-title">{base ? 'Edit MCP Server' : 'New MCP Server'}</span>
          <button className="modal-close" onClick={closeMcpEditor}>x</button>
        </div>

        <div className="modal-body">
          <div className="modal-field">
            <label className="modal-label" htmlFor="mcp-name">Name</label>
            <input
              className="modal-input"
              id="mcp-name"
              placeholder="e.g. GitHub"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="modal-field">
            <label className="modal-label" htmlFor="mcp-desc">Description</label>
            <input
              className="modal-input"
              id="mcp-desc"
              placeholder="What this server provides"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
            />
          </div>

          {/* Transport toggle */}
          <div className="modal-field">
            <label className="modal-label">Transport</label>
            <div className="mcp-transport-toggle">
              <button
                className={`mcp-transport-option${transport === 'stdio' ? ' is-active' : ''}`}
                onClick={() => setTransport('stdio')}
                type="button"
              >
                stdio
              </button>
              <button
                className={`mcp-transport-option${transport === 'http' ? ' is-active' : ''}`}
                onClick={() => setTransport('http')}
                type="button"
              >
                http
              </button>
            </div>
          </div>

          {/* stdio fields */}
          {transport === 'stdio' && (
            <>
              <div className="modal-field">
                <label className="modal-label" htmlFor="mcp-command">Command</label>
                <input
                  className="modal-input"
                  id="mcp-command"
                  placeholder="e.g. npx, uvx, node"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                />
              </div>
              <div className="modal-field">
                <label className="modal-label" htmlFor="mcp-args">Args (comma-separated)</label>
                <input
                  className="modal-input"
                  id="mcp-args"
                  placeholder="-y, @modelcontextprotocol/server-github"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                />
              </div>
            </>
          )}

          {/* http fields */}
          {transport === 'http' && (
            <>
              <div className="modal-field">
                <label className="modal-label" htmlFor="mcp-url">URL</label>
                <input
                  className="modal-input"
                  id="mcp-url"
                  placeholder="https://..."
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </div>
              <div className="modal-field">
                <label className="modal-label">Headers</label>
                <div className="kv-editor">
                  {headerRows.map(([k, v], i) => (
                    <div key={i} className="kv-row">
                      <input
                        className="modal-input kv-key"
                        placeholder="Header"
                        value={k}
                        onChange={(e) => updateHeaderRow(i, 0, e.target.value)}
                      />
                      <input
                        className="modal-input kv-value"
                        placeholder="Value"
                        value={v}
                        onChange={(e) => updateHeaderRow(i, 1, e.target.value)}
                      />
                      <button className="kv-remove" onClick={() => removeHeaderRow(i)} type="button">x</button>
                    </div>
                  ))}
                  <button className="kv-add-btn" onClick={addHeaderRow} type="button">+ Add header</button>
                </div>
              </div>
            </>
          )}

          {/* Env vars */}
          <div className="modal-field">
            <label className="modal-label">Environment variables</label>
            <div className="kv-editor">
              {envRows.map(([k, v], i) => (
                <div key={i} className="kv-row">
                  <input
                    className="modal-input kv-key"
                    placeholder="KEY"
                    value={k}
                    onChange={(e) => updateEnvRow(i, 0, e.target.value)}
                  />
                  <div className="kv-value-wrap">
                    {SECRET_REF_RE.test(v) && <span className="kv-secret-icon" title="Using vault secret">&#x1f512;</span>}
                    <input
                      className={`modal-input kv-value${SECRET_REF_RE.test(v) ? ' is-secret' : ''}`}
                      placeholder="value"
                      value={v}
                      onChange={(e) => updateEnvRow(i, 1, e.target.value)}
                    />
                    {secrets.length > 0 && (
                      <select
                        className="kv-secret-select"
                        value=""
                        onChange={(e) => {
                          if (e.target.value) updateEnvRow(i, 1, e.target.value)
                        }}
                        title="Use a vault secret"
                      >
                        <option value="">secret...</option>
                        {secrets.map((s) => (
                          <option key={s.id} value={`\${secret:${s.key}}`}>{s.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                  <button className="kv-remove" onClick={() => removeEnvRow(i)} type="button">x</button>
                </div>
              ))}
              <button className="kv-add-btn" onClick={addEnvRow} type="button">+ Add variable</button>
            </div>
          </div>

          <div className="modal-field">
            <div className="mcp-discover-row">
              <label className="modal-label" htmlFor="mcp-tools">Tools (comma-separated)</label>
              <button
                className="mcp-discover-btn"
                type="button"
                disabled={!canDiscover || discovering}
                onClick={handleDiscover}
                title={!base?.id ? 'Save the server first to discover tools' : 'Discover tools from running server'}
              >
                {discovering ? 'Discovering...' : 'Discover Tools'}
              </button>
            </div>
            {discoverError && <div className="mcp-discover-error">{discoverError}</div>}
            {discoverCount !== null && !discoverError && <div className="mcp-discover-count">Found {discoverCount} tools</div>}
            <input
              className="modal-input"
              id="mcp-tools"
              placeholder="create_issue, get_repo, list_prs"
              value={tools}
              onChange={(e) => setTools(e.target.value)}
            />
          </div>
          <div className="modal-field">
            <label className="modal-label" htmlFor="mcp-tags">Tags (comma-separated)</label>
            <input
              className="modal-input"
              id="mcp-tags"
              placeholder="developer, github"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </div>
          <div className="modal-field">
            <label className="modal-label" htmlFor="mcp-harnesses">Harnesses (blank = all)</label>
            <input
              className="modal-input"
              id="mcp-harnesses"
              placeholder="claude, codex, cursor"
              value={harnesses}
              onChange={(e) => setHarnesses(e.target.value)}
            />
          </div>
          <div className="modal-field">
            <label className="wizard-toggle">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span className="wizard-toggle-label">Enabled</span>
            </label>
          </div>
        </div>

        <div className="modal-footer">
          <button className="modal-btn" onClick={closeMcpEditor}>Cancel</button>
          <button className="modal-btn is-primary" onClick={handleSave}>Save Server</button>
        </div>
      </div>
    </div>
  )
}
