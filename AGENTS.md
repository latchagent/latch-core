# Latch Desktop — Agent Guide

Primary reference for AI coding agents (Codex, OpenClaw, etc.) working on this codebase.

---

## What is Latch Desktop?

An Electron app that acts as a terminal-first control plane for LLM coding
harnesses (Claude Code, Codex, OpenClaw, OpenCode). It wraps real PTY shells,
manages git worktrees, enforces policies, tracks usage/budgets, provides
conversation replay/analytics, and integrates with GitHub/Linear issues.

---

## Tech stack

| Layer         | Technology                                          |
|---------------|-----------------------------------------------------|
| Desktop shell | Electron (electron-vite build system)               |
| Language      | TypeScript throughout (ESM imports, no `require()`) |
| Renderer      | React 18 + Zustand state management                 |
| Terminal      | xterm.js v5 (@xterm/xterm) + FitAddon               |
| PTY           | node-pty (native addon)                             |
| Database      | better-sqlite3 (native addon)                       |
| IPC validation| Zod schemas (`src/main/lib/ipc-schemas.ts`)         |
| Styling       | CSS custom properties, Geist Sans/Mono fonts        |
| Build output  | `out/` directory (3 Vite builds: main, preload, renderer) |

---

## Quick start

```bash
npm install       # installs deps + runs electron-rebuild for native addons
npm run dev       # launches Electron app with Vite HMR
npm run build     # production build -> out/
npm run typecheck # runs tsc for both main + renderer configs
npm test          # vitest run
```

Set `LATCH_DEVTOOLS=1` to open Chromium DevTools on launch.

---

## Directory layout

```
src/
  main/                         # Main process (TypeScript, ESM)
    index.ts                    # BrowserWindow + all ipcMain.handle() calls
    stores/                     # SQLite data access layer
      session-store.ts          # Sessions, policy overrides
      policy-store.ts           # Global policy definitions
      skills-store.ts           # Skills bank + harness sync
      mcp-store.ts              # MCP server configurations
      activity-store.ts         # Tool-call activity log
      feed-store.ts             # Agent status feed
      settings-store.ts         # Encrypted key-value settings
      usage-store.ts            # Token/cost usage events
      checkpoint-store.ts       # Git checkpoint metadata
      conversation-store.ts     # Conversation replay data
      service-store.ts          # Gateway service definitions
      attestation-store.ts      # Session attestation/receipts
      secret-store.ts           # Encrypted secrets
      issue-store.ts            # Local issue cache (GitHub/Linear)
    services/                   # Business logic & background services
      authz-server.ts           # Runtime tool-call authorization (HTTP server)
      policy-enforcer.ts        # Harness-native config generation
      policy-generator.ts       # AI-assisted policy generation
      checkpoint-engine.ts      # Git checkpoint creation & rewind
      budget-enforcer.ts        # Cost budget limits + alerts
      live-tailer.ts            # Real-time session event tailing
      usage-watcher.ts          # Token usage tracking from JSONL logs
      supervisor.ts             # Auto-approval agent for tool calls
      radar.ts                  # Anomaly detection engine
      latch-proxy.ts            # HTTP proxy for gateway/enclave
      attestation.ts            # Cryptographic session receipts
      credential-manager.ts     # Service credential lifecycle
      data-classifier.ts        # LLM-assisted data classification
      github-issues.ts          # GitHub Issues API integration
      linear-issues.ts          # Linear API integration
      issue-sync.ts             # Bidirectional issue sync
      mcp-sync.ts               # MCP config sync to harnesses
      mcp-introspect.ts         # MCP server tool discovery
      skill-generator.ts        # AI skill generation
      pr-annotator.ts           # GitHub PR annotation with session receipts
      llm-evaluator.ts          # LLM-based tool-call evaluation
      telemetry.ts              # Anonymous usage telemetry
      updater.ts                # Auto-update lifecycle
      debug-log.ts              # Debug logging
    lib/                        # Infrastructure
      pty-manager.ts            # PTY lifecycle via node-pty
      ipc-schemas.ts            # Zod schemas for IPC payload validation
      git-workspaces.ts         # Git worktree create/list/remove
      harnesses.ts              # Detect installed harnesses (claude/codex/openclaw/opencode)
      service-catalog.ts        # Built-in service definitions (GitHub, npm, etc.)
      docker-manager.ts         # Docker container management
      gateway-manager.ts        # Gateway orchestration (proxy + sandbox + services)
      timeline-parser.ts        # Parse Claude JSONL / OpenCode SSE conversation logs
      timeline-classifier.ts    # Classify conversation turns by work phase
      conversation-source.ts    # Multi-harness conversation source abstraction
      analytics-engine.ts       # Conversation analytics (loops, cache pressure, etc.)
      loop-detector.ts          # Detect wasteful tool-call loops
      pricing.ts                # LLM token pricing tables
      leak-scanner.ts           # Detect secrets in text (API keys, tokens)
      op-connect.ts             # 1Password CLI integration
      merkle.ts                 # Merkle tree for audit log integrity
      canonical-json.ts         # Deterministic JSON serialization
      credential-utils.ts       # Credential encryption helpers
      safe-regex.ts             # Safe regex execution with timeout
  preload/
    index.ts                    # contextBridge -> window.latch API
  renderer/                     # Renderer process (React + TypeScript)
    main.tsx                    # React entry point
    App.tsx                     # Root component, PTY listeners, layout
    index.html                  # Minimal HTML shell with CSP
    styles.css                  # Dark theme, Geist Sans/Mono
    store/
      useAppStore.ts            # Zustand store — all app state + actions
    terminal/
      TerminalManager.ts        # Singleton managing xterm.js instances
      TerminalWizard.ts         # Session creation wizard in terminal
      CommandRunner.ts          # Shell command execution helper
      ansi.ts                   # ANSI escape code utilities
      prompts.ts                # Terminal prompt rendering
    components/
      Sidebar.tsx               # Session list + navigation
      Topbar.tsx                # Status bar (harness, policy, session info)
      TerminalArea.tsx          # Tab bar + xterm panes (always-mounted)
      Rail.tsx                  # Right-side rail tabs + panel switching
      ApprovalBar.tsx           # Tool-call approval UI
      WelcomeScreen.tsx         # First-run onboarding
      LiveView.tsx              # Real-time session monitoring
      ReplayView.tsx            # Conversation replay player
      UsageView.tsx             # Token usage dashboard
      AnalyticsView.tsx         # Conversation analytics charts
      IssuesView.tsx            # Issue tracker (GitHub/Linear/local)
      SessionsView.tsx          # Session management
      PoliciesView.tsx          # Policy list + management
      AgentsView.tsx            # AGENTS.md / CLAUDE.md editor
      McpView.tsx               # MCP server management
      FeedView.tsx              # Agent status feed
      RadarView.tsx             # Anomaly detection dashboard
      DocsView.tsx              # In-app documentation
      panels/
        ActivityPanel.tsx       # Tool-call activity log
        PolicyPanel.tsx         # Policy quick view
        ServicesPanel.tsx       # Service credentials
        SettingsPanel.tsx       # App settings
        GatewayPanel.tsx        # Gateway/enclave controls
      modals/
        PolicyEditor.tsx        # Policy create/edit
        McpEditor.tsx           # MCP server create/edit
        McpDetail.tsx           # MCP server detail view
        BudgetAlertDialog.tsx   # Budget exceeded dialog
        EndSessionDialog.tsx    # Session end confirmation
  types/
    index.ts                    # Shared TS interfaces + Window.latch declaration

.agents/skills/                 # Agent Skills (agentskills.io spec)
electron.vite.config.ts         # electron-vite build config
tsconfig.json                   # Root TS config (references node + web)
tsconfig.node.json              # Main + preload TS config
tsconfig.web.json               # Renderer TS config (React JSX)
```

