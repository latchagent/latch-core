# Secrets Vault & Zero-Trust Agent Execution

**Date**: 2026-02-26
**Status**: Approved

---

## Problem

Latch Desktop manages AI coding agents that call MCP servers, native tools, and
external APIs — all of which need credentials. Today:

1. MCP env vars (API keys, tokens) are written as **plaintext** into harness
   config files (`.mcp.json`, `.codex/config.toml`). The agent can `cat` these
   files and exfiltrate every token.
2. There is **no hard execution boundary**. Docker provides basic isolation, but
   the harness process runs with full host filesystem and network access unless
   Docker is explicitly enabled. Policy enforcement is soft — config files and
   authz hooks that the process could theoretically bypass.

## Goals

- Agents never see raw API keys or tokens.
- Secrets are encrypted at rest and injected only at runtime, only to the
  processes that need them.
- Agent sessions run inside a hard sandbox where filesystem, network, and
  capability restrictions are enforced by the OS kernel — not just by config
  files the agent could ignore.
- The existing policy system drives both soft enforcement (harness configs,
  authz hooks) and hard enforcement (sandbox config). No new concepts for users.
- Local-only vault in v1, with a provider abstraction that enables cloud sync
  (1Password, Vault, Latch Cloud) later without rewiring.

## Non-Goals

- Cloud-synced secrets (future, via `SecretProvider` interface).
- Windows sandbox support (out of scope for v1; Docker fallback covers it).
- Sandboxing individual tool calls (too granular; whole-session sandbox is the
  boundary).

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Latch Desktop (main process)                           │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ SecretStore   │  │ PolicyStore  │  │ MCP Store     │ │
│  │ (encrypted)   │  │              │  │ (references)  │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬────────┘ │
│         │                 │                  │          │
│  ┌──────▼─────────────────▼──────────────────▼────────┐ │
│  │              Session Launcher                      │ │
│  │  1. Resolve policy → sandbox config                │ │
│  │  2. Resolve ${secret:*} references                 │ │
│  │  3. Start network proxy (cred injection + filter)  │ │
│  │  4. Select sandbox backend                         │ │
│  │  5. Write MCP configs with wrapper commands        │ │
│  │  6. Spawn harness inside sandbox                   │ │
│  └──────────────────────┬─────────────────────────────┘ │
│                         │                               │
└─────────────────────────┼───────────────────────────────┘
                          │
          ┌───────────────▼────────────────┐
          │  Sandbox (kernel-enforced)      │
          │                                │
          │  ┌──────────┐  ┌────────────┐  │
          │  │ Harness   │  │ MCP Server │  │
          │  │ (claude)  │  │ (via wrap) │  │
          │  └─────┬─────┘  └──────┬─────┘  │
          │        │               │        │
          │   All HTTP traffic ────┘        │
          │        │                        │
          └────────┼────────────────────────┘
                   │
          ┌────────▼────────┐
          │  Network Proxy   │
          │  (on host)       │
          │  - Domain filter │
          │  - Cred injection│
          │  - Request log   │
          └──────────────────┘
```

---

## 1. Secrets Vault

### SecretStore (`src/main/stores/secret-store.ts`)

New SQLite-backed store for named secrets, encrypted at rest via Electron's
`safeStorage` API (macOS Keychain / Windows DPAPI / Linux libsecret).

**Schema** (`secrets` table):

```sql
CREATE TABLE secrets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  key         TEXT NOT NULL UNIQUE,
  value       TEXT NOT NULL,          -- encrypted via safeStorage (hex)
  scope       TEXT NOT NULL DEFAULT 'global',
  tags        TEXT DEFAULT '[]',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

| Column | Purpose |
|--------|---------|
| `name` | Human label shown in UI ("GitHub PAT") |
| `key` | Machine reference used in configs (`GITHUB_TOKEN`) |
| `value` | Encrypted ciphertext; decrypted only at injection time |
| `scope` | `global` or a session ID for session-scoped secrets |
| `tags` | JSON array for grouping/filtering in UI |

