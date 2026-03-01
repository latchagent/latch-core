/**
 * @module DocsView
 * @description Static documentation page explaining what Latch is, why it
 * matters, how the architecture works under the hood, and what each feature
 * does. Pure React + CSS — no data fetching, no IPC calls.
 */

import { useState } from 'react'

const ASCII_LOGO = `██╗      █████╗ ████████╗ ██████╗██╗  ██╗
██║     ██╔══██╗╚══██╔══╝██╔════╝██║  ██║
██║     ███████║   ██║   ██║     ███████║
██║     ██╔══██║   ██║   ██║     ██╔══██║
███████╗██║  ██║   ██║   ╚██████╗██║  ██║
╚══════╝╚═╝  ╚═╝   ╚═╝    ╚═════╝╚═╝  ╚═╝`

// ─── Collapsible detail helper ─────────────────────────────────────────────

function Details({ id, title, expanded, onToggle, children }: {
  id: string
  title: string
  expanded: boolean
  onToggle: (id: string) => void
  children: React.ReactNode
}) {
  return (
    <div className="docs-details">
      <button className="docs-details-toggle" onClick={() => onToggle(id)}>
        <span className="docs-details-chevron">{expanded ? '▾' : '▸'}</span>
        {title}
      </button>
      {expanded && <div className="docs-details-body">{children}</div>}
    </div>
  )
}

// ─── Diagram card wrapper ──────────────────────────────────────────────────

function DiagramCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="docs-diagram">
      <div className="docs-diagram-label">{label}</div>
      <div className="docs-diagram-canvas">{children}</div>
    </div>
  )
}

// ─── SVG diagram: Architecture Overview ───────────────────────────────────

function ArchitectureSvg() {
  const services = [
    ['Policy Engine', 'AuthZ Server', 'Supervisor'],
    ['MCP Sync', 'Radar', 'Session Mgr'],
    ['Secrets Store', 'Activity Log', 'Docker Mgr'],
  ]
  const harnesses = ['Claude Code', 'Codex', 'OpenClaw']
  return (
    <svg viewBox="0 0 660 300" className="docs-svg" fill="none">
      <rect x="290" y="10" width="80" height="28" rx="14" strokeWidth="0.5" style={{ fill: 'rgb(var(--d-blue) / 0.08)', stroke: 'rgb(var(--d-blue) / 0.25)' }} />
      <text x="330" y="28" textAnchor="middle" fontSize="11" fontFamily="'Geist', sans-serif" fontWeight="600" style={{ fill: 'rgb(var(--d-neutral) / 0.85)' }}>You</text>
      <line x1="330" y1="38" x2="330" y2="66" style={{ stroke: 'rgb(var(--d-neutral) / 0.1)' }} />
      <circle cx="330" cy="66" r="2" style={{ fill: 'rgb(var(--d-blue) / 0.5)' }} />
      <rect x="60" y="66" width="540" height="160" rx="8" style={{ fill: 'rgb(var(--d-neutral) / 0.02)', stroke: 'rgb(var(--d-neutral) / 0.08)' }} />
      <text x="80" y="86" fontSize="9" fontFamily="'Geist Mono', monospace" letterSpacing="1.5" style={{ fill: 'rgb(var(--d-neutral) / 0.25)' }}>LATCH DESKTOP</text>
      {services.map((row, ri) => row.map((name, ci) => (
        <g key={name}>
          <rect x={90 + ci * 170} y={96 + ri * 38} width="150" height="28" rx="4" strokeWidth="0.5" style={{ fill: 'rgb(var(--d-neutral) / 0.025)', stroke: 'rgb(var(--d-neutral) / 0.07)' }} />
          <text x={165 + ci * 170} y={113 + ri * 38} textAnchor="middle" fontSize="10" fontFamily="'Geist', sans-serif" style={{ fill: 'rgb(var(--d-neutral) / 0.5)' }}>{name}</text>
        </g>
      )))}
      {[150, 330, 510].map((hx) => (
        <g key={hx}>
          <line x1="330" y1="226" x2={hx} y2="258" style={{ stroke: 'rgb(var(--d-neutral) / 0.08)' }} />
          <circle cx={hx} cy="258" r="2" style={{ fill: 'rgb(var(--d-blue) / 0.5)' }} />
        </g>
      ))}
      {harnesses.map((name, i) => {
        const x = 150 + i * 180
        return (
          <g key={name}>
            <rect x={x - 55} y="258" width="110" height="28" rx="6" style={{ fill: 'rgb(var(--d-neutral) / 0.02)', stroke: 'rgb(var(--d-neutral) / 0.08)' }} />
            <text x={x} y="276" textAnchor="middle" fontSize="11" fontFamily="'Geist', sans-serif" fontWeight="500" style={{ fill: 'rgb(var(--d-neutral) / 0.7)' }}>{name}</text>
          </g>
        )
      })}
    </svg>
  )
}