---

## Build system

**electron-vite** produces three separate Vite bundles:
- **main** — SSR bundle, `externalizeDepsPlugin()` keeps native modules external
- **preload** — SSR bundle, same externalization
- **renderer** — Client bundle with `@vitejs/plugin-react` for JSX + HMR

Output goes to `out/`. In dev, the renderer loads from the Vite dev server
(`process.env.ELECTRON_RENDERER_URL`). In production, it loads `out/renderer/index.html`.

---

## Core concepts

### Sessions and tabs

A **session** is one unit of work (e.g. "Build auth system"). It has a git
worktree, a goal, a harness, a policy, and one or more terminal **tabs**.

Each tab is an independent PTY process. The tab ID (`tab-N`) is used as the
PTY session key in all `latch:pty-*` IPC calls (not the session ID).

```
Session (session-1)
  +-- Tab (tab-1) <- PTY process A  (claude harness)
  +-- Tab (tab-2) <- PTY process B  (codex harness)
```

### IPC pattern

All IPC uses `latch:<module>-<action>` naming. Every payload is validated with
Zod schemas in `src/main/lib/ipc-schemas.ts`. All responses follow
`{ ok: boolean, error?: string, ...data }`.

Key IPC channels:
- `latch:pty-create`, `latch:pty-write`, `latch:pty-resize`, `latch:pty-kill`
- `latch:session-list`, `latch:session-create`, `latch:session-update`, `latch:session-delete`
- `latch:policy-list`, `latch:policy-save`, `latch:policy-enforce`
- `latch:skills-list`, `latch:skills-save`, `latch:skills-sync`
- `latch:mcp-list`, `latch:mcp-save`, `latch:mcp-sync`, `latch:mcp-introspect`
- `latch:git-status`, `latch:git-create-worktree`, `latch:git-merge-branch`
- `latch:harness-detect`, `latch:model-list`
- `latch:activity-list`, `latch:authz-register`, `latch:approval-resolve`
- `latch:usage-list`, `latch:usage-summary`, `latch:budget-respond`
- `latch:checkpoint-list`, `latch:rewind`, `latch:fork-checkpoint`
- `latch:timeline-conversations`, `latch:timeline-load`
- `latch:analytics-conversation`, `latch:analytics-dashboard`
- `latch:issue-list`, `latch:issue-create`, `latch:issue-start-session`
- `latch:gateway-start`, `latch:gateway-stop`
- `latch:service-list`, `latch:service-save`, `latch:service-catalog`
- `latch:attestation-get`, `latch:attestation-annotate-pr`
- `latch:settings-get`, `latch:settings-set`
- `latch:secret-list`, `latch:secret-save`
- `latch:op-status`, `latch:op-connect`, `latch:op-vaults`