### Provider abstraction

```typescript
interface SecretProvider {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<SecretEntry[]>
}
```

v1 ships `LocalSecretProvider` (backed by `SecretStore` + `safeStorage`). The
interface enables future providers: `OnePasswordProvider`, `VaultProvider`,
`LatchCloudProvider`.

### Reference syntax

Configs use `${secret:KEY_NAME}` to reference vault entries. Latch resolves
these at runtime. Raw values never appear in config files on disk.

---

## 2. Secret Injection

Two injection mechanisms, each targeting a different surface:

### 2a. MCP wrapper (`latch-mcp-wrap`)

A small executable that Latch installs. Instead of writing real credentials into
MCP config files, `mcp-sync.ts` writes wrapper commands:

**Config on disk** (agent-visible):
```json
{
  "mcpServers": {
    "github": {
      "command": "latch-mcp-wrap",
      "args": ["npx", "-y", "@modelcontextprotocol/server-github"],
      "env": {
        "LATCH_RESOLVE": "GITHUB_PERSONAL_ACCESS_TOKEN=secret:GITHUB_TOKEN"
      }
    }
  }
}
```

**What `latch-mcp-wrap` does at spawn time**:
1. Reads `LATCH_RESOLVE` for the secret-to-env-var mapping.
2. Calls `http://127.0.0.1:{port}/secrets/resolve` (authenticated with
   `LATCH_AUTHZ_SECRET` bearer token) to fetch real values.
3. Sets resolved values as env vars.
4. `exec`s the real command.

The harness spawns MCP servers normally — it just runs our wrapper instead of
the real binary. The wrapper is transparent to the MCP protocol.

For **HTTP transport** MCP servers (no process to wrap), Latch runs a local HTTP
reverse proxy. The config points to the proxy URL; the proxy adds auth headers
from the vault before forwarding.

### 2b. Network proxy credential injection (native tools)

Native harness tools (Bash, WebFetch) make HTTP requests directly. The sandbox
routes all traffic through Latch's per-session network proxy. The proxy:

- Matches outbound requests to credential mappings (e.g., `*.github.com` →
  `Authorization: Bearer {secret:GITHUB_TOKEN}`)
- Resolves the secret and adds the header before forwarding.
- The agent never sees or handles the raw key.

**Credential mapping** (stored per-secret in `SecretStore` or a join table):
```json
{
  "key": "GITHUB_TOKEN",
  "inject": {
    "domains": ["*.github.com", "*.githubusercontent.com"],
    "header": "Authorization",
    "prefix": "Bearer "
  }
}
```

### 2c. Terminal output redaction

The PTY data listener in `pty-manager.ts` scans outbound terminal data for
known secret values (loaded from `SecretStore` at session start) and replaces
matches with `[REDACTED]`. Catches accidental `echo $VAR` leaks.

---

## 3. Sandbox Architecture

### Backend selection

| Platform | Primary | Fallback |
|----------|---------|----------|
| macOS | `sandbox-exec` (built-in Seatbelt) | Docker Desktop |
| Linux | `bubblewrap` (bwrap) | Docker |

Selection at session start:
```
macOS + sandbox-exec available  → SeatbeltSandbox
Linux + bwrap installed         → BubblewrapSandbox
Docker available                → DockerSandbox
none                            → unsandboxed (warn user)
```

### SandboxManager interface (`src/main/lib/sandbox-manager.ts`)

```typescript
interface SandboxManager {
  spawn(opts: SandboxSpawnOpts): Promise<SandboxedProcess>
  available(): Promise<boolean>
}

interface SandboxSpawnOpts {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  policy: ResolvedPolicy
  cols: number
  rows: number
}
```

Three implementations:
- `SeatbeltSandbox` — generates SBPL profiles, spawns via `sandbox-exec`
- `BubblewrapSandbox` — generates bwrap args, spawns via `bwrap`
- `DockerSandbox` — extends existing `docker-manager.ts`

