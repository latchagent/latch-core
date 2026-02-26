# Latch Desktop — Agent Guide

This document is the primary reference for any AI coding agent (Codex, Claude,
OpenClaw, etc.) working on the Latch Desktop codebase.

---

## What is Latch Desktop?

A terminal-first control plane for LLM harnesses. It lets you run Claude Code,
Codex, and OpenClaw in isolated git worktrees, enforce shared policies, manage
skills, and orchestrate multi-agent workflows — all from one Electron app.

---

## Tech stack

| Layer         | Technology                          |
|---------------|-------------------------------------|
| Desktop shell | Electron 28                         |
| Terminal      | xterm.js v5 (@xterm/xterm)          |
| PTY           | node-pty                            |
| Database      | better-sqlite3 (SQLite)             |
| Renderer      | Vanilla JS (no bundler, no framework)|
| Styling       | CSS custom properties, Geist fonts  |
| P2P comms     | walkie-sh (Hyperswarm DHT)          |

---

## Quick start

```bash
cd apps/desktop
npm install       # installs + runs electron-rebuild for native addons
npm run dev       # launches the Electron app
```

Set `LATCH_DEVTOOLS=1` to open Chromium DevTools in a separate window.

---

## Directory layout

```
electron/           Main process modules (Node.js)
  main.js           Entry point — BrowserWindow + all ipcMain.handle() calls
  preload.js        contextBridge — exposes window.latch to the renderer
  pty-manager.js    PTY create/write/resize/kill via node-pty
  session-store.js  SQLite CRUD for sessions
  policy-store.js   SQLite CRUD for policy definitions
  harnesses.js      Detect installed harnesses by dot-dir + PATH
  git-workspaces.js Create / list / remove git worktrees
  walkie-manager.js P2P channel lifecycle via walkie-sh (planned)

renderer/           Renderer process (loaded as static HTML)
  index.html        App shell — 3-column layout
  renderer.js       All UI logic (sessions, tabs, policy editor, rail)
  styles.css        Dark theme tokens + component styles
```

---

## Core concepts

### Sessions and tabs

A **session** represents one unit of work (e.g. "Build auth system").
It has a git worktree, a goal, a harness, and one or more terminal **tabs**.

Each tab is an independent PTY process. The tab ID (`tab-N`) is used as the
PTY session key in all `latch:pty-*` IPC calls.

```
Session  →  tab-1 (claude harness)   ← primary PTY
         →  tab-2 (codex harness)    ← secondary PTY
         →  walkie channel           ← P2P message bus between tabs
```

### Policies

A policy document (JSON) describes what a harness session is allowed to do:
bash execution, network access, file writes, destructive-op confirmation, and
blocked path globs. Policies live in SQLite and are applied at session start.
Sessions can have an ephemeral override that takes precedence.

### Git worktrees

Each session creates a git worktree under `~/.latch/workspaces/<repo>/<slug>`
on a branch `latch/<slug>-<hash>`. This isolates changes from main.

Override defaults with env vars:
- `LATCH_WORKSPACE_ROOT` — worktree parent directory
- `LATCH_BRANCH_PREFIX`  — branch name prefix

---

## IPC reference (window.latch.*)

All renderer→main calls use `ipcRenderer.invoke`; all main→renderer pushes use
`ipcRenderer.on`.

### PTY
```
createPty({ sessionId, cwd, cols, rows })  → { ok, pid, cwd, shell }
writePty({ sessionId, data })              → { ok }
resizePty({ sessionId, cols, rows })       → { ok }
killPty({ sessionId })                     → { ok }
onPtyData(callback)                        ← { sessionId, data }
onPtyExit(callback)                        ← { sessionId }
```

> **Note:** `sessionId` in PTY calls is the **tabId**, not the session ID.

### Sessions
```
listSessionRecords()                       → { ok, sessions[] }
createSessionRecord(payload)               → { ok }
updateSessionRecord({ id, updates })       → { ok }
```

### Policies
```
listPolicies()                             → { ok, policies[] }
getPolicy(id)                              → { ok, policy }
savePolicy(policy)                         → { ok }
deletePolicy(id)                           → { ok }
```

### Git
```
getGitStatus({ cwd? })                     → { isRepo, root }
createWorktree({ repoPath, branchName, sessionName }) → { ok, workspacePath, branchRef }
listWorktrees(repoPath)                    → { ok, worktrees[] }
removeWorktree({ worktreePath })           → { ok }
```

### Harnesses
```
detectHarnesses()                          → { ok, harnesses[] }
```

---

## Coding conventions

1. **JSDoc on all exported functions** — include `@param` and `@returns`.
2. **IPC responses** follow `{ ok: boolean, error?: string, ...data }`.
3. **Guard before calling window.latch** — use optional chaining:
   `window.latch?.createPty?.(...)`
4. **Check `ptyReady`** before sending data to a PTY tab.
5. **Idempotent DB migrations** — wrap `ALTER TABLE` in try/catch.
6. **No silent failures** — surface errors to the terminal pane via `term.writeln`.
7. **`requestAnimationFrame`** before `fitAddon.fit()` after visibility changes.
8. **Named returns** — prefer `{ ok, data }` over throwing exceptions in IPC.

---

## Adding features — checklist

- [ ] New IPC channel → `main.js` handler + `preload.js` exposure + `renderer.js` call
- [ ] New DB table/column → `init()` in relevant store + migration with try/catch
- [ ] New rail panel → HTML `data-panel` div + `initRailTabs()` switch + CSS
- [ ] New electron module → `electron/<module>.js` with JSDoc + require in `main.js`

---

## Known constraints

- No bundler in the renderer — `import`/`export` are not available; use globals
  from `<script>` tags (e.g. `window.Terminal`, `window.FitAddon`).
- Native addons (`node-pty`, `better-sqlite3`) must be run inside Electron,
  not plain Node.js — they are compiled against Electron's ABI.
- The `sandbox: false` Electron option is required for `node-pty` to work.
- Policy enforcement is currently advisory (UI only); harness-level enforcement
  requires writing to harness config files (planned).
