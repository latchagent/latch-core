# OpenCode-Native Harness Integration

**Date:** 2026-03-03
**Status:** Approved

## Summary

Make OpenCode the default, first-class harness in Latch Desktop. OpenCode is
an open-source AI coding agent supporting 75+ LLM providers via the AI SDK.
Latch will prompt users to install it on first launch, pre-select it in session
creation, and integrate deeply via OpenCode's plugin system for policy
enforcement and feed reporting.

## Decisions

| Question | Decision |
|----------|----------|
| Bundling strategy | One-click install prompt (npm/brew/curl) |
| Policy enforcement depth | Full plugin injection + config generation |
| Default harness behavior | OpenCode always pre-selected, first in list |
| Session management | Latch manages sessions, OpenCode is a PTY |
| Model configuration | Universal model picker across all harnesses |
| Skills injection mechanism | `.opencode/agents/latch-*.md` files |

## Architecture

### Integration Approach: Plugin-First

Three enforcement layers, matching the pattern used for Claude/Codex/OpenClaw:

1. **`opencode.json` permission config** — baseline allow/ask/deny rules
2. **`.opencode/plugins/latch-policy.ts`** — runtime authz interception + feed
3. **CLI flags** — `--model`, `--prompt` for session-level overrides

---

## Component Design

### 1. Harness Detection & One-Click Install

**Detection updates** (`src/main/lib/harnesses.ts`):
- Project dotdir: `.opencode/`
- Global config: `~/.config/opencode/opencode.json`
- Binary: `which opencode`
- npm package: `opencode-ai`

**Harness record:**
```typescript
{ id: 'opencode', label: 'OpenCode', dotDir: '.opencode',
  commands: ['opencode'], url: 'https://opencode.ai' }
```

**Install flow:**
1. If opencode not detected → show "Install OpenCode" card in wizard/settings
2. On click → spawn PTY running `npm i -g opencode-ai` (prefer brew on macOS)
3. Show progress in mini terminal
4. Re-detect after install → auto-select and continue

### 2. Policy Enforcement

#### Layer 1: `opencode.json` Permission Config

Generate/merge permissions in the project's `opencode.json`:

```jsonc
{
  "permission": {
    "bash": {
      "*": "ask",              // confirmDestructive
      "rm *": "deny",         // from policy deny rules
      "git push --force*": "deny"
    },
    "edit": "allow",           // allowFileWrite
    "read": {
      "*": "allow",
      "**/.env": "deny",
      "~/.ssh/**": "deny"     // from blockedGlobs
    },
    "webfetch": "deny",       // allowNetwork: false
    "websearch": "deny"
  }
}
```

**Policy → OpenCode permission mapping:**

| Latch Policy Field | OpenCode Permission |
|---|---|
| `allowBash: false` | `"bash": { "*": "deny" }` |
| `allowNetwork: false` | `"webfetch": "deny"`, `"websearch": "deny"` |
| `allowFileWrite: false` | `"edit": "deny"` |
| `confirmDestructive: true` | `"bash": { "*": "ask" }` |
| `blockedGlobs` | Per-tool deny patterns for `read`, `edit`, `bash` |

#### Layer 2: Latch Plugin

Injected as `.opencode/plugins/latch-policy.ts`:

```typescript
import type { Plugin } from "opencode"

export default {
  name: "latch-policy",

  hooks: {
    // Pre-tool authorization — calls Latch authz server
    "tool.execute.before": async (ctx, { tool, input }) => {
      const port = process.env.LATCH_AUTHZ_PORT
      const secret = process.env.LATCH_AUTHZ_SECRET
      const sessionId = process.env.LATCH_SESSION_ID
      if (!port || !sessionId) return

      const res = await fetch(
        `http://127.0.0.1:${port}/supervise/${sessionId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${secret}`
          },
          body: JSON.stringify({ tool: tool.name, input }),
        }
      )
      if (res.status === 403) {
        return { abort: true, reason: "Blocked by Latch policy" }
      }
    },

    // Post-tool feed reporting
    "tool.execute.after": async (ctx, { tool, input, output }) => {
      const feedUrl = process.env.LATCH_FEED_URL
      if (!feedUrl) return

      await fetch(feedUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: tool.name,
          input,
          output: typeof output === "string" ? output.slice(0, 500) : undefined,
          timestamp: Date.now(),
        }),
      }).catch(() => {})
    },

    // Inject Latch env vars into shell
    "shell.env": () => ({
      LATCH_SESSION_ID: process.env.LATCH_SESSION_ID,
      LATCH_HARNESS_ID: "opencode",
    }),
  },
} satisfies Plugin
```

#### Layer 3: CLI Flags

When spawning in PTY:
- Interactive: `opencode --prompt "goal text"`
- Non-interactive: `opencode run "goal text"`
- Model override: `--model anthropic/claude-sonnet-4-20250514`

#### Implementation

Add `enforceForOpenCode()` in `src/main/services/policy-enforcer.ts`:
1. Read/create `opencode.json` in worktree root
2. Merge Latch permission config (preserve user settings)
3. Write `.opencode/plugins/latch-policy.ts`
4. Return modified `harnessCommand` with CLI flags

### 3. Skills Injection

Each Latch skill → `.opencode/agents/latch-{skill-id}.md`:

```markdown
---
name: latch-{skill-id}
description: {skill description}
tools:
  - read
  - edit
  - bash
