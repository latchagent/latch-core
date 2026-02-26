# Latch Terminal + Policy Wizard + LLM Evaluator

## Problem

The current PolicyEditor is a dense single-modal form (~700 lines) that crams
permission toggles, glob inputs, regex inputs, tool chips, MCP selectors, and
per-harness configs into one screen. Users don't know how to create a policy
targeting specific MCP tools because:

1. Tool names are cryptic patterns (`mcp__github__create_issue`)
2. The form is overwhelming with no guidance
3. There's no clear path from "I want read-only GitHub access" to a working policy

Additionally, the app lacks a central command interface. Users who live in
terminals (the primary audience) want keyboard-driven, scriptable workflows.

## Design

### 1. Latch Terminal

The app's "Home" view becomes a custom interactive shell rendered in xterm.js.
It is not a real bash/zsh PTY — it's a purpose-built command interpreter that
understands Latch commands and calls `window.latch.*` IPC methods directly.

**Command structure:** `latch <resource> <action> [flags]`

Resources: `policy`, `session`, `mcp`, `vault`, `settings`, `status`

Example commands:

```
latch policy create          # interactive wizard
latch policy list            # table of policies
latch policy edit strict     # re-enter wizard for existing policy
latch policy delete strict   # confirm + delete
latch mcp list               # show configured servers
latch mcp discover github    # run tool discovery
latch session create         # interactive new session wizard
latch vault list             # show secrets
latch settings set openai-key    # prompts for value securely
latch status                 # overview dashboard
help                         # command reference
```

**Startup banner:** Displays the Latch ASCII logo, version, and prompt.

**Architecture:**

```
xterm.js instance (Latch tab, always tab 0)
  ↕ character I/O
CommandRunner (renderer process)
  → parses input line
  → resolves command from registry
  → executes handler (calls window.latch.*)
  → writes ANSI-formatted output
```

Key components:

- **CommandRunner** — prompt management, line editing, command history, tab completion
- **Command registry** — maps `resource action` to async handler functions
- **Interactive prompts** — reusable primitives:
  - `select(options)` — arrow-key single select
  - `multiSelect(options)` — checkbox toggle with space
  - `input(label)` — text input (optional password masking)
  - `confirm(message)` — Y/n
  - `table(data)` — formatted table output
- **ANSI helpers** — colors, bold, dim, spinners for async operations

**Navigation:** The Latch terminal is always tab 0. Sidebar views (Policies,
MCP Servers, Vault, etc.) remain as-is for visual browsing. Future work will
migrate create/edit flows from views to terminal commands incrementally.

### 2. Policy Creation Wizard

`latch policy create` launches a multi-step interactive wizard:

**Step 1 — Basics:**
Name and optional description.

**Step 2 — Permission Gates:**
Checkbox toggles for the four fundamental gates: allowBash, allowNetwork,
allowFileWrite, confirmDestructive. Space to toggle, enter to continue.

**Step 3 — MCP Server Rules:**
Auto-discovers installed MCP servers and their tools. For each server, the
user picks one of:

- Configure per-tool rules (see each tool with its description, cycle allow/prompt/deny)
- Allow all tools
- Block all tools
- Prompt for all tools
- Use LLM evaluator

Per-tool configuration shows tool names with descriptions from MCP discovery.
Space cycles through states. Keyboard shortcuts: `a` = allow all, `p` = prompt
all, `d` = deny all, `r` = reset all.

**Step 4 — Harness Tool Rules:**
Shows built-in tools for each detected harness (Claude Code: Read, Write, Edit,
Bash, etc.). Same cycle UI as MCP tools.

**Step 5 — Advanced (optional):**
- Blocked paths (glob patterns)
- Command rules (regex patterns)
- LLM evaluator configuration

**Step 6 — Review + Save:**
Summary table showing all configured rules. Confirm to save.

`latch policy edit <name>` re-enters the wizard with existing values
pre-populated. Each step shows current values and allows modification.

### 3. LLM Runtime Evaluator

A new decision layer in the authz chain. Sits after static rules, before the
approval flow:

```
Tool call →
  Permission gates →
  Per-tool rules →
  Blocked globs + command rules →
  LLM evaluator (if enabled, no prior rule matched) →
  Approval flow
```

**Configuration** (new field on PolicyDocument):

```typescript
interface LlmEvaluatorConfig {
  enabled: boolean
  intent: string              // natural language policy description
  scope: 'fallback' | 'all-mcp' | 'specific-servers'
  servers?: string[]          // only if scope is 'specific-servers'
  model?: string              // default: 'gpt-4o-mini'
}
```

**Runtime behavior:**

When a tool call reaches the LLM evaluator:
1. Build a prompt with the policy intent, tool name, server name, sanitized
   arguments, and action class
2. Call OpenAI API (user's key from settings store) with GPT-4o-mini
3. Parse response: ALLOW, DENY, or PROMPT + one-sentence reason
4. Log the decision in the activity feed with `evaluator: 'llm'` flag

**Error handling:**
- Missing/invalid API key → fall through to deny
- Timeout (>5s) → fall through to deny
- Unparseable response → fall through to deny

**Latency:** 1-3 seconds per call is acceptable. No caching — each call has
unique arguments.

### 4. OpenAI Key Bug Fix

The settings-get whitelist (added in the security audit) needs `openai-key`
added to `SETTINGS_READ_ALLOWLIST` so the policy generator and LLM evaluator
can read the stored key.

## Files

### New files

- `src/renderer/terminal/CommandRunner.ts` — command parser, line editor, history, tab completion
- `src/renderer/terminal/commands/` — directory of command handlers:
  - `policy.ts` — policy create/list/edit/delete
  - `session.ts` — session create/list
  - `mcp.ts` — mcp list/discover
  - `vault.ts` — vault list/add/delete
  - `settings.ts` — settings get/set/list
  - `status.ts` — overview dashboard
  - `help.ts` — command reference
- `src/renderer/terminal/prompts.ts` — interactive prompt primitives (select, multiSelect, input, confirm)
- `src/renderer/terminal/ansi.ts` — ANSI color/formatting helpers
- `src/renderer/terminal/table.ts` — table formatting
- `src/main/services/llm-evaluator.ts` — OpenAI API integration for runtime policy evaluation

### Modified files

- `src/types/index.ts` — add `LlmEvaluatorConfig` to `PolicyDocument`
- `src/main/services/authz-server.ts` — integrate LLM evaluator into decision chain
- `src/main/index.ts` — add `openai-key` to settings allowlist; add IPC handler for LLM evaluator
- `src/renderer/App.tsx` — add Latch terminal as Home view
- `src/renderer/store/useAppStore.ts` — add `latchTerminalRef` state, home view routing
- `src/renderer/components/TerminalArea.tsx` — render Latch terminal as tab 0
- `src/renderer/styles.css` — terminal prompt styles, wizard step styles
