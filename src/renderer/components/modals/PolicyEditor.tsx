/**
 * @module PolicyEditor
 * @description Full-page view for creating / editing a PolicyDocument.
 * Used for both global policy edits and ephemeral session override creation.
 * Includes per-harness config sections for Claude Code, Codex, and OpenClaw,
 * split into tabs for easier navigation.
 */

import React, { useEffect, useState, KeyboardEvent } from 'react'
import { ArrowLeft } from '@phosphor-icons/react'
import { useAppStore } from '../../store/useAppStore'
import type {
  PolicyDocument,
  PolicyPermissions,
  HarnessesConfig,
  ClaudePolicyConfig,
  CodexPolicyConfig,
  OpenClawPolicyConfig,
  ToolRule,
  McpServerRule,
  McpServerRecord,
  ToolRuleDecision,
  CommandRule,
} from '../../../types'

const DEFAULT_PERMS: PolicyPermissions = {
  allowBash:          true,
  allowNetwork:       true,
  allowFileWrite:     true,
  confirmDestructive: true,
  blockedGlobs:       [],
}

// ─── Tri-state tool chip selector ────────────────────────────────────────────

const DECISION_CYCLE: (ToolRuleDecision | 'unset')[] = ['unset', 'allow', 'prompt', 'deny']

function ToolRulesEditor({ tools, rules, onChange }: {
  tools: string[]
  rules: ToolRule[]
  onChange: (next: ToolRule[]) => void
}) {
  const getDecision = (tool: string): ToolRuleDecision | 'unset' => {
    const rule = rules.find(r => r.pattern === tool)
    return rule ? rule.decision : 'unset'
  }

  const cycleDecision = (tool: string) => {
    const current = getDecision(tool)
    const idx = DECISION_CYCLE.indexOf(current)
    const next = DECISION_CYCLE[(idx + 1) % DECISION_CYCLE.length]
    if (next === 'unset') {
      onChange(rules.filter(r => r.pattern !== tool))
    } else {
      const existing = rules.find(r => r.pattern === tool)
      if (existing) {
        onChange(rules.map(r => r.pattern === tool ? { ...r, decision: next } : r))
      } else {
        onChange([...rules, { pattern: tool, decision: next }])
      }
    }
  }

  const decisionLabel = (d: ToolRuleDecision | 'unset') => {
    if (d === 'allow') return 'A'
    if (d === 'prompt') return 'P'
    if (d === 'deny') return 'D'
    return ''
  }

  const decisionClass = (d: ToolRuleDecision | 'unset') => {
    if (d === 'allow') return 'is-allow'
    if (d === 'prompt') return 'is-prompt'
    if (d === 'deny') return 'is-deny'
    return ''
  }

  return (
    <div className="tool-chips">
      {tools.map((tool) => {
        const d = getDecision(tool)
        return (
          <button
            key={tool}
            type="button"
            className={`tool-chip ${decisionClass(d)}`}
            onClick={() => cycleDecision(tool)}
            title={`${tool}: ${d === 'unset' ? 'no rule' : d} — click to cycle`}
          >
            {d !== 'unset' && <span className="chip-decision-label">{decisionLabel(d)}</span>}
            {tool}
          </button>
        )
      })}
    </div>
  )
}

// ─── Custom tool rules (arbitrary patterns) ──────────────────────────────────