// ─── SVG diagram: Process Model ───────────────────────────────────────────

function ProcessModelSvg() {
  return (
    <svg viewBox="0 0 660 370" className="docs-svg" fill="none">
      <rect x="40" y="10" width="580" height="100" rx="8" style={{ fill: 'rgb(var(--d-neutral) / 0.02)', stroke: 'rgb(var(--d-neutral) / 0.08)' }} />
      <text x="58" y="28" fontSize="9" fontFamily="'Geist Mono', monospace" letterSpacing="1.5" style={{ fill: 'rgb(var(--d-neutral) / 0.25)' }}>RENDERER</text>
      {['App', 'Sidebar', 'TerminalArea', 'Views', 'Modals'].map((n, i) => (
        <g key={n}>
          <rect x={58 + i * 110} y="38" width="96" height="22" rx="11" strokeWidth="0.5" style={{ fill: 'rgb(var(--d-blue) / 0.06)', stroke: 'rgb(var(--d-blue) / 0.15)' }} />
          <text x={106 + i * 110} y="52" textAnchor="middle" fontSize="10" fontFamily="'Geist', sans-serif" style={{ fill: 'rgb(var(--d-neutral) / 0.5)' }}>{n}</text>
        </g>
      ))}
      {['useAppStore', 'TerminalManager'].map((n, i) => (
        <g key={n}>
          <rect x={120 + i * 240} y="70" width="160" height="22" rx="4" strokeWidth="0.5" style={{ fill: 'rgb(var(--d-neutral) / 0.025)', stroke: 'rgb(var(--d-neutral) / 0.06)' }} />
          <text x={200 + i * 240} y="84" textAnchor="middle" fontSize="9" fontFamily="'Geist Mono', monospace" style={{ fill: 'rgb(var(--d-neutral) / 0.35)' }}>{n}</text>
        </g>
      ))}
      <line x1="120" y1="130" x2="540" y2="130" strokeDasharray="6 4" style={{ stroke: 'rgb(var(--d-blue) / 0.15)' }} />
      <text x="330" y="126" textAnchor="middle" fontSize="9" fontFamily="'Geist Mono', monospace" style={{ fill: 'rgb(var(--d-blue) / 0.5)' }}>contextBridge · IPC</text>
      <rect x="40" y="150" width="580" height="170" rx="8" style={{ fill: 'rgb(var(--d-neutral) / 0.02)', stroke: 'rgb(var(--d-neutral) / 0.08)' }} />
      <text x="58" y="168" fontSize="9" fontFamily="'Geist Mono', monospace" letterSpacing="1.5" style={{ fill: 'rgb(var(--d-neutral) / 0.25)' }}>MAIN PROCESS</text>
      <text x="58" y="188" fontSize="8" fontFamily="'Geist Mono', monospace" letterSpacing="1" style={{ fill: 'rgb(var(--d-neutral) / 0.2)' }}>SERVICES</text>
      {['AuthZ', 'Enforcer', 'Radar', 'McpSync', 'Supervisor'].map((n, i) => (
        <g key={n}>
          <rect x={58 + i * 112} y="194" width="100" height="22" rx="4" strokeWidth="0.5" style={{ fill: 'rgb(var(--d-neutral) / 0.025)', stroke: 'rgb(var(--d-neutral) / 0.06)' }} />
          <text x={108 + i * 112} y="208" textAnchor="middle" fontSize="9" fontFamily="'Geist', sans-serif" style={{ fill: 'rgb(var(--d-neutral) / 0.45)' }}>{n}</text>
        </g>
      ))}
      <text x="58" y="232" fontSize="8" fontFamily="'Geist Mono', monospace" letterSpacing="1" style={{ fill: 'rgb(var(--d-neutral) / 0.2)' }}>STORES</text>
      {['Session', 'Policy', 'Skills', 'MCP', 'Activity', 'Secret'].map((n, i) => (
        <g key={n}>
          <rect x={58 + i * 94} y="238" width="82" height="22" rx="4" strokeWidth="0.5" style={{ fill: 'rgb(var(--d-neutral) / 0.025)', stroke: 'rgb(var(--d-neutral) / 0.06)' }} />
          <text x={99 + i * 94} y="252" textAnchor="middle" fontSize="9" fontFamily="'Geist', sans-serif" style={{ fill: 'rgb(var(--d-neutral) / 0.45)' }}>{n}</text>
        </g>
      ))}
      <text x="58" y="276" fontSize="8" fontFamily="'Geist Mono', monospace" letterSpacing="1" style={{ fill: 'rgb(var(--d-neutral) / 0.2)' }}>INFRASTRUCTURE</text>
      {['PTY Manager', 'Docker Mgr', 'Git Workspaces', 'Harnesses'].map((n, i) => (
        <g key={n}>
          <rect x={58 + i * 142} y="282" width="126" height="22" rx="4" strokeWidth="0.5" style={{ fill: 'rgb(var(--d-neutral) / 0.025)', stroke: 'rgb(var(--d-neutral) / 0.06)' }} />
          <text x={121 + i * 142} y="296" textAnchor="middle" fontSize="9" fontFamily="'Geist', sans-serif" style={{ fill: 'rgb(var(--d-neutral) / 0.45)' }}>{n}</text>
        </g>
      ))}
      <line x1="330" y1="320" x2="330" y2="340" style={{ stroke: 'rgb(var(--d-neutral) / 0.08)' }} />
      <rect x="275" y="340" width="110" height="22" rx="11" strokeWidth="0.5" style={{ fill: 'rgb(var(--d-green) / 0.06)', stroke: 'rgb(var(--d-green) / 0.15)' }} />
      <text x="330" y="354" textAnchor="middle" fontSize="10" fontFamily="'Geist Mono', monospace" style={{ fill: 'rgb(var(--d-green) / 0.6)' }}>SQLite DB</text>
    </svg>
  )
}

