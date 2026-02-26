# Latch Desktop — Claude Code Guide

Latch Desktop is an **Electron app** that acts as a terminal-first control plane
for LLM coding harnesses (Claude Code, Codex, OpenClaw). It wraps real PTY
shells, manages git worktrees, enforces policies, and coordinates multi-agent
workflows via walkie-sh (P2P messaging).

---

## Running the app

```bash
cd apps/desktop
npm install          # also runs electron-rebuild for native modules
npm run dev          # launch app (electron-vite + Vite HMR)
LATCH_DEVTOOLS=1 npm run dev   # launch with DevTools open
npm run build        # production build → out/
```

---

## Project structure

```
apps/desktop/
├── src/
│   ├── main/                      # Main process (TypeScript, ESM)
│   │   ├── index.ts               # BrowserWindow, all ipcMain handlers
│   │   ├── pty-manager.ts         # PTY lifecycle via node-pty
│   │   ├── session-store.ts       # SQLite: sessions, policy overrides
│   │   ├── policy-store.ts        # SQLite: global policy definitions
│   │   ├── skills-store.ts        # SQLite: skills bank + harness sync
│   │   ├── workflow-store.ts      # SQLite: workflow state machine
│   │   ├── harnesses.ts           # Detects claude / codex / openclaw
│   │   └── git-workspaces.ts      # Git worktree create/list/remove
│   ├── preload/
│   │   └── index.ts               # contextBridge → window.latch API
│   ├── renderer/                  # Renderer process (React + TypeScript)
│   │   ├── main.tsx               # React entry point
│   │   ├── App.tsx                # Root component, PTY listeners, layout
│   │   ├── index.html             # Minimal HTML shell with CSP
│   │   ├── styles.css             # Dark theme, Geist Sans/Mono
│   │   ├── store/
│   │   │   └── useAppStore.ts     # Zustand store — all app state + actions
│   │   ├── terminal/
│   │   │   └── TerminalManager.ts # Singleton managing xterm.js instances
│   │   ├── components/
│   │   │   ├── Sidebar.tsx        # Session list + new session button
│   │   │   ├── Topbar.tsx         # Status bar (harness, policy, session)
│   │   │   ├── TerminalArea.tsx   # Tab bar + xterm panes (always-mounted)
│   │   │   ├── Rail.tsx           # Rail tabs + panel switching
│   │   │   ├── panels/
│   │   │   │   ├── PolicyPanel.tsx
│   │   │   │   ├── SkillsPanel.tsx
│   │   │   │   ├── WorkflowPanel.tsx
│   │   │   │   └── CommsPanel.tsx
│   │   │   └── modals/
│   │   │       ├── SessionWizard.tsx
│   │   │       ├── PolicyEditor.tsx
│   │   │       ├── SkillEditor.tsx
│   │   │       └── WorkflowCreator.tsx
│   │   └── (no barrel files — import directly)
│   └── types/
│       └── index.ts               # Shared TS interfaces + Window.latch
├── out/                           # Build output (electron-vite)
│   ├── main/index.js
│   ├── preload/index.js
│   └── renderer/index.html + assets/
├── electron.vite.config.ts        # electron-vite build config
├── tsconfig.json                  # Root TS config (references node + web)
├── tsconfig.node.json             # Main + preload TS config
├── tsconfig.web.json              # Renderer TS config (React JSX)
├── CLAUDE.md                      # This file
├── AGENTS.md                      # Codex / general agent guide
└── package.json
```

> **Legacy directories**: `electron/` and `renderer/` contain the old vanilla JS
> code (pre-migration). They are no longer used and can be deleted.

---

## Build system

**electron-vite** handles three separate Vite builds:
- **main** — SSR bundle, `externalizeDepsPlugin()` keeps native modules external
- **preload** — SSR bundle, same externalisation
- **renderer** — Client bundle with `@vitejs/plugin-react` for JSX + HMR

Output goes to `out/`. The `package.json` `"main"` field points to `out/main/index.js`.

In dev mode, the renderer loads from the Vite dev server (`process.env.ELECTRON_RENDERER_URL`).
In production, it loads `out/renderer/index.html` from the filesystem.

---

## Key architecture rules

### PTY key = tabId, not sessionId

Each terminal **tab** inside a session gets its own PTY process.
The `sessionId` in all `latch:pty-*` IPC calls is actually the **tabId**.

```
Session (session-1)
  └── Tab (tab-1) ← PTY process A   (claude harness)
  └── Tab (tab-2) ← PTY process B   (codex harness)
```

### IPC naming convention

`latch:<module>-<action>`, e.g.:
- `latch:pty-create`, `latch:pty-write`, `latch:pty-resize`, `latch:pty-kill`
- `latch:session-list`, `latch:session-create`, `latch:session-update`
- `latch:policy-list`, `latch:policy-save`, `latch:policy-delete`
- `latch:skills-list`, `latch:skills-save`, `latch:skills-sync`
- `latch:workflow-list`, `latch:workflow-create`, `latch:workflow-handoff`
- `latch:git-status`, `latch:git-create-worktree`
- `latch:harness-detect`