### Renderer architecture

React 18 + Zustand. All state lives in `useAppStore.ts`. Terminal instances are
managed imperatively by `TerminalManager.ts` (singleton outside React's render cycle).

Key patterns:
- **Always-mounted terminals**: Tab panes stay in DOM, CSS `display: none/block` toggles visibility
- **No StrictMode**: Removed to prevent double-registration of PTY data listeners
- **No barrel files**: Import components directly by path

### Harness IDs

| ID         | Label       | Dot dir      | CLI commands             |
|------------|-------------|--------------|--------------------------|
| `claude`   | Claude Code | `~/.claude`  | `claude`, `claude-code`  |
| `codex`    | Codex       | `~/.codex`   | `codex`                  |
| `openclaw` | OpenClaw    | `~/.openclaw`| `openclaw`               |
| `opencode` | OpenCode    | `~/.opencode`| `opencode`               |

### Native modules

`node-pty` and `better-sqlite3` are compiled for Electron via `electron-rebuild`.
Do **not** test them with system Node.js -- they will fail with an ABI mismatch.
Always test inside the running Electron app.

---

## Agent Skills (`.agents/skills/`)

Repo-level skills following the [agentskills.io spec](https://agentskills.io/specification).
Symlinked into `.claude/skills/` for Claude Code discovery.

| Skill | What it teaches |
|-------|----------------|
| `adding-ipc-handlers` | The 4-file IPC dance: types -> preload -> main -> renderer |
| `adding-sqlite-stores` | SQLite store class pattern with migrations and wiring |
| `adding-react-components` | Panels, modals, Zustand, Rail registration, CSS tokens |
| `adding-service-modules` | Main-process services: lifecycle, deps, testing |
| `running-and-testing` | Build, dev, typecheck, vitest, native module gotchas |
| `enclave-*` | Gateway/enclave subsystem skills (proxy, sandbox, attestation, etc.) |

---

## Adding features -- checklists

### New IPC handler

1. Add Zod schema to `src/main/lib/ipc-schemas.ts`
2. Add the handler in `src/main/index.ts` inside `app.whenReady()`
3. Add the type to `LatchAPI` interface in `src/types/index.ts`
4. Expose via `contextBridge` in `src/preload/index.ts`
5. Call in renderer via `window.latch.<name>(payload)`

### New SQLite table / column

1. Add `CREATE TABLE IF NOT EXISTS` in the store's `_init()` method
2. Add `ALTER TABLE ... ADD COLUMN` with try/catch for idempotent migration
3. Wire the store in `src/main/index.ts`

### New React component

1. Create in `src/renderer/components/` (or `panels/` / `modals/` subdirectory)
2. Import and render from parent component
3. Add styles to `src/renderer/styles.css`
4. If it needs global state, add to `src/renderer/store/useAppStore.ts`

### New rail panel

1. Create panel in `src/renderer/components/panels/`
2. Import in `Rail.tsx`, add conditional render
3. Add panel ID to `RailPanel` type in `src/types/index.ts`

### New main-process service

1. Create in `src/main/services/`
2. Export class with JSDoc, `start()` / `stop()` lifecycle methods
3. Wire in `src/main/index.ts`
4. Add tests in `*.test.ts` alongside (vitest)

---

## Coding conventions

1. **TypeScript + ESM** -- no `require()`, no CommonJS
2. **JSDoc** on all exported functions and classes
3. **IPC responses** follow `{ ok: boolean, error?: string, ...data }`
4. **Zod validation** on all IPC payloads from the renderer
5. **Guard before calling** `window.latch?.method` -- use optional chaining
6. **Check `ptyReady`** before sending data to a PTY tab
7. **Idempotent DB migrations** -- wrap `ALTER TABLE` in try/catch
8. **No silent failures** -- log or surface errors via `terminalManager.writeln`
9. **`requestAnimationFrame`** before `fitAddon.fit()` after visibility changes
10. **`async/await`** over `.then()` chains
11. **Named returns** -- prefer `{ ok, data }` over throwing in IPC handlers

---

## Known constraints

- Native addons (`node-pty`, `better-sqlite3`) must run inside Electron, not plain Node.js
- `sandbox: false` is required for `node-pty` to work in the preload
- Policy enforcement writes harness-native config files (Claude's `settings.json`, Codex `.codex/` config, etc.)
- The authz server is an HTTP server on localhost that harnesses call for tool-call authorization