function CustomToolRules({ rules, builtinTools, onChange }: {
  rules: ToolRule[]
  builtinTools: string[]
  onChange: (next: ToolRule[]) => void
}) {
  const [input, setInput] = useState('')
  const customRules = rules.filter(r => !builtinTools.includes(r.pattern) && !r.pattern.startsWith('mcp__'))

  const addRule = () => {
    const pattern = input.trim()
    if (!pattern) return
    if (rules.find(r => r.pattern === pattern)) return
    onChange([...rules, { pattern, decision: 'deny' }])
    setInput('')
  }

  const removeRule = (pattern: string) => {
    onChange(rules.filter(r => r.pattern !== pattern))
  }

  const updateDecision = (pattern: string, decision: ToolRuleDecision) => {
    onChange(rules.map(r => r.pattern === pattern ? { ...r, decision } : r))
  }

  return (
    <>
      {customRules.map(rule => (
        <div key={rule.pattern} className="custom-tool-rule-row">
          <span className="custom-tool-rule-name">{rule.pattern}</span>
          <select
            className="custom-tool-rule-select"
            value={rule.decision}
            onChange={(e) => updateDecision(rule.pattern, e.target.value as ToolRuleDecision)}
          >
            <option value="allow">Allow</option>
            <option value="prompt">Prompt</option>
            <option value="deny">Deny</option>
          </select>
          <button
            type="button"
            className="custom-tool-rule-remove"
            onClick={() => removeRule(rule.pattern)}
          >x</button>
        </div>
      ))}
      <div className="add-tool-row">
        <input
          className="add-tool-input"
          type="text"
          placeholder="mcp__github__create_issue"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addRule() }}
        />
        <button type="button" className="add-tool-btn" onClick={addRule}>Add</button>
      </div>
    </>
  )
}

// ─── MCP server rules ────────────────────────────────────────────────────────

function McpServerRulesEditor({ rules, onChange }: {
  rules: McpServerRule[]
  onChange: (next: McpServerRule[]) => void
}) {
  const mcpServers = useAppStore((s) => s.mcpServers)
  const [manualMode, setManualMode] = useState(false)
  const [input, setInput] = useState('')

  const existingServerNames = new Set(rules.map(r => r.server))
  const availableServers = mcpServers.filter((s) => {
    const serverKey = s.name.toLowerCase().replace(/\s+/g, '-')
    return !existingServerNames.has(serverKey)
  })

  const addRule = () => {
    const server = input.trim()
    if (!server) return
    if (rules.find(r => r.server === server)) return
    onChange([...rules, { server, decision: 'deny' }])
    setInput('')
  }

  const addFromDropdown = (value: string) => {
    if (!value) return
    if (rules.find(r => r.server === value)) return
    onChange([...rules, { server: value, decision: 'deny' }])
  }

  const removeRule = (server: string) => {
    onChange(rules.filter(r => r.server !== server))
  }

  const updateDecision = (server: string, decision: ToolRuleDecision) => {
    onChange(rules.map(r => r.server === server ? { ...r, decision } : r))
  }

  return (
    <>
      {rules.map(rule => (
        <div key={rule.server} className="mcp-server-rule-row">
          <span className="mcp-server-rule-name">{rule.server}</span>
          <select
            className="mcp-server-rule-select"
            value={rule.decision}
            onChange={(e) => updateDecision(rule.server, e.target.value as ToolRuleDecision)}
          >
            <option value="allow">Allow</option>
            <option value="prompt">Prompt</option>
            <option value="deny">Deny</option>
          </select>
          <button
            type="button"
            className="mcp-server-rule-remove"
            onClick={() => removeRule(rule.server)}
          >x</button>
        </div>
      ))}
      <div className="add-tool-row">
        {manualMode ? (
          <>
            <input
              className="add-tool-input"
              type="text"
              placeholder="server-name"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addRule() }}
            />
            <button type="button" className="add-tool-btn" onClick={addRule}>Add</button>
            <button type="button" className="add-tool-btn" onClick={() => setManualMode(false)} title="Switch to dropdown">List</button>
          </>
        ) : (
          <>
            <select
              className="add-tool-input"
              value=""
              onChange={(e) => addFromDropdown(e.target.value)}
            >
              <option value="">Select server...</option>
              {availableServers.map((s) => {
                const serverKey = s.name.toLowerCase().replace(/\s+/g, '-')
                return <option key={s.id} value={serverKey}>{s.name}</option>
              })}
            </select>
            <button type="button" className="add-tool-btn" onClick={() => setManualMode(true)} title="Type a custom server name">Manual</button>
          </>
        )}
      </div>
    </>
  )
}

// ─── Command rules editor ────────────────────────────────────────────────────

