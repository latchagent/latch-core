# Latch Desktop (Electron)

Minimal Electron shell for the Latch desktop app. This is a classic terminal-first UI scaffold that will host xterm.js + PTY wiring.

## Development

```bash
cd apps/desktop
npm install
npm run dev
```

## Notes

- Renderer UI is a static scaffold with Latch branding tokens.
- PTY + xterm.js wiring lives in the `renderer/` surface and the `electron/` main process.
- Git worktrees are managed by the main process (see `electron/git-workspaces.js`) and are triggered during session setup.
- Session metadata is persisted locally via SQLite (see `electron/session-store.js`).
- Defaults: worktrees under `~/.latch/workspaces` and branch prefix `latch/` (override with `LATCH_WORKSPACE_ROOT` / `LATCH_BRANCH_PREFIX`).
