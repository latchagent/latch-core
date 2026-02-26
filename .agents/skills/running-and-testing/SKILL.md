---
name: running-and-testing
description: Builds, runs, and tests the Latch Desktop Electron app. Covers dev mode, production builds, type checking, unit tests, linting, and native module gotchas. Use when you need to run, build, or verify the application.
---

# Running and Testing

Latch Desktop is an Electron app built with electron-vite (three separate Vite builds: main, preload, renderer).

## Quick reference

| Command | What it does |
|---------|-------------|
| `npm install` | Install deps + rebuild native modules (node-pty, better-sqlite3) |
| `npm run dev` | Launch app with HMR |
| `LATCH_DEVTOOLS=1 npm run dev` | Launch with DevTools open |
| `npm run build` | Production build → `out/` |
| `npx tsc --noEmit -p tsconfig.node.json` | Type-check main + preload |
| `npx tsc --noEmit -p tsconfig.web.json` | Type-check renderer |
| `npx vitest run` | Run all tests once |
| `npx vitest run src/main/services/my.test.ts` | Run a single test file |
| `npm run lint` | ESLint check |
| `npm run format` | Prettier format |

## Development

```bash
npm install          # Must run first — triggers electron-rebuild
npm run dev          # Opens the app with Vite HMR for renderer
```

The renderer loads from the Vite dev server (hot reload). Main and preload rebuild on save.

## Type checking

Two tsconfig files target different environments:

- **`tsconfig.node.json`** — main process + preload (CommonJS, ES2022, Node types)
- **`tsconfig.web.json`** — renderer (ESNext, React JSX, DOM types)

Always check both:

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json
```

## Testing

Tests use **vitest** and live next to source files:

```
src/main/services/authz-server.test.ts
src/main/services/radar.test.ts
```

Run all tests:
```bash
npx vitest run
```

Run one file:
```bash
npx vitest run src/main/services/authz-server.test.ts
```

Watch mode:
```bash
npx vitest --watch
```

### Test conventions
- Import `{ describe, it, expect }` from vitest
- Create factory helpers for test fixtures (`makePolicy()`, `makeEvent()`)
- Group related tests with nested `describe` blocks
- Test pure exported functions directly

## Production build

```bash
npm run build
```

Outputs to `out/`:
- `out/main/index.js` — main process bundle
- `out/preload/index.js` — preload bundle
- `out/renderer/index.html` + assets — renderer bundle

## Native module warning

**node-pty** and **better-sqlite3** are compiled for Electron's Node ABI via `electron-rebuild` (runs automatically on `npm install`).

**Do NOT test them with system Node** — they will crash with a version mismatch error. Always test inside the running app with `npm run dev`.

If you see `NODE_MODULE_VERSION` mismatch errors after switching Node versions:
```bash
npm run postinstall    # re-runs electron-rebuild
```

## Build architecture

electron-vite produces three independent Vite builds:

| Build | Entry | Output | Module |
|-------|-------|--------|--------|
| main | `src/main/index.ts` | `out/main/index.js` | SSR (CommonJS) |
| preload | `src/preload/index.ts` | `out/preload/index.js` | SSR (CommonJS) |
| renderer | `src/renderer/main.tsx` | `out/renderer/` | Client (ESM) |

Native modules (node-pty, better-sqlite3) are externalized via `externalizeDepsPlugin()` — they're loaded at runtime, not bundled.

## Verification after changes

After modifying source files, run this to confirm nothing is broken:

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npx vitest run && npm run build
```