function CommandRulesEditor({ rules, onChange }: {
  rules: CommandRule[]
  onChange: (next: CommandRule[]) => void
}) {
  const [input, setInput] = useState('')

  const addRule = () => {
    const pattern = input.trim()
    if (!pattern) return
    if (rules.find(r => r.pattern === pattern)) return
    onChange([...rules, { pattern, decision: 'deny' }])
    setInput('')
  }

  const removeRule = (pattern: string) => {
    onChange(rules.filter(r => r.pattern !== pattern))
  }

  const updateDecision = (pattern: string, decision: ToolRuleDecision) => {
    onChange(rules.map(r => r.pattern === pattern ? { ...r, decision } : r))
  }

  return (
    <>
      {rules.map(rule => (
        <div key={rule.pattern} className="custom-tool-rule-row">
          <code className="custom-tool-rule-name" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{rule.pattern}</code>
          <select
            className="custom-tool-rule-select"
            value={rule.decision}
            onChange={(e) => updateDecision(rule.pattern, e.target.value as ToolRuleDecision)}
          >
            <option value="allow">Allow</option>
            <option value="prompt">Prompt</option>
            <option value="deny">Deny</option>
          </select>
          <button
            type="button"
            className="custom-tool-rule-remove"
            onClick={() => removeRule(rule.pattern)}
          >x</button>
        </div>
      ))}
      <div className="add-tool-row">
        <input
          className="add-tool-input"
          type="text"
          placeholder="^sudo\\s+"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addRule() }}
        />
        <button type="button" className="add-tool-btn" onClick={addRule}>Add</button>
      </div>
    </>
  )
}

// ─── MCP tool picker (grouped by server) ────────────────────────────────────

