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

// ─── Diagram wrapper ───────────────────────────────────────────────────────

function Diagram({ label, children }: { label: string; children: string }) {
  return (
    <div className="docs-diagram">
      <div className="docs-diagram-label">{label}</div>
      <pre className="docs-diagram-pre">{children}</pre>
    </div>
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

        <Diagram label="Architecture Overview">{
`┌─────────────────────────────────────────────────────────┐
│                       Y O U                             │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                  LATCH DESKTOP                          │
│                                                         │
│  Policy Engine ─── AuthZ Server ─── Supervisor          │
│  MCP Sync ──────── Radar ────────── Session Manager     │
│  Secrets Vault ─── Activity Log ─── Docker Manager      │
└──────┬──────────────────┬──────────────────┬────────────┘
       │                  │                  │
       ▼                  ▼                  ▼
  Claude Code          Codex            OpenClaw`
        }</Diagram>
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
        <Diagram label="Process Model">{
`┌─────────────────────────────────────────────────────────┐
│ Renderer Process (React 18 + Zustand)                   │
│                                                         │
│  App ── Sidebar ── TerminalArea ── Views ── Modals      │
│  useAppStore (all state) │ TerminalManager (xterm.js)   │
└────────────────┬────────────────────────────────────────┘
                 │  contextBridge (window.latch)
                 │  IPC: latch:<module>-<action>
┌────────────────┴────────────────────────────────────────┐
│ Main Process (Node.js + Electron)                       │
│                                                         │
│  Services:                                              │
│    AuthZ Server ── Policy Enforcer ── Policy Generator   │
│    MCP Sync ────── Radar ─────────── Telemetry          │
│    Supervisor ──── Secret Resolver ── LLM Evaluator     │
│                                                         │
│  Stores (SQLite):                                       │
│    SessionStore ── PolicyStore ── SkillsStore            │
│    McpStore ────── ActivityStore ── FeedStore            │
│    SettingsStore ── SecretStore                          │
│                                                         │
│  Infrastructure:                                        │
│    PTY Manager (node-pty) ── Docker Manager              │
│    Git Workspaces ────────── Harness Detection           │
└────────────────┬────────────────────────────────────────┘
                 │
         ┌───────┴───────┐
         │  SQLite DB     │
         │  (userData/)   │
         └───────────────┘`
        }</Diagram>

        {/* The AuthZ Loop */}
        <h3 className="docs-subsection-title">The Authorization Loop</h3>
        <p className="docs-body-text">
          This is the centerpiece of Latch's security model. Every tool call goes through
          a 7-step evaluation pipeline before it can execute.
        </p>
        <Diagram label="Authorization Flow">{
`1. Agent invokes tool
   │  └─ Harness fires PreToolUse hook (Claude Code)
   │     or event hook (Codex)
   │
   ▼
2. POST /decide → AuthZ Server (localhost:{port})
   │  Payload: { tool_name, tool_input, session_id, harness_id }
   │
   ▼
3. Evaluation cascade
   │
   │  ┌─ Rate limit check (per-session, per-tool)
   │  ├─ Tool classification (read / write / execute / send)
   │  ├─ Tool rules (pattern match: "Bash", "mcp__github__*")
   │  ├─ Command rules (regex: "rm -rf", "curl.*|sh")
   │  ├─ MCP server rules (per-server allow/deny/prompt)
   │  ├─ Blocked globs ("/etc/**", "~/.ssh/**")
   │  ├─ Permission flags (allowBash, allowNetwork, allowFileWrite)
   │  └─ LLM evaluator fallback (intent-based, configurable scope)
   │
   ▼
4. Decision
   │  ├─ ALLOW (200) → tool executes normally
   │  ├─ DENY  (403) → tool blocked, reason returned to agent
   │  └─ PROMPT       → escalate to supervisor or Latch UI
   │
   ▼
5. Supervisor (if PROMPT)
   │  └─ Watches terminal for permission prompt
   │     Types "yes" (approve) or "no" (deny) automatically
   │     Or escalates to Latch approval bar for human decision
   │
   ▼
6. Activity logged
   │  └─ tool_name, action_class, risk, decision, timestamp
   │
   ▼
7. Radar analysis
      └─ z-score anomaly detection across sliding windows
         Volume spikes, error rates, novel tool patterns`
        }</Diagram>

        {/* Session Lifecycle */}
        <h3 className="docs-subsection-title">Session Lifecycle</h3>
        <Diagram label="Session Creation Flow">{
`Create Session
   │
   ▼
Session Wizard (modal overlay)
   │  ├─ Pick project directory
   │  ├─ Select harness (Claude Code / Codex / OpenClaw)
   │  ├─ Choose or create policy
   │  ├─ Set goal description
   │  └─ Configure Docker sandbox (optional)
   │
   ▼
Git Worktree
   │  └─ git worktree add ~/.latch/workspaces/<session>
   │     Creates isolated branch from current HEAD
   │
   ▼
Policy Enforcement
   │  └─ Compile universal policy → harness-native config
   │     Write hooks.json / config.toml / .rules to worktree
   │
   ▼
AuthZ Registration
   │  └─ Register session with AuthZ server
   │     Bind policy + harness ID for runtime decisions
   │
   ▼
PTY Spawn
   │  └─ node-pty creates shell process
   │     CWD = worktree path, ENV includes authz port
   │     Harness command injected as first shell input
   │
   ▼
Ready
      └─ Terminal live, agent running, all systems armed`
        }</Diagram>
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
            icon="⊡"
            title="Secrets Vault"
            summary="An encrypted key-value store for API keys and tokens. Secrets are referenced as ${secret:KEY} in MCP server configs and environment variables, resolved at runtime."
            detailId="vault"
            expanded={isExpanded('vault')}
            onToggle={toggle}
          >
            <p>
              Secrets are encrypted at rest in SQLite using the OS keychain-derived encryption key.
              Raw values never cross the IPC boundary to the renderer — only metadata (name, key,
              description, tags) is exposed. The renderer can create and delete secrets but never
              read their values.
            </p>
            <p>
              The <code>SecretResolver</code> service substitutes <code>{'${secret:KEY}'}</code> references in MCP
              server environment variables and Docker configs at PTY spawn time. Secret values are
              also redacted from activity logs and terminal output where possible.
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