// ─── SVG diagram: Authorization Flow ──────────────────────────────────────

function AuthFlowSvg() {
  const cascade = ['Rate limit', 'Classify', 'Tool rules', 'Cmd rules', 'MCP rules', 'Blocked globs', 'Permissions', 'LLM evaluator']
  return (
    <svg viewBox="0 0 660 390" className="docs-svg" fill="none">
      <circle cx="80" cy="28" r="12" style={{ fill: 'rgb(var(--d-neutral) / 0.03)', stroke: 'rgb(var(--d-neutral) / 0.12)' }} />
      <text x="80" y="32" textAnchor="middle" fontSize="10" fontWeight="600" fontFamily="'Geist Mono', monospace" style={{ fill: 'rgb(var(--d-neutral) / 0.5)' }}>1</text>
      <text x="106" y="26" fontSize="11" fontFamily="'Geist', sans-serif" fontWeight="500" style={{ fill: 'rgb(var(--d-neutral) / 0.7)' }}>Agent invokes tool</text>
      <text x="106" y="40" fontSize="9" fontFamily="'Geist', sans-serif" style={{ fill: 'rgb(var(--d-neutral) / 0.3)' }}>Harness fires PreToolUse hook</text>
      <line x1="80" y1="40" x2="80" y2="64" style={{ stroke: 'rgb(var(--d-neutral) / 0.08)' }} />
      <circle cx="80" cy="76" r="12" style={{ fill: 'rgb(var(--d-blue) / 0.06)', stroke: 'rgb(var(--d-blue) / 0.2)' }} />
      <text x="80" y="80" textAnchor="middle" fontSize="10" fontWeight="600" fontFamily="'Geist Mono', monospace" style={{ fill: 'rgb(var(--d-blue) / 0.7)' }}>2</text>
      <text x="106" y="74" fontSize="11" fontFamily="'Geist', sans-serif" fontWeight="500" style={{ fill: 'rgb(var(--d-neutral) / 0.7)' }}>POST /decide</text>
      <text x="106" y="88" fontSize="9" fontFamily="'Geist', sans-serif" style={{ fill: 'rgb(var(--d-neutral) / 0.3)' }}>AuthZ Server on localhost</text>
      <line x1="80" y1="88" x2="80" y2="112" style={{ stroke: 'rgb(var(--d-neutral) / 0.08)' }} />
      <circle cx="80" cy="124" r="12" style={{ fill: 'rgb(var(--d-blue) / 0.06)', stroke: 'rgb(var(--d-blue) / 0.2)' }} />
      <text x="80" y="128" textAnchor="middle" fontSize="10" fontWeight="600" fontFamily="'Geist Mono', monospace" style={{ fill: 'rgb(var(--d-blue) / 0.7)' }}>3</text>
      <text x="106" y="126" fontSize="11" fontFamily="'Geist', sans-serif" fontWeight="500" style={{ fill: 'rgb(var(--d-neutral) / 0.7)' }}>Evaluation cascade</text>
      <rect x="106" y="138" width="510" height="90" rx="6" style={{ fill: 'rgb(var(--d-neutral) / 0.015)', stroke: 'rgb(var(--d-neutral) / 0.06)' }} />
      {cascade.map((n, i) => {
        const col = i % 4, row = Math.floor(i / 4)
        return (
          <g key={n}>
            <rect x={120 + col * 124} y={150 + row * 32} width="110" height="22" rx="4" strokeWidth="0.5" style={{ fill: 'rgb(var(--d-neutral) / 0.025)', stroke: 'rgb(var(--d-neutral) / 0.06)' }} />
            <text x={175 + col * 124} y={164 + row * 32} textAnchor="middle" fontSize="9" fontFamily="'Geist', sans-serif" style={{ fill: 'rgb(var(--d-neutral) / 0.45)' }}>{n}</text>
          </g>
        )
      })}
      <line x1="80" y1="136" x2="80" y2="248" style={{ stroke: 'rgb(var(--d-neutral) / 0.08)' }} />
      <circle cx="80" cy="260" r="12" style={{ fill: 'rgb(var(--d-blue) / 0.06)', stroke: 'rgb(var(--d-blue) / 0.2)' }} />
      <text x="80" y="264" textAnchor="middle" fontSize="10" fontWeight="600" fontFamily="'Geist Mono', monospace" style={{ fill: 'rgb(var(--d-blue) / 0.7)' }}>4</text>
      <text x="106" y="262" fontSize="11" fontFamily="'Geist', sans-serif" fontWeight="500" style={{ fill: 'rgb(var(--d-neutral) / 0.7)' }}>Decision</text>
      <line x1="92" y1="272" x2="170" y2="310" style={{ stroke: 'rgb(var(--d-green) / 0.25)' }} />
      <rect x="130" y="310" width="80" height="24" rx="4" strokeWidth="0.5" style={{ fill: 'rgb(var(--d-green) / 0.06)', stroke: 'rgb(var(--d-green) / 0.18)' }} />
      <text x="170" y="326" textAnchor="middle" fontSize="10" fontFamily="'Geist Mono', monospace" fontWeight="600" style={{ fill: 'rgb(var(--d-green) / 0.8)' }}>ALLOW</text>
      <text x="170" y="344" textAnchor="middle" fontSize="8" fontFamily="'Geist', sans-serif" style={{ fill: 'rgb(var(--d-neutral) / 0.25)' }}>Tool executes</text>
      <line x1="92" y1="272" x2="330" y2="310" style={{ stroke: 'rgb(var(--d-red) / 0.25)' }} />
      <rect x="290" y="310" width="80" height="24" rx="4" strokeWidth="0.5" style={{ fill: 'rgb(var(--d-red) / 0.06)', stroke: 'rgb(var(--d-red) / 0.18)' }} />
      <text x="330" y="326" textAnchor="middle" fontSize="10" fontFamily="'Geist Mono', monospace" fontWeight="600" style={{ fill: 'rgb(var(--d-red) / 0.8)' }}>DENY</text>
      <text x="330" y="344" textAnchor="middle" fontSize="8" fontFamily="'Geist', sans-serif" style={{ fill: 'rgb(var(--d-neutral) / 0.25)' }}>Tool blocked</text>
      <line x1="92" y1="272" x2="490" y2="310" style={{ stroke: 'rgb(var(--d-yellow) / 0.25)' }} />
      <rect x="450" y="310" width="80" height="24" rx="4" strokeWidth="0.5" style={{ fill: 'rgb(var(--d-yellow) / 0.06)', stroke: 'rgb(var(--d-yellow) / 0.18)' }} />
      <text x="490" y="326" textAnchor="middle" fontSize="10" fontFamily="'Geist Mono', monospace" fontWeight="600" style={{ fill: 'rgb(var(--d-yellow) / 0.8)' }}>PROMPT</text>
      <text x="490" y="344" textAnchor="middle" fontSize="8" fontFamily="'Geist', sans-serif" style={{ fill: 'rgb(var(--d-neutral) / 0.25)' }}>Supervisor or UI</text>
      <text x="80" y="380" fontSize="9" fontFamily="'Geist', sans-serif" style={{ fill: 'rgb(var(--d-neutral) / 0.2)' }}>Then: 5. Supervisor handles  ·  6. Activity logged  ·  7. Radar analysis</text>
    </svg>
  )
}