### React + Zustand in the renderer

The renderer uses **React 18** with **Zustand** for state management.
All state lives in `useAppStore.ts`. Terminal instances are managed
imperatively by `TerminalManager.ts` (singleton outside React's render cycle).

Key patterns:
- **Always-mounted terminals**: Tab panes stay in the DOM (never unmounted).
  CSS `display: none/block` toggles visibility to preserve scrollback.
- **No StrictMode**: Removed to prevent double-registration of PTY data listeners.
- **Session wizard as overlay**: Renders inside `TerminalArea`, not as a global modal.

### Native modules

`node-pty` and `better-sqlite3` are native Node.js addons compiled for
Electron via `electron-rebuild`. Do **not** test them with system Node.js —
they will fail with a version mismatch. Always test inside the running app.

---

## SQLite schema (userData/latch.db)

### sessions
```sql
id TEXT, name TEXT, created_at TEXT, status TEXT,
repo_root TEXT, worktree_path TEXT, branch_ref TEXT,
policy_set TEXT,        -- references policies.id (default: 'default')
policy_override TEXT,   -- JSON ephemeral override, null if none
harness_id TEXT, harness_command TEXT, goal TEXT
```

### policies
```sql
id TEXT, name TEXT, description TEXT,
body TEXT,              -- JSON-encoded PolicyDocument
created_at TEXT, updated_at TEXT
```

### skills
```sql
id TEXT, name TEXT, description TEXT,
body TEXT, tags TEXT, harnesses TEXT,
created_at TEXT, updated_at TEXT
```

### workflows
```sql
id TEXT, session_id TEXT, name TEXT,
steps TEXT,             -- JSON array of WorkflowStep
current INTEGER, status TEXT,
created_at TEXT, updated_at TEXT
```

---

## Policy document format

```json
{
  "id": "strict",
  "name": "Strict",
  "description": "No network, confirm all writes.",
  "permissions": {
    "allowBash": true,
    "allowNetwork": false,
    "allowFileWrite": true,
    "confirmDestructive": true,
    "blockedGlobs": ["/etc/**", "~/.ssh/**"]
  },
  "harnesses": {
    "claude": { "allowedTools": ["Read", "Write", "Bash"] },
    "codex":  { "allowedCommands": ["*"] }
  }
}
```

---

## Harness IDs

| ID         | Label       | Dot dir    | CLI commands          |
|------------|-------------|------------|-----------------------|
| `claude`   | Claude Code | `~/.claude`| `claude`, `claude-code`|
| `codex`    | Codex       | `~/.codex` | `codex`               |
| `openclaw` | OpenClaw    | `~/.openclaw`| `openclaw`          |

---

## Common tasks for an AI agent working on this repo

### Add a new IPC handler

1. Add the handler in `src/main/index.ts` inside `app.whenReady()`
2. Add the type to `src/types/index.ts` (`LatchAPI` interface)
3. Expose it via `contextBridge` in `src/preload/index.ts`
4. Call it in the renderer via `window.latch.<name>(payload)`

### Add a new SQLite table / column

1. Add `CREATE TABLE IF NOT EXISTS` in the relevant store's `_init()` method
2. Add `ALTER TABLE ... ADD COLUMN` with a try/catch for idempotent migration

### Add a new React component

1. Create the component in `src/renderer/components/` (or panels/modals subdirectory)
2. Import and render it from the parent component
3. Add styles to `src/renderer/styles.css`
4. If it needs global state, add actions/state to `src/renderer/store/useAppStore.ts`

### Add a rail tab panel

1. Create a panel component in `src/renderer/components/panels/`
2. Import it in `Rail.tsx` and add conditional render
3. Add the panel ID to the `RailPanel` type in `src/types/index.ts`
4. Add panel-specific styles to `styles.css`

### walkie-sh integration (planned)

When building multi-harness workflows, walkie-sh creates a P2P encrypted
channel per session. Each harness tab spawns with `WALKIE_ID=<harness-id>`
so messages are labeled. The Comms rail tails `walkie read <channel> --wait`
via a hidden child process.

---

## Code style

- **TypeScript** throughout — main process and renderer
- **ESM imports** — no `require()` in source files
- **JSDoc** on all exported functions and classes
- **Named returns**: `{ ok, error }` pattern for all IPC responses
- **Guard early**: check `window.latch?.method` before calling; check
  `tab?.ptyReady` before `writePty`
- **No silent failures**: log or surface errors to the terminal via `terminalManager.writeln`
- Prefer `async/await` over `.then()` chains
- `requestAnimationFrame` before any `fitAddon.fit()` call that follows
  a DOM visibility change