function McpToolPicker({ rules, onChange, serverRules }: {
  rules: ToolRule[]
  onChange: (next: ToolRule[]) => void
  serverRules: McpServerRule[]
}) {
  const mcpServers = useAppStore((s) => s.mcpServers)

  // Only show tools for servers that have been added to this policy's server rules
  const addedServerNames = new Set(serverRules.map(r => r.server))
  const serversWithTools = mcpServers.filter((s) => {
    const serverKey = s.name.toLowerCase().replace(/\s+/g, '-')
    return addedServerNames.has(serverKey) && s.tools && s.tools.length > 0
  })

  if (serversWithTools.length === 0) {
    if (serverRules.length === 0) {
      return <div className="pe-hint">Add MCP servers above to configure individual tool rules.</div>
    }
    return <div className="pe-hint">No tool metadata available for the added servers.</div>
  }

  const toPattern = (server: McpServerRecord, tool: string) =>
    `mcp__${server.name.toLowerCase().replace(/\s+/g, '-')}__${tool}`

  const getDecision = (pattern: string): ToolRuleDecision | 'unset' => {
    const rule = rules.find(r => r.pattern === pattern)
    return rule ? rule.decision : 'unset'
  }

  const cycleDecision = (pattern: string) => {
    const current = getDecision(pattern)
    const idx = DECISION_CYCLE.indexOf(current)
    const next = DECISION_CYCLE[(idx + 1) % DECISION_CYCLE.length]
    if (next === 'unset') {
      onChange(rules.filter(r => r.pattern !== pattern))
    } else {
      const existing = rules.find(r => r.pattern === pattern)
      if (existing) {
        onChange(rules.map(r => r.pattern === pattern ? { ...r, decision: next } : r))
      } else {
        onChange([...rules, { pattern, decision: next }])
      }
    }
  }

  const decisionLabel = (d: ToolRuleDecision | 'unset') => {
    if (d === 'allow') return 'A'
    if (d === 'prompt') return 'P'
    if (d === 'deny') return 'D'
    return ''
  }

  const decisionClass = (d: ToolRuleDecision | 'unset') => {
    if (d === 'allow') return 'is-allow'
    if (d === 'prompt') return 'is-prompt'
    if (d === 'deny') return 'is-deny'
    return ''
  }

  return (
    <div className="mcp-tool-picker">
      {serversWithTools.map((server) => (
        <div key={server.id} className="mcp-tool-group">
          <div className="mcp-tool-group-label">{server.name}</div>
          <div className="tool-chips">
            {server.tools.map((tool) => {
              const pattern = toPattern(server, tool)
              const d = getDecision(pattern)
              const desc = server.toolDescriptions?.[tool]
              return (
                <button
                  key={pattern}
                  type="button"
                  className={`tool-chip ${decisionClass(d)}`}
                  onClick={() => cycleDecision(pattern)}
                  title={`${pattern}: ${d === 'unset' ? 'no rule' : d}${desc ? ' — ' + desc : ''} — click to cycle`}
                >
                  {d !== 'unset' && <span className="chip-decision-label">{decisionLabel(d)}</span>}
                  {tool}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CLAUDE_TOOLS   = ['Read', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit']
const CODEX_TOOLS    = ['shell', 'read', 'write', 'apply_patch', 'web_search']
const OPENCLAW_TOOLS = ['read', 'write', 'exec', 'web_search', 'web_fetch', 'browser']

type PeTab = 'general' | 'claude' | 'codex' | 'openclaw'

const PE_TABS: { id: PeTab; label: string }[] = [
  { id: 'general',  label: 'General' },
  { id: 'claude',   label: 'Claude Code' },
  { id: 'codex',    label: 'Codex' },
  { id: 'openclaw', label: 'OpenClaw' },
]

// ─── Helpers: convert legacy arrays to/from ToolRule[] ───────────────────────

function legacyToToolRules(allowed?: string[], denied?: string[]): ToolRule[] {
  const rules: ToolRule[] = []
  if (denied) {
    for (const t of denied) rules.push({ pattern: t, decision: 'deny' })
  }
  if (allowed) {
    for (const t of allowed) {
      if (!rules.find(r => r.pattern === t)) rules.push({ pattern: t, decision: 'allow' })
    }
  }
  return rules
}

function initToolRules(config: { toolRules?: ToolRule[]; allowedTools?: string[]; deniedTools?: string[] } | undefined): ToolRule[] {
  if (config?.toolRules?.length) return [...config.toolRules]
  return legacyToToolRules(config?.allowedTools, config?.deniedTools)
}

function initMcpRules(config: { mcpServerRules?: McpServerRule[] } | undefined): McpServerRule[] {
  return config?.mcpServerRules ? [...config.mcpServerRules] : []
}

// ─── PolicyEditor ───────────────────────────────────────────────────────────

export default function PolicyEditor() {
  const {
    policyEditorPolicy,
    policyEditorIsOverride,
    closePolicyEditor,
    savePolicyFromEditor,
  } = useAppStore()

  const base = policyEditorPolicy
  const [activeTab, setActiveTab] = useState<PeTab>('general')
  const [name,   setName]   = useState(base?.name        ?? '')
  const [desc,   setDesc]   = useState(base?.description ?? '')
  const [perms,  setPerms]  = useState<PolicyPermissions>(base?.permissions ?? DEFAULT_PERMS)
  const [globs,  setGlobs]  = useState<string[]>(base?.permissions?.blockedGlobs ?? [])
  const [commandRules, setCommandRules] = useState<CommandRule[]>(base?.permissions?.commandRules ?? [])

  // Per-harness tool rules (replaces legacy allow/deny arrays)
  const [claudeToolRules,   setClaudeToolRules]   = useState<ToolRule[]>(initToolRules(base?.harnesses?.claude))
  const [claudeMcpRules,    setClaudeMcpRules]    = useState<McpServerRule[]>(initMcpRules(base?.harnesses?.claude))
  const [codexApproval,     setCodexApproval]     = useState<string>(base?.harnesses?.codex?.approvalMode ?? '')
  const [codexSandbox,      setCodexSandbox]      = useState<string>(base?.harnesses?.codex?.sandbox ?? '')
  const [codexToolRules,    setCodexToolRules]    = useState<ToolRule[]>(initToolRules(base?.harnesses?.codex as any))
  const [codexMcpRules,     setCodexMcpRules]     = useState<McpServerRule[]>(initMcpRules(base?.harnesses?.codex))
  const [openclawToolRules, setOpenclawToolRules] = useState<ToolRule[]>(initToolRules(base?.harnesses?.openclaw))
  const [openclawMcpRules,  setOpenclawMcpRules]  = useState<McpServerRule[]>(initMcpRules(base?.harnesses?.openclaw))

  // Sync form if the editor is reopened with different policy
  useEffect(() => {
    setActiveTab('general')
    setName(base?.name        ?? '')
    setDesc(base?.description ?? '')
    setPerms(base?.permissions ?? DEFAULT_PERMS)
    setGlobs(base?.permissions?.blockedGlobs ?? [])
    setCommandRules(base?.permissions?.commandRules ?? [])
    setClaudeToolRules(initToolRules(base?.harnesses?.claude))
    setClaudeMcpRules(initMcpRules(base?.harnesses?.claude))
    setCodexApproval(base?.harnesses?.codex?.approvalMode ?? '')
    setCodexSandbox(base?.harnesses?.codex?.sandbox ?? '')
    setCodexToolRules(initToolRules(base?.harnesses?.codex as any))
    setCodexMcpRules(initMcpRules(base?.harnesses?.codex))
    setOpenclawToolRules(initToolRules(base?.harnesses?.openclaw))
    setOpenclawMcpRules(initMcpRules(base?.harnesses?.openclaw))
  }, [policyEditorPolicy]) // eslint-disable-line react-hooks/exhaustive-deps

  const updatePerm = (key: keyof Omit<PolicyPermissions, 'blockedGlobs' | 'commandRules'>, val: boolean) => {
    setPerms((p) => ({ ...p, [key]: val }))
  }

  const addGlob   = () => setGlobs((g) => [...g, ''])
  const setGlob   = (i: number, v: string) => setGlobs((g) => g.map((x, j) => j === i ? v : x))
  const removeGlob = (i: number) => setGlobs((g) => g.filter((_, j) => j !== i))

  const handleSave = () => {
    const claude: ClaudePolicyConfig = {}
    if (claudeToolRules.length) {
      claude.toolRules = claudeToolRules
      // Legacy backward compat
      claude.allowedTools = claudeToolRules.filter(r => r.decision === 'allow').map(r => r.pattern)
      claude.deniedTools  = claudeToolRules.filter(r => r.decision === 'deny').map(r => r.pattern)
      if (!claude.allowedTools.length) delete claude.allowedTools
      if (!claude.deniedTools.length)  delete claude.deniedTools
    }
    if (claudeMcpRules.length) claude.mcpServerRules = claudeMcpRules

    const codex: CodexPolicyConfig = {}
    if (codexApproval) codex.approvalMode = codexApproval as CodexPolicyConfig['approvalMode']
    if (codexSandbox)  codex.sandbox      = codexSandbox as CodexPolicyConfig['sandbox']
    if (codexToolRules.length) codex.toolRules = codexToolRules
    if (codexMcpRules.length)  codex.mcpServerRules = codexMcpRules

    const openclaw: OpenClawPolicyConfig = {}
    if (openclawToolRules.length) {
      openclaw.toolRules = openclawToolRules
      // Legacy backward compat
      openclaw.allowedTools = openclawToolRules.filter(r => r.decision === 'allow').map(r => r.pattern)
      openclaw.deniedTools  = openclawToolRules.filter(r => r.decision === 'deny').map(r => r.pattern)
      if (!openclaw.allowedTools.length) delete openclaw.allowedTools
      if (!openclaw.deniedTools.length)  delete openclaw.deniedTools
    }
    if (openclawMcpRules.length) openclaw.mcpServerRules = openclawMcpRules

    const harnesses: HarnessesConfig = {}
    if (Object.keys(claude).length)   harnesses.claude   = claude
    if (Object.keys(codex).length)    harnesses.codex    = codex
    if (Object.keys(openclaw).length) harnesses.openclaw = openclaw

    const policy: PolicyDocument = {
      id:          base?.id === '__override__' ? `override-${Date.now()}` : (base?.id ?? `policy-${Date.now()}`),
      name:        name.trim() || 'Untitled Policy',
      description: desc.trim(),
      permissions: { ...perms, blockedGlobs: globs.filter(Boolean), ...(commandRules.length ? { commandRules } : {}) },
      harnesses,
    }
    savePolicyFromEditor(policy)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closePolicyEditor()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave()
  }

  const title = policyEditorIsOverride
    ? 'Session Override'
    : (base?.id ? (name || base.name || 'Edit Policy') : 'New Policy')

  return (
    <div className="view-container" onKeyDown={handleKeyDown}>
      {/* ── Back + Title ─────────────────────────────────────────── */}
      <div className="cp-back-row">
        <button className="cp-back-btn" onClick={closePolicyEditor}>
          <ArrowLeft size={14} weight="bold" style={{ marginRight: 4, verticalAlign: -1 }} />
          Back to Policies
        </button>
      </div>

      <div className="view-header">
        <h2 className="view-title">{title}</h2>
        <button className="view-action-btn" onClick={handleSave}>
          Save Policy
        </button>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────── */}
      <div className="pe-tabs">
        {PE_TABS.map((tab) => (
          <button
            key={tab.id}
            className={`pe-tab${activeTab === tab.id ? ' is-active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── General tab ──────────────────────────────────────────── */}
      {activeTab === 'general' && (
        <div className="pe-tab-content">
          <div className="modal-field">
            <label className="modal-label" htmlFor="pe-name">Name</label>
            <input
              className="modal-input"
              id="pe-name"
              placeholder="My Policy"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="modal-field">
            <label className="modal-label" htmlFor="pe-description">Description</label>
            <input
              className="modal-input"
              id="pe-description"
              placeholder="Optional description"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
            />
          </div>

          <div className="view-section-label">Permissions</div>

          {(
            [
              ['pe-allow-bash',    'Allow shell / bash commands', 'allowBash',
                'When enabled, agents can execute shell commands (e.g. npm install, git commit). Disable to block all terminal/bash execution.'],
              ['pe-allow-network', 'Allow network access',        'allowNetwork',
                'Controls outbound network calls — HTTP requests, API calls, package downloads. Does not affect local file or shell access.'],
              ['pe-allow-writes',  'Allow file writes',           'allowFileWrite',
                'When enabled, agents can create and modify files on disk. Disable to make the session read-only.'],
              ['pe-confirm-dest',  'Confirm destructive operations', 'confirmDestructive',
                'When enabled, high-risk actions (e.g. deleting files, force-pushing) require your explicit approval before proceeding.'],
            ] as [string, string, keyof Omit<PolicyPermissions, 'blockedGlobs' | 'commandRules'>, string][]
          ).map(([id, label, key, tooltip]) => (
            <label key={id} className="modal-toggle" title={tooltip}>
              <input
                type="checkbox"
                id={id}
                checked={perms[key]}
                onChange={(e) => updatePerm(key, e.target.checked)}
              />
              <span className="modal-toggle-label">{label}</span>
              <span className="modal-toggle-hint">{tooltip}</span>
            </label>
          ))}

          <div className="view-section-label">Blocked paths (globs)</div>
          <div className="modal-globs" id="pe-globs-list">
            {globs.map((g, i) => (
              <div key={i} className="modal-glob-row">
                <input
                  className="modal-glob-input"
                  type="text"
                  placeholder="/etc/** or ~/.ssh/**"
                  value={g}
                  onChange={(e) => setGlob(i, e.target.value)}
                />
                <button
                  className="modal-glob-remove"
                  type="button"
                  onClick={() => removeGlob(i)}
                >
                  x
                </button>
              </div>
            ))}
          </div>
          <button className="modal-add-glob" onClick={addGlob}>+ Add path</button>

          <div className="view-section-label">Command rules (regex)</div>
          <div className="modal-field">
            <label className="modal-label">Shell command patterns matched against the full command string</label>
            <CommandRulesEditor rules={commandRules} onChange={setCommandRules} />
          </div>
        </div>
      )}

      {/* ── Claude Code tab ──────────────────────────────────────── */}
      {activeTab === 'claude' && (
        <div className="pe-tab-content">
          <div className="modal-field">
            <label className="modal-label">Tool rules</label>
            <ToolRulesEditor tools={CLAUDE_TOOLS} rules={claudeToolRules} onChange={setClaudeToolRules} />
          </div>
          <div className="modal-field">
            <label className="modal-label">MCP server rules</label>
            <McpServerRulesEditor rules={claudeMcpRules} onChange={setClaudeMcpRules} />
          </div>
          <div className="modal-field">
            <label className="modal-label">MCP tool rules</label>
            <McpToolPicker rules={claudeToolRules} onChange={setClaudeToolRules} serverRules={claudeMcpRules} />
          </div>
          <div className="modal-field">
            <label className="modal-label">Custom tool rules</label>
            <CustomToolRules rules={claudeToolRules} builtinTools={CLAUDE_TOOLS} onChange={setClaudeToolRules} />
          </div>
        </div>
      )}

      {/* ── Codex tab ────────────────────────────────────────────── */}
      {activeTab === 'codex' && (
        <div className="pe-tab-content">
          <div className="modal-field">
            <label className="modal-label" htmlFor="pe-codex-approval">Approval mode</label>
            <select
              className="modal-input"
              id="pe-codex-approval"
              value={codexApproval}
              onChange={(e) => setCodexApproval(e.target.value)}
            >
              <option value="">Auto-derive from permissions</option>
              <option value="auto">Auto</option>
              <option value="read-only">Read-Only</option>
              <option value="full">Full</option>
            </select>
          </div>
          <div className="modal-field">
            <label className="modal-label" htmlFor="pe-codex-sandbox">Sandbox</label>
            <select
              className="modal-input"
              id="pe-codex-sandbox"
              value={codexSandbox}
              onChange={(e) => setCodexSandbox(e.target.value)}
            >
              <option value="">Auto-derive from permissions</option>
              <option value="permissive">Permissive</option>
              <option value="moderate">Moderate</option>
              <option value="strict">Strict</option>
            </select>
          </div>
          <div className="modal-field">
            <label className="modal-label">Tool rules</label>
            <ToolRulesEditor tools={CODEX_TOOLS} rules={codexToolRules} onChange={setCodexToolRules} />
          </div>
          <div className="modal-field">
            <label className="modal-label">MCP server rules</label>
            <McpServerRulesEditor rules={codexMcpRules} onChange={setCodexMcpRules} />
          </div>
          <div className="modal-field">
            <label className="modal-label">MCP tool rules</label>
            <McpToolPicker rules={codexToolRules} onChange={setCodexToolRules} serverRules={codexMcpRules} />
          </div>
          <div className="modal-field">
            <label className="modal-label">Custom tool rules</label>
            <CustomToolRules rules={codexToolRules} builtinTools={CODEX_TOOLS} onChange={setCodexToolRules} />
          </div>
        </div>
      )}

      {/* ── OpenClaw tab ─────────────────────────────────────────── */}
      {activeTab === 'openclaw' && (
        <div className="pe-tab-content">
          <div className="modal-field">
            <label className="modal-label">Tool rules</label>
            <ToolRulesEditor tools={OPENCLAW_TOOLS} rules={openclawToolRules} onChange={setOpenclawToolRules} />
          </div>
          <div className="modal-field">
            <label className="modal-label">MCP server rules</label>
            <McpServerRulesEditor rules={openclawMcpRules} onChange={setOpenclawMcpRules} />
          </div>
          <div className="modal-field">
            <label className="modal-label">MCP tool rules</label>
            <McpToolPicker rules={openclawToolRules} onChange={setOpenclawToolRules} serverRules={openclawMcpRules} />
          </div>
          <div className="modal-field">
            <label className="modal-label">Custom tool rules</label>
            <CustomToolRules rules={openclawToolRules} builtinTools={OPENCLAW_TOOLS} onChange={setOpenclawToolRules} />
          </div>
        </div>
      )}
    </div>
  )
}