// ─── SVG diagram: Session Lifecycle ───────────────────────────────────────

function SessionFlowSvg() {
  const steps: [string, string][] = [
    ['Create Session', ''],
    ['Session Wizard', 'Directory · Harness · Policy · Goal · Docker'],
    ['Git Worktree', 'Isolated branch from HEAD'],
    ['Policy Enforcement', 'Compile universal → harness-native config'],
    ['AuthZ Registration', 'Bind policy + harness for runtime decisions'],
    ['PTY Spawn', 'Shell process with injected env vars'],
    ['Ready', 'Terminal live, all systems armed'],
  ]
  return (
    <svg viewBox="0 0 660 320" className="docs-svg" fill="none">
      <line x1="80" y1="24" x2="80" y2="300" style={{ stroke: 'rgb(var(--d-neutral) / 0.06)' }} />
      {steps.map(([label, sub], i) => {
        const y = 24 + i * 44
        const isLast = i === steps.length - 1
        const base = isLast ? '--d-green' : '--d-blue'
        return (
          <g key={label}>
            <circle cx="80" cy={y} r="8" style={{ fill: `rgb(var(${base}) / 0.06)`, stroke: `rgb(var(${base}) / ${isLast ? 0.2 : 0.15})` }} />
            <circle cx="80" cy={y} r="3" style={{ fill: `rgb(var(${base}) / 0.5)` }} />
            <text x="100" y={y + 1} fontSize="11" fontFamily="'Geist', sans-serif" fontWeight="500" dominantBaseline="middle" style={{ fill: 'rgb(var(--d-neutral) / 0.7)' }}>{label}</text>
            {sub && <text x="100" y={y + 14} fontSize="9" fontFamily="'Geist', sans-serif" style={{ fill: 'rgb(var(--d-neutral) / 0.28)' }}>{sub}</text>}
          </g>
        )
      })}
    </svg>
  )
}