### Policy → sandbox mapping

| Policy field | sandbox-exec (macOS) | bwrap (Linux) | Docker |
|---|---|---|---|
| `allowNetwork: false` | `(deny network*)` | `--unshare-net` | `--network none` |
| `allowNetwork: true` | route through proxy | proxy via Unix socket | proxy bridge network |
| `allowFileWrite: true` | `(allow file-write* (subpath cwd))` | `--bind cwd cwd` | `-v cwd:cwd` |
| `blockedGlobs` | `(deny file-read* (subpath ...))` | omit bind mount | don't mount path |
| `allowBash: true` | allow `process-exec` | allow in seccomp | default |

### Harness compatibility

The sandbox wraps the entire session, so every harness runs inside it. Key
concerns and how they are addressed:

| Concern | Solution |
|---------|----------|
| Harness needs its LLM API (Anthropic, OpenAI, etc.) | Two-tier network model (see below) |
| Harness config dirs (`~/.claude/`, `~/.codex/`) | Mounted read-only inside the sandbox |
| Node/Python runtime (`/usr/`, `/lib/`) | Mounted read-only (default for all backends) |
| Authz server callback (`127.0.0.1:{port}`) | Localhost to authz port always allowed |
| Git binary and workspace `.git/` | Git mounted read-only; `.git` writable |
| Package managers (`npm install`, `pip install`) | Work when `allowNetwork: true`; deps dir is inside workspace |
| PTY/terminal interaction | Natively supported by sandbox-exec and bwrap |
| Unknown/custom harnesses | User manually allowlists provider domain |

### Network proxy (`src/main/services/network-proxy.ts`)

Per-session HTTP + SOCKS5 proxy running on the host.

**Two-tier network model**: Harnesses are LLM clients — they must reach their
provider API to function. `allowNetwork` in the policy controls *agent-initiated*
traffic, not the harness's own control plane.

| Tier | What | Governed by | Example |
|------|------|-------------|---------|
| **Control plane** | Harness → LLM provider API | Always allowed; auto-detected from harness ID | `api.anthropic.com`, `api.openai.com` |
| **Agent action** | Agent-initiated HTTP (curl, npm, MCP, etc.) | Policy `allowNetwork` + domain allowlist | `api.github.com`, `registry.npmjs.org` |

Known harness → provider domain mappings:

| Harness | Auto-allowed domains |
|---------|---------------------|
| `claude` | `api.anthropic.com`, `*.anthropic.com` |
| `codex` | `api.openai.com`, `*.openai.com` |
| `openclaw` | Configurable (user sets provider URL) |
| Unknown | None auto-allowed; user adds manually via policy allowlist |

When `allowNetwork: false`, the proxy blocks all agent action traffic but still
permits control plane traffic so the harness can function. The user sees this
clearly in the UI: "Network: restricted (LLM API only)."

**Other responsibilities:**

1. **Domain filtering**: Allow/deny agent action requests based on policy.
2. **Credential injection**: Add auth headers for configured domains.
3. **Request logging**: Log all outbound requests to activity feed.

The sandbox routes traffic to the proxy via:
- macOS: SBPL profile restricts network to the proxy socket only.
- Linux (bwrap): `--unshare-net` + bind-mounted Unix socket to host proxy.
- Docker: custom bridge network with proxy as gateway.

---

## 4. End-to-End Session Flow

### One-time setup
1. User adds secrets in the Latch UI (vault panel).
2. User configures MCP servers; env fields offer autocomplete from the vault,
   writing `${secret:KEY}` references.
3. User optionally configures credential mappings (domain → secret → header).
4. User sets policy: filesystem, network, capability rules.

