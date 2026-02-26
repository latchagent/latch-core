# Latch Desktop

A terminal-first control plane for  agents. Latch wraps real PTY shells, manages git worktrees, enforces security policies, and coordinates multi-agent workflows — all from a single desktop app.

## What it does

Latch sits between you and your AI coding harnesses (Claude Code, Codex, OpenClaw, and others), giving you:

- **Multi-harness terminals** — Run multiple AI agents side-by-side in real terminal tabs, each with its own PTY process
- **Policy enforcement** — Define what agents can and can't do (file writes, network access, shell commands, tool calls, etc) and enforce it at runtime via a local authorization server
- **Git worktree isolation** — Each session gets its own worktree so agents never clobber each other's work
- **Activity monitoring** — Real-time feed of every tool call, with anomaly detection (Radar) that flags suspicious patterns
- **Docker sandboxing** — Optionally run agent sessions inside containers for full isolation
- **MCP server management** — Configure and sync MCP servers across harnesses from one place
- **Skills library** — Install and manage agent skills, synced to each harness's native format

## Supported harnesses

| Harness | CLI | Status |
|---------|-----|--------|
| Claude Code | `claude` | Fully supported |
| Codex | `codex` | Fully supported |
| OpenClaw | `openclaw` | Fully supported |
| Droid (Factory.ai) | `droid` | Basic support |

## Quick start

```bash
git clone https://github.com/latchagent/latch-core.git
cd latch-core
npm install          # installs deps + rebuilds native modules
npm run dev          # launches the app with hot reload
```

> **Requires Node.js 20+** and a platform supported by Electron (macOS, Linux, Windows).

## Development

```bash
npm run dev                        # launch with Vite HMR
LATCH_DEVTOOLS=1 npm run dev       # launch with DevTools open
npm run build                      # production build → out/
npm run typecheck                  # type-check main + renderer
npm run test                       # run tests (vitest)
npm run lint                       # eslint
npm run format                     # prettier
```

### Architecture

Latch is an Electron app with three process layers:

```
┌─────────────────────────────────────────────────┐
│  Renderer (React 18 + Zustand)                  │
│  xterm.js terminals, policy UI, activity feed   │
├─────────────────────────────────────────────────┤
│  Preload (contextBridge)                        │
│  window.latch API — 50+ typed IPC methods       │
├─────────────────────────────────────────────────┤
│  Main (Node.js)                                 │
│  PTY manager, SQLite stores, authz server,      │
│  policy enforcer, Docker manager, git worktrees │
└─────────────────────────────────────────────────┘
```

### Project layout

```
src/
├── main/
│   ├── index.ts              # Entry point + all IPC handlers
│   ├── stores/               # SQLite data access (sessions, policies, skills, ...)
│   ├── services/             # Business logic (authz, policy enforcement, radar, ...)
│   └── lib/                  # Infrastructure (PTY, Docker, git, harness detection)
├── preload/
│   └── index.ts              # contextBridge → window.latch
├── renderer/
│   ├── App.tsx               # Root component
│   ├── store/useAppStore.ts  # Zustand state
│   ├── components/           # Sidebar, Topbar, Rail, panels, modals
│   ├── terminal/             # xterm.js manager
│   └── styles.css            # Dark theme, CSS custom properties
└── types/
    └── index.ts              # Shared TypeScript interfaces
```

## How policy enforcement works

When you assign a policy to a session, Latch:

1. **Generates harness-native config** — `.claude/settings.json` for Claude Code, `.codex/config.toml` + Starlark rules for Codex, `openclaw.json` + plugin for OpenClaw
2. **Starts a local authz server** — Listens on `127.0.0.1` with a shared secret
3. **Intercepts tool calls** — Via Claude's `PreToolUse` hook, Codex's notify hook, or OpenClaw's `before_tool_call` plugin
4. **Evaluates against policy** — Checks permission flags, tool rules, blocked globs, command patterns
5. **Logs everything** — Every decision (allow/deny) is recorded in the activity store and pushed to the renderer in real time

Policies support per-harness tool rules, MCP server rules, command pattern matching, and interactive approval for destructive operations.

## Agent Skills

The `.agents/skills/` directory contains development skills following the [agentskills.io spec](https://agentskills.io/specification). These teach contributor agents how to work in this codebase:

| Skill | What it teaches |
|-------|----------------|
| `adding-ipc-handlers` | The 4-file IPC flow: types, preload, main handler, renderer |
| `adding-sqlite-stores` | SQLite store class pattern with migrations and wiring |
| `adding-react-components` | Panels, modals, Zustand, Rail registration, CSS tokens |
| `adding-service-modules` | Main-process services: lifecycle, dependencies, testing |
| `running-and-testing` | Build, dev, typecheck, vitest, native module gotchas |

These are symlinked into `.claude/skills/` for automatic Claude Code discovery.

## Contributing

1. Fork the repo and create a feature branch
2. Make your changes — the agent skills in `.agents/skills/` will help your AI agent understand the codebase patterns
3. Run `npm run typecheck && npm run test && npm run build` to verify
4. Open a pull request

See `CLAUDE.md` for detailed architecture documentation and `AGENTS.md` for agent-specific guidance.

## Stack

- **Electron 39** — Desktop shell
- **React 18** + **Zustand** — Renderer UI and state
- **xterm.js** — Terminal emulation
- **node-pty** — Native PTY processes
- **better-sqlite3** — Local persistence
- **electron-vite** — Build system (three Vite builds: main, preload, renderer)
- **Vitest** — Testing
- **TypeScript** — Throughout