// ─── Feature card ──────────────────────────────────────────────────────────

function FeatureCard({ icon, title, summary, detailId, expanded, onToggle, children }: {
  icon: string
  title: string
  summary: string
  detailId: string
  expanded: boolean
  onToggle: (id: string) => void
  children: React.ReactNode
}) {
  return (
    <div className="docs-feature-card">
      <div className="docs-feature-header">
        <span className="docs-feature-icon">{icon}</span>
        <h4 className="docs-feature-title">{title}</h4>
      </div>
      <p className="docs-feature-summary">{summary}</p>
      <Details id={detailId} title="Technical details" expanded={expanded} onToggle={onToggle}>
        {children}
      </Details>
    </div>
  )
}

// ─── Main component ────────────────────────────────────────────────────────

export default function DocsView() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const isExpanded = (id: string) => expanded.has(id)

  return (
    <div className="view-container docs-view">

      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <section className="docs-hero">
        <pre className="docs-ascii-logo">{ASCII_LOGO}</pre>
        <h1 className="docs-hero-tagline">Mission control for AI coding agents.</h1>
        <p className="docs-hero-sub">
          One desktop app to govern, observe, and orchestrate Claude Code, Codex, and OpenClaw —
          without giving up control of your machine.
        </p>
      </section>

      {/* ── WHY ───────────────────────────────────────────────────────── */}
      <section className="docs-section">
        <h2 className="docs-section-title">Why Latch exists</h2>
        <p className="docs-section-intro">
          AI coding agents are incredibly powerful, but running them today means accepting
          tradeoffs that nobody should have to make.
        </p>

        <div className="docs-pillar-grid">
          <div className="docs-pillar-card">
            <h3 className="docs-pillar-heading">Blind Trust</h3>
            <p className="docs-pillar-text">
              Agents run tools with zero visibility into what's actually happening.
              You auto-approve prompts and hope for the best. There's no audit trail,
              no anomaly detection, no way to know if an agent is doing something unexpected
              until the damage is done.
            </p>
          </div>
          <div className="docs-pillar-card">
            <h3 className="docs-pillar-heading">No Guardrails</h3>
            <p className="docs-pillar-text">
              Harnesses only offer blunt permission modes — full auto-approve or painful
              click-every-prompt. There's no middle ground. You can't say "allow reads,
              prompt on writes to /etc, block network access" without hacking config files
              by hand.
            </p>
          </div>
          <div className="docs-pillar-card">
            <h3 className="docs-pillar-heading">Fragmented Tooling</h3>
            <p className="docs-pillar-text">
              Each harness has its own config format, MCP setup, permission model, and
              settings file. Switching between Claude Code and Codex means maintaining
              parallel configurations. Skills, policies, and secrets don't transfer.
            </p>
          </div>
        </div>
      </section>

      {/* ── WHAT ──────────────────────────────────────────────────────── */}
      <section className="docs-section">
        <h2 className="docs-section-title">What Latch does</h2>
        <p className="docs-section-intro">
          Latch is a desktop app that wraps your coding agents in a unified control plane.
          Four capabilities, one interface.
        </p>

        <div className="docs-capability-grid">
          <div className="docs-capability-card">
            <span className="docs-capability-tag">GOVERN</span>
            <h3 className="docs-capability-heading">Fine-grained policies</h3>
            <p className="docs-capability-text">
              Write policies once in a universal JSON format. Latch compiles them down to
              harness-native configs — Claude Code's <code>settings.json</code>, Codex's
              <code> config.toml</code> + <code>.rules</code>, OpenClaw equivalents. Tool rules,
              command regex, MCP server controls, blocked globs, and an LLM evaluator fallback
              for ambiguous calls.
            </p>
          </div>
          <div className="docs-capability-card">
            <span className="docs-capability-tag">OBSERVE</span>
            <h3 className="docs-capability-heading">Real-time activity feed</h3>
            <p className="docs-capability-text">
              Every tool call is logged with classification (read / write / execute / send),
              risk level, and authorization decision. Radar runs z-score anomaly detection
              across sliding time windows to catch unusual patterns — volume spikes, error
              rate changes, novel tool usage.
            </p>
          </div>
          <div className="docs-capability-card">
            <span className="docs-capability-tag">PROTECT</span>
            <h3 className="docs-capability-heading">Runtime authorization</h3>
            <p className="docs-capability-text">
              A local HTTP authorization server evaluates every tool call before execution.
              Harnesses hook into it via their native hook systems (Claude Code's <code>hooks.json</code>,
              Codex's event hooks). Decisions cascade through tool rules → command rules →
              MCP rules → blocked globs → permission flags → LLM evaluator.
            </p>
          </div>
          <div className="docs-capability-card">
            <span className="docs-capability-tag">ORCHESTRATE</span>
            <h3 className="docs-capability-heading">Isolated sessions</h3>
            <p className="docs-capability-text">
              Each session gets its own git worktree, Docker container (optional), policy
              set, MCP servers, and secrets scope. Run multiple agents in parallel on
              different branches of the same repo without conflicts. The supervisor agent
              watches terminal output and auto-handles prompts.
            </p>
          </div>
        </div>

        <DiagramCard label="Architecture Overview"><ArchitectureSvg /></DiagramCard>
      </section>

      {/* ── HOW ───────────────────────────────────────────────────────── */}
      <section className="docs-section">
        <h2 className="docs-section-title">How it works</h2>
        <p className="docs-section-intro">
          Under the hood, Latch is an Electron app with a clean three-layer architecture.
          Let's go deep.
        </p>

        {/* The Stack */}
        <h3 className="docs-subsection-title">The Stack</h3>
        <DiagramCard label="Process Model"><ProcessModelSvg /></DiagramCard>

        {/* The AuthZ Loop */}
        <h3 className="docs-subsection-title">The Authorization Loop</h3>
        <p className="docs-body-text">
          This is the centerpiece of Latch's security model. Every tool call goes through
          a 7-step evaluation pipeline before it can execute.
        </p>
        <DiagramCard label="Authorization Flow"><AuthFlowSvg /></DiagramCard>

        {/* Session Lifecycle */}
        <h3 className="docs-subsection-title">Session Lifecycle</h3>
        <DiagramCard label="Session Creation Flow"><SessionFlowSvg /></DiagramCard>
      </section>

      {/* ── FEATURES ──────────────────────────────────────────────────── */}
      <section className="docs-section">
        <h2 className="docs-section-title">Feature deep dives</h2>

        <div className="docs-feature-grid">
          <FeatureCard
            icon="▶"
            title="Sessions & Terminals"
            summary="Each session wraps one or more terminal tabs, each with its own PTY process. Terminals are always-mounted in the DOM — CSS visibility toggling preserves scrollback history."
            detailId="sessions"
            expanded={isExpanded('sessions')}
            onToggle={toggle}
          >
            <p>
              PTY processes are managed by <code>node-pty</code> in the main process. The key insight
              is that the PTY key is the <strong>tab ID</strong>, not the session ID — each tab gets its
              own shell. The session wizard renders as an overlay inside <code>TerminalArea</code>,
              not a global modal, so the terminal underneath stays mounted.
            </p>
            <p>
              <code>TerminalManager</code> is a singleton that lives outside React's render cycle.
              It manages xterm.js instances imperatively, handles fit-on-resize via <code>requestAnimationFrame</code>,
              and routes PTY data to the correct terminal via tab ID lookup. React StrictMode is
              intentionally disabled to prevent double-registration of data listeners.
            </p>
          </FeatureCard>

          <FeatureCard
            icon="◆"
            title="Policy Engine"
            summary="Policies are defined in a universal JSON format with tool rules, command regex patterns, MCP server controls, blocked globs, and permission flags. Latch compiles them to harness-native configs."
            detailId="policies"
            expanded={isExpanded('policies')}
            onToggle={toggle}
          >
            <p>
              A single <code>PolicyDocument</code> contains a <code>permissions</code> block (universal flags
              like <code>allowBash</code>, <code>blockedGlobs</code>) and a <code>harnesses</code> block with
              per-harness overrides (<code>claude.toolRules</code>, <code>codex.approvalMode</code>).
            </p>
            <p>
              The <code>PolicyEnforcer</code> service compiles these to native formats: Claude Code
              gets a <code>settings.json</code> with tool permissions, Codex gets a <code>config.toml</code> +
              Starlark <code>.rules</code> file with prefix rules. The policy can also be AI-generated —
              describe what you want in natural language and the <code>PolicyGenerator</code> produces
              a valid <code>PolicyDocument</code>.
            </p>
          </FeatureCard>

          <FeatureCard
            icon="⊕"
            title="Authorization Server"
            summary="A local HTTP server that evaluates every tool call in real time. Harnesses POST to it via their native hook systems before executing any tool."
            detailId="authz"
            expanded={isExpanded('authz')}
            onToggle={toggle}
          >
            <p>
              The server listens on a random localhost port (injected into the PTY environment).
              It classifies each tool call by action type (read/write/execute/send) and risk level
              (low/medium/high), then runs through the policy evaluation cascade.
            </p>
            <p>
              Rate limiting is per-session, per-tool to catch runaway agents. The optional LLM
              evaluator provides a semantic fallback — it receives the tool call context and the
              session's declared intent, then decides if the action aligns. This catches cases
              where pattern matching alone isn't sufficient.
            </p>
          </FeatureCard>

          <FeatureCard
            icon="⚡"
            title="Supervisor Agent"
            summary="A background agent that monitors terminal output for permission prompts and automatically types yes or no based on the authorization decision."
            detailId="supervisor"
            expanded={isExpanded('supervisor')}
            onToggle={toggle}
          >
            <p>
              When the AuthZ server returns a PROMPT decision, it also queues a <code>SupervisorAction</code>.
              The supervisor watches the registered tab's PTY output for harness-specific permission
              prompt patterns (e.g., Claude Code's "Allow?" prompt, Codex's approval prompt).
            </p>
            <p>
              If the policy says allow, the supervisor auto-types the approval. If the policy says
              deny, it types the denial. If neither applies (true PROMPT), it escalates to the
              Latch approval bar in the UI for a human decision. This bridges the gap between
              Latch's authorization model and each harness's native prompt flow.
            </p>
          </FeatureCard>

          <FeatureCard
            icon="⬡"
            title="MCP Server Management"
            summary="Register MCP servers once in Latch, then sync them to all harnesses simultaneously. Supports stdio and HTTP transports with secret-aware environment variables."
            detailId="mcp"
            expanded={isExpanded('mcp')}
            onToggle={toggle}
          >
            <p>
              The <code>McpSync</code> service writes harness-native MCP configurations — Claude Code's
              <code> .mcp.json</code>, Codex's MCP config. Each server record includes transport type,
              command/args (stdio) or URL/headers (HTTP), and which harnesses it applies to.
            </p>
            <p>
              <code>MCP Introspect</code> can probe a running server to discover available tools and
              their descriptions. These tool names feed into policy rules — you can write a tool rule
              like <code>mcp__github__*: deny</code> to block all GitHub MCP tools without knowing
              every tool name upfront.
            </p>
          </FeatureCard>

          <FeatureCard
            icon="◎"
            title="Activity Log & Radar"
            summary="Every tool call is logged with classification, risk level, and authorization decision. Radar runs z-score anomaly detection to catch unusual patterns."
            detailId="radar"
            expanded={isExpanded('radar')}
            onToggle={toggle}
          >
            <p>
              The activity store persists all events to SQLite with full export support (JSON/CSV).
              Each event records the tool name, action class, risk level, decision, reasoning, and
              harness ID.
            </p>
            <p>
              Radar runs configurable sliding-window analysis: it computes z-scores for tool call
              volume, error rates, and tool diversity. When a z-score exceeds the sensitivity
              threshold (configurable: low/medium/high), it emits a <code>RadarSignal</code> that
              appears in the Radar view with severity level. This catches things like an agent
              suddenly making 10x more API calls than usual.
            </p>
          </FeatureCard>

          <FeatureCard
            icon="□"
            title="Docker Sandbox"
            summary="Optionally run agent sessions inside ephemeral Docker containers with configurable network access, port mappings, and volume mounts."
            detailId="docker"
            expanded={isExpanded('docker')}
            onToggle={toggle}
          >
            <p>
              The <code>DockerManager</code> handles image pulling, container lifecycle (start/stop),
              and status monitoring. It auto-detects the project's tech stack to suggest an
              appropriate base image (Node, Python, Go, Rust, etc.).
            </p>
            <p>
              Network access is controlled per-container — you can run an agent in a fully
              air-gapped sandbox. Volume mounts are configured to bind the workspace directory
              (read-write) and optionally mount additional paths (read-only). The PTY spawns
              inside the container via <code>docker exec</code> when sandbox mode is active.
            </p>
          </FeatureCard>

          <FeatureCard
            icon="⛊"
            title="Gateway & Services"
            summary="Secure service integration through a proxy architecture that injects credentials, enforces data-tier policies, and produces cryptographic attestation receipts."
            detailId="gateway"
            expanded={isExpanded('gateway')}
            onToggle={toggle}
          >
            <p>
              The Gateway proxy intercepts outbound requests from agent sessions and applies
              per-service rules. Each <code>ServiceDefinition</code> declares allowed domains,
              credential injection headers, data tier classification, and redaction patterns.
              Credentials are resolved from the encrypted secrets store at request time and
              never exposed to the agent process.
            </p>
            <p>
              Sandbox enforcement ensures agents can only reach services explicitly configured
              in the active policy. Requests to unlisted domains are blocked by default. The
              proxy logs every request as a <code>ProxyAuditEvent</code> with method, domain,
              path, and allow/deny decision for full traceability.
            </p>
            <p>
              At session end, the Gateway produces a <code>SessionReceipt</code> containing a
              Merkle root over all audit events and a cryptographic signature. This receipt
              can be attached to pull requests as a provenance annotation, proving which
              external services were accessed and what policy was in effect.
            </p>
            <p>
              Service definitions follow a declarative schema covering credential type
              (token, keypair, OAuth, env-bundle), injection method (environment variables,
              files, proxy headers), and data-tier redaction rules. A built-in catalog
              provides pre-configured definitions for common services like GitHub, AWS, and
              npm that can be customized before installation.
            </p>
          </FeatureCard>

          <FeatureCard
            icon="⎇"
            title="Git Worktree Isolation"
            summary="Each session gets its own git worktree and branch, so multiple agents can work on the same repo in parallel without conflicts."
            detailId="git"
            expanded={isExpanded('git')}
            onToggle={toggle}
          >
            <p>
              When a session is created with a project directory that's a git repo, Latch
              creates a git worktree at <code>~/.latch/workspaces/&lt;session-name&gt;</code> with
              a new branch based on the current HEAD. This gives the agent a fully isolated
              working copy.
            </p>
            <p>
              Worktrees are listed, created, and removed via the <code>git-workspaces</code> library
              in the main process. When a session is deleted, its worktree is cleaned up
              automatically. The branch name follows a <code>latch/&lt;session-name&gt;</code> convention
              for easy identification in git log.
            </p>
          </FeatureCard>

          <FeatureCard
            icon="✦"
            title="Skills"
            summary="Reusable instruction packages that teach agents how to work in your codebase. Scoped per-harness, following the agentskills.io specification."
            detailId="skills"
            expanded={isExpanded('skills')}
            onToggle={toggle}
          >
            <p>
              Skills are stored in SQLite and synced to harness-native locations — Claude Code's
              <code> .claude/skills/</code> directory, Codex's equivalent. Each skill has a name,
              description, body (the actual instructions), tags for organization, and a harness
              scope (which harnesses should receive it).
            </p>
            <p>
              The <code>SkillsStore</code> handles CRUD operations while <code>syncSkills</code> writes
              the skill files to the appropriate directories. Skills can be imported from
              existing repo files or written from scratch in the Skills editor.
            </p>
          </FeatureCard>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <footer className="docs-footer">
        <span className="docs-footer-text">
          Latch Desktop — built for developers who want AI agents that are powerful <em>and</em> accountable.
        </span>
      </footer>
    </div>
  )
}