### Session start
1. User creates session (repo, harness, policy).
2. Latch resolves effective policy (global base + session override).
3. Latch starts the network proxy for this session.
4. Latch selects and configures the sandbox backend from the resolved policy.
5. Latch resolves `${secret:*}` references needed for PTY env vars.
6. `mcp-sync` writes config files with `latch-mcp-wrap` commands and secret
   references (no raw values on disk).
7. Latch spawns the harness inside the sandbox with resolved env vars.
8. Harness starts, reads MCP config, spawns MCP servers via `latch-mcp-wrap`.
9. Wrapper calls back to Latch, resolves secrets, `exec`s the real MCP binary.

### Runtime
- Bash/tool commands run inside the sandbox (OS-enforced restrictions).
- HTTP requests route through the proxy (domain filter + credential injection).
- Authz server still runs for tool-level authorization (defense in depth).
- Terminal output is scanned and secrets are redacted before rendering.
- All activity is logged to the activity feed.

### What the agent CANNOT do (hard boundary)
- Read raw secrets from config files (only sees references).
- Access blocked filesystem paths (kernel-enforced).
- Make network requests to unauthorized domains (proxy blocks them).
- See raw API keys for HTTP requests (proxy injects them transparently).
- Exfiltrate secrets via terminal output (redaction layer).
- Escape the sandbox to access the host.

### What still relies on soft enforcement (defense in depth)
- Which tools the agent can use (tool rules in authz server).
- Whether destructive commands need confirmation.
- Per-MCP-server tool allowlists.

---

## 5. UX Requirements

### Secrets management UI
- Vault panel in the sidebar rail for CRUD on secrets.
- Secrets shown with name + key; value always masked, copy-to-clipboard
  available.
- Tags for grouping (e.g., "GitHub", "AWS", "Internal APIs").

### MCP config integration
- When editing MCP server env vars, a dropdown/autocomplete offers vault
  entries. Selecting one writes the `${secret:KEY}` reference automatically.
- Env vars referencing secrets show a lock icon + secret name, not the raw
  reference syntax.
- **Validation at save time**: if a referenced secret doesn't exist in the
  vault, show an inline error before allowing save.
- **Test connection button**: temporarily resolves secrets, starts the MCP
  server, confirms it connects, tears down. User gets confidence the config
  works without starting a full session.

### Credential mapping UI
- Per-secret, optionally configure: "Inject for requests to [domain pattern] as
  [header name] with prefix [Bearer / Basic / custom]."
- Shown inline on the secret's detail view.

### Sandbox status
- Session topbar shows sandbox status: "Sandboxed (Seatbelt)" /
  "Sandboxed (bwrap)" / "Sandboxed (Docker)" / "Unsandboxed (warning)".
- If no sandbox backend is available, show a warning with instructions to
  install Docker or bwrap.

---

## 6. New Modules Summary

| Module | Layer | Purpose |
|--------|-------|---------|
| `stores/secret-store.ts` | Main | Encrypted secret CRUD with safeStorage |
| `lib/sandbox-manager.ts` | Main | SandboxManager interface + backend selection |
| `lib/seatbelt-sandbox.ts` | Main | macOS sandbox-exec backend |
| `lib/bubblewrap-sandbox.ts` | Main | Linux bwrap backend |
| `services/network-proxy.ts` | Main | Per-session HTTP/SOCKS5 proxy |
| `services/secret-resolver.ts` | Main | Resolves `${secret:*}` references |
| `bin/latch-mcp-wrap` | Bundled CLI | MCP server wrapper for secret injection |
| `components/panels/VaultPanel.tsx` | Renderer | Secrets management UI |

Existing modules modified:
- `pty-manager.ts` — sandbox-aware spawning, terminal redaction
- `mcp-sync.ts` — write wrapper commands + references instead of raw values
- `policy-enforcer.ts` — generate sandbox config from policy
- `authz-server.ts` — add `/secrets/resolve` endpoint for wrapper callback
- `stores/mcp-store.ts` — credential mapping fields
- `components/Topbar.tsx` — sandbox status indicator