---

{skill body content}
```

**Sync flow** (`src/main/stores/skills-store.ts`):
- Add opencode to harness→path mapping
- Write each enabled skill as `.opencode/agents/latch-{id}.md`
- Clean up stale `latch-*` agent files
- Preserve non-Latch agent files (no `latch-` prefix)

**MCP sync** — Write to `opencode.json` `mcp` section:
```jsonc
{
  "mcp": {
    "latch-policy-server": {
      "type": "local",
      "command": ["node", "/path/to/mcp-server.js"],
      "enabled": true
    }
  }
}
```

### 4. Universal Model Picker

New step in session wizard after harness selection.

**Model discovery:**
- **OpenCode:** Run `opencode models` for full catalog. Group by provider.
  Show open-source models prominently (Ollama, LM Studio, etc.).
- **Claude Code:** Fixed list (opus, sonnet, haiku). `--model` flag.
- **Codex:** OpenAI models. `--model` flag.
- **OpenClaw:** Config or CLI flag.

**UI:**
- Grouped by provider (Anthropic, OpenAI, Google, Meta, Mistral, etc.)
- "Recommended" badge on default model
- Freeform `provider/model` input for custom models
- Persist last-used model per harness in settings store

**Passing to harness:**
- OpenCode: `--model anthropic/claude-sonnet-4-20250514`
- Claude: `--model sonnet`
- Codex: `--model gpt-4.1`

### 5. UI & Onboarding

**First-launch flow:**
1. Detect installed harnesses
2. If opencode missing → welcome card with install button
3. Install runs in visible mini-terminal
4. After install → auto-detect → session creation

**Session wizard:**
- OpenCode always first, pre-selected
- Skip harness step if only opencode installed
- Model step after harness selection
- Goal step uses opencode-appropriate language

**Visual:**
- CSS class `harness-opencode` for styling
- OpenCode badge in sidebar/topbar session entries

**No changes to:**
- Terminal area (PTY model unchanged)
- Session store schema (already has `harness_id`, `harness_command`)
- Replay/checkpoint system (harness-agnostic)

---

## Files Affected

| File | Change |
|------|--------|
| `src/main/lib/harnesses.ts` | Update detection: XDG paths, default ordering |
| `src/main/services/policy-enforcer.ts` | Add `enforceForOpenCode()` |
| `src/main/stores/skills-store.ts` | Add opencode agent file format |
| `src/main/stores/mcp-store.ts` | Add opencode MCP config sync |
| `src/types/index.ts` | Add `OpenCodePolicyConfig` to `HarnessesConfig` |
| `src/renderer/terminal/TerminalWizard.ts` | Default selection, model step |
| `src/renderer/store/useAppStore.ts` | Model picker state, install action |
| `src/renderer/styles.css` | `.harness-opencode` styles |
| `src/preload/index.ts` | New IPC for install + model discovery |
| `src/main/index.ts` | IPC handlers for install, model list |

## Implementation Phases

**Phase 1 — Core integration:**
- Detection updates + default selection
- `enforceForOpenCode()` (config + plugin + CLI flags)
- Skills injection via `.opencode/agents/`
- One-click install prompt

**Phase 2 — Model picker:**
- Universal model picker UI in session wizard
- `opencode models` integration
- Per-harness model flag passing
- Settings persistence

## OpenCode Reference

| Property | Value |
|----------|-------|
| Repo | `github.com/sst/opencode` |
| Binary | `opencode` |
| npm package | `opencode-ai` |
| Config format | JSONC (`opencode.json`) |
| Global config | `~/.config/opencode/opencode.json` |
| Project dotdir | `.opencode/` |
| Data dir | `~/.local/share/opencode/` |
| Plugin hooks | `tool.execute.before/after`, `session.*`, `permission.*`, `shell.env` |
| Permissions | allow / ask / deny with glob patterns per-tool |
| Non-interactive | `opencode run "prompt"` |
| Model flag | `--model provider/model` |
| Session resume | `--continue` / `--session <id>` |
| MCP | Full support (local + remote) in config |
| Agents | `.opencode/agents/*.md` with frontmatter |
