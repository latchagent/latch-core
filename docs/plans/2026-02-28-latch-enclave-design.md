# Latch Enclave: Zero-Trust Infrastructure for AI Agents

**Date**: 2026-02-28
**Status**: Approved
**Supersedes**: Partial overlap with `2026-02-26-secrets-zerotrust-design.md` (network proxy, sandbox sections)

---

## Problem

AI agents run with ambient authority. They inherit credentials from the host, make unrestricted network requests, and can exfiltrate data through any channel. Current mitigations (policy-based bash blocking, tool-call authorization) operate at the action level but not at the network or data level. A jailbroken agent, poisoned MCP server, or compromised dependency can bypass action-level controls entirely.

We need infrastructure where agents have **capabilities, not credentials** — they can "use GitHub" without ever seeing a GitHub token, and sensitive data flowing through the agent is automatically classified, redacted, or tokenized based on the session's clearance level.

---

## Architecture: Latch Enclave

Every agent session runs inside a **sandboxed enclave** with a single network exit — the **Latch Proxy**. The proxy is bidirectional: it injects credentials on egress and redacts sensitive data on ingress. Services are first-class objects that bundle credentials, injection rules, and auto-generated skills.

```
╔══════════════════════════════════════════════════════════════════╗
║  LATCH MAIN PROCESS (trusted perimeter)                         ║
║                                                                  ║
║  Service Registry ─┐                                             ║
║  Vault (encrypted) ─┼──▶ LATCH PROXY (per-session)              ║
║  Policy Engine ────┘     ├─ Egress: inject creds, block unauth   ║
║                          ├─ Ingress: redact, tokenize, classify  ║
║                          ├─ TLS interception (ephemeral CA)      ║
║                          └─ Audit log → Merkle tree → Receipt    ║
║                               │                                  ║
║  Attestation Engine ◀─────────┘                                  ║
║  AuthZ Server (enhanced) ◀────────────────────┐                  ║
║                                                │                  ║
╚════════════════════════════════════════════════╪══════════════════╝
                    127.0.0.1 only               │
╔════════════════════════════════════════════════╪══════════════════╗
║  ENCLAVE (sandbox: Docker / Seatbelt / bwrap)  │                  ║
║                                                │                  ║
║  PTY (agent) ──────────────────────────────────┘                  ║
║    HTTPS_PROXY → proxy    │  Env: service creds (redacted out)   ║
║    Skills: enclave-aware  │  FS: policy-scoped mounts only       ║
║    Network: proxy-only    │  Caps: none, no privesc              ║
╚══════════════════════════════════════════════════════════════════╝
```

No sandbox = no session. Zero trust means the enclave is mandatory.

---

## Core Concepts

### 1. Service Model

A **Service** is the fundamental unit representing an external system the agent can interact with.

```typescript
interface ServiceDefinition {
  id: string                    // "github"
  name: string                  // "GitHub"
  category: ServiceCategory     // "vcs" | "cloud" | "comms" | "ci" | "registry" | "custom"

  credential: {
    type: "token" | "keypair" | "oauth" | "env-bundle"
    fields: string[]            // what the user provides, e.g. ["token"]
    // stored encrypted in vault via safeStorage — never on disk in plaintext
  }

  injection: {
    env: Record<string, string>           // e.g. { "GH_TOKEN": "${credential.token}" }
    files: Record<string, string>         // e.g. { "~/.config/gh/hosts.yml": "<template>" }
    proxy: {
      domains: string[]                   // e.g. ["api.github.com", "*.githubusercontent.com"]
      headers: Record<string, string>     // e.g. { "Authorization": "Bearer ${credential.token}" }
    }
  }

  dataTier: {
    defaultTier: DataTier
    redaction: {
      patterns: string[]                  // regex for service-specific secrets
      fields: string[]                    // JSON paths to tokenize in responses
    }
  }

  skill: {
    description: string                   // "GitHub access via gh CLI and API."
    capabilities: string[]                // ["gh pr", "gh issue", "git push"]
    constraints: string[]                 // ["Never print tokens", "Use gh CLI"]
  }
}

type ServiceCategory = "vcs" | "cloud" | "comms" | "ci" | "registry" | "custom"
```

**Key property**: the service definition IS the security policy for that service — injection, redaction, tier, and agent awareness bundled together.

Latch ships with a **catalog** of 20-30 pre-built service definitions. User selects a service, pastes their credential, done. Custom services use a builder UI.

### 2. Data Tiers

Data tiers control what the agent can **see**, independent of what it can **do**.

| Tier | Name | Description | Redaction |
|------|------|-------------|-----------|
| 0 | `public` | Open source, public APIs | Credential patterns only |
| 1 | `internal` | Private repos, staging, internal APIs | + API key patterns |
| 2 | `confidential` | Production data, customer data | + PII (emails, SSN, phones) |
| 3 | `restricted` | Infra creds, root access, payments | + custom patterns, full audit |

**Enforcement points**:
- **Service level**: Each service declares a `defaultTier`
- **Policy level**: Session policy sets `maxDataTier` — if a service's tier exceeds the session's max, access is blocked
- **Proxy level**: Ingress filtering applies tier-appropriate redaction rules
- **Filesystem level**: Sandbox mounts only paths appropriate for the tier

### 3. Tokenization

Two modes for handling sensitive data in proxy responses:

- **Redact**: Replace with `[REDACTED]`. Irreversible. Agent can't use the value. For data the agent should never need (credit card numbers).
- **Tokenize**: Replace with a stable placeholder like `tok_a3f8b2`. Agent can reference tokens in subsequent commands and the proxy de-tokenizes on egress. For data the agent needs to reference but shouldn't see raw (user IDs, emails).

Per-session token map, destroyed when session ends.

---

## Proxy Architecture

The proxy is the enforcement spine. Every network request passes through it.

### Per-Session Instance

```
- Runs in main process (Node.js)
- Listens on 127.0.0.1:<random-port>
- Supports HTTP CONNECT for HTTPS tunneling
- TLS interception via per-session ephemeral CA
  - CA cert injected into sandbox as NODE_EXTRA_CA_CERTS / SSL_CERT_FILE
  - CA key stored in memory, never on disk
  - Destroyed when session ends
- One proxy instance per active session
```

### Request Lifecycle

```
1. Agent sends request (via CLI or direct HTTP)
   └→ Routed to proxy via HTTPS_PROXY env + OS-level network rules

2. EGRESS PROCESSING
   ├→ Domain lookup → match to service in registry
   ├→ Tier check: service tier ≤ session maxDataTier?
   ├→ Service allowed in session policy?
   ├→ Credential injection (headers from service definition)
   ├→ Body scan: leaked credentials? tokenized values to de-tokenize?
   └→ DENY if any check fails (403 + log + PTY message)

3. TLS INTERCEPTION
   └→ Terminate incoming TLS, re-encrypt outbound with real cert

4. Forward to destination

5. INGRESS PROCESSING
   ├→ Scan response body for sensitive patterns
   ├→ Apply tier-appropriate redaction/tokenization
   ├→ Store new token mappings in session token map
   └→ Return processed response to agent

6. AUDIT
   └→ Append event to Merkle log
       { timestamp, domain, method, path, service, tier, decision, redactions[] }
```

### CLI Compatibility

Most CLI tools honor `HTTP_PROXY`/`HTTPS_PROXY`. For those that don't, the sandbox's OS-level network rules (iptables/pf) force ALL outbound traffic through the proxy regardless.

| Tool | Honors proxy? | Additional config |
|------|--------------|-------------------|
| `gh` | Yes | — |
| `git` | Yes | Also `git config http.proxy` |
| `aws` | Yes | — |
| `curl` | Yes | — |
| `npm/yarn` | Yes | Also `npm config set proxy` |
| `docker` | Partial | `~/.docker/config.json` |
| `ssh/scp` | No | `ProxyCommand` or block + require HTTPS |

Backstop: sandbox network rules block all direct connections. Tools that ignore proxy get connection refused, not silent bypass.

---

## Enclave (Sandbox)

The enclave is the hard enforcement boundary. Everything inside is untrusted.

### Backend Selection

```
SandboxManager.select():
  1. Docker available? → DockerEnclave
  2. macOS?            → SeatbeltEnclave (sandbox-exec + pf)
  3. Linux?            → BubblewrapEnclave (bwrap + iptables)
  4. None available?   → REFUSE TO START SESSION
```

No sandbox = no session. This is non-negotiable for zero trust.

### Enclave Properties

**Network Isolation**
- All outbound traffic forced through proxy (iptables DROP / pf block for direct)
- DNS resolved by proxy (prevents DNS exfiltration)
- Loopback allowed only for proxy + authz server ports

**Filesystem Isolation**
- Workspace: mounted at `/workspace`, scoped by policy
- Home: synthetic, minimal — Latch-managed config files only
- Blocked: `~/.ssh`, `~/.gnupg`, `~/.aws` (real host dirs) — replaced with Latch-managed versions if services grant access
- `/tmp`: isolated, cleaned on exit
- No access to: host home dir, `/etc`, `/var`, Docker socket

**Process Isolation**
- `--cap-drop=ALL`
- `--security-opt=no-new-privileges`
- PID namespace isolation
- Resource limits (memory, CPU, PIDs)

**Environment**
- `HTTP_PROXY` / `HTTPS_PROXY` → proxy address
- `NO_PROXY=` (empty — everything routes through proxy)
- `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` / `GIT_SSL_CAINFO` → ephemeral CA
- Service-specific env vars (fallback injection for CLIs that need it)
- `LATCH_ENCLAVE=true`, `LATCH_SESSION_ID=...`

### Credential Injection Modes

Two modes, prefer proxy:

1. **Proxy injection** (preferred): CLI makes HTTP, proxy adds auth headers. Agent never sees credential. Works for all HTTP-based tools.

2. **Env injection** (fallback): Some CLIs require env vars. Credential injected into sandbox env, but:
   - PTY output redaction scrubs the value
   - Proxy blocks sending that value to unauthorized domains
   - Env var exists only in sandbox, destroyed on exit

---

## Session Attestation

Cryptographic proof that policy was enforced during a session.

### Merkle Log

Every proxy request, redaction, policy decision, and tool call is appended to an append-only Merkle log. Same structure as Certificate Transparency — simple hash chaining, powerful for audit.

Provides:
- **Inclusion proof**: A specific event was part of the session log
- **Consistency proof**: The log wasn't modified after the fact
- **Periodic checkpoints**: Root hash snapshots every N events

### Session Receipt

```typescript
interface SessionReceipt {
  version: 1
  sessionId: string

  policy: {
    id: string
    hash: string              // SHA-256 of policy document at session start
    maxDataTier: DataTier
    servicesGranted: string[]
  }

  activity: {
    servicesUsed: string[]    // actually accessed
    networkRequests: number
    blockedRequests: number
    redactionsApplied: number
    toolCalls: number
    toolDenials: number
    approvalEscalations: number
  }

  enclave: {
    sandboxType: "docker" | "seatbelt" | "bubblewrap"
    networkForced: boolean
    startedAt: string
    endedAt: string
    exitReason: "normal" | "timeout" | "killed" | "error"
  }

  proof: {
    merkleRoot: string
    eventCount: number
    checkpoints: string[]
    signature: string         // Ed25519 over receipt
    publicKey: string         // session ephemeral pubkey
  }
}
```

### Use Cases

- **PR annotations**: "This PR was created under policy `strict`, tier `internal`, 0 blocked requests. [Verify receipt]"
- **Compliance**: "All agent sessions this week enforced `confidential` tier or lower"
- **Team trust**: Reviewer checks receipt before merging agent-authored code
- **Future Latch Cloud**: Centralized receipt verification + dashboards

---

## Skills & Agent Awareness

Skills are the UX glue that makes agents enclave-aware.

### Auto-Generated Service Skills

When a service is granted to a session, Latch generates a skill file injected into the harness's discovery path:

```markdown
# Service: GitHub (auto-generated by Latch)

## Available Capabilities
You have authenticated access to GitHub via the `gh` CLI and GitHub API.
Authentication is handled automatically — do NOT ask for tokens.

## How To Use
- `gh pr create`, `gh issue list`, `gh api ...`
- `git push`, `git pull` — auth is automatic

## Constraints
- Never print, log, or store authentication tokens
- Do not modify auth config files — managed by Latch
- If you get a 401, report it — do not attempt to fix auth
```

### Enclave Meta-Skill

A meta-skill injected into every enclave session:

```markdown
# Latch Enclave

You are running inside a Latch security enclave.

## What's Different
- All network traffic is monitored and policy-enforced
- Credentials are injected automatically — never ask for them
- Sensitive data in responses may be tokenized (e.g., `tok_a3f8b2`)
  — reference tokens naturally, they resolve transparently
- Your filesystem access is scoped to this workspace

## Available Services
(dynamically populated from session policy)

## Rules
- Do not bypass network restrictions
- Do not exfiltrate credentials from environment
- If a request is blocked, respect the policy
- Use tokenized values naturally
```

### Injection by Harness

| Harness | Skill path |
|---------|-----------|
| Claude Code | `.claude/skills/latch-enclave/` |
| Codex | `.codex/rules/latch-enclave.rules` |
| OpenClaw | `.openclaw/skills/latch-enclave/` |

### Agent Feedback

When the proxy blocks or redacts, it writes to the session PTY:

```
[latch] Request to api.slack.com blocked — service "slack" not authorized
[latch] Response from api.github.com: 3 fields tokenized (tier: internal)
```

---

## New Modules

| Module | Location | Responsibility |
|--------|----------|---------------|
| `ServiceStore` | `stores/service-store.ts` | CRUD for service definitions + user credentials |
| `ServiceCatalog` | `lib/service-catalog.ts` | Built-in service definitions (GitHub, AWS, etc.) |
| `EnclaveManager` | `lib/enclave-manager.ts` | Sandbox lifecycle, env/mount setup, teardown |
| `LatchProxy` | `services/latch-proxy.ts` | Per-session bidirectional proxy with TLS interception |
| `EgressFilter` | `services/proxy/egress-filter.ts` | Domain matching, cred injection, exfil detection |
| `IngressFilter` | `services/proxy/ingress-filter.ts` | Response scanning, PII detection, tokenization |
| `TokenMap` | `services/proxy/token-map.ts` | Per-session tokenize/de-tokenize mapping |
| `TlsInterceptor` | `services/proxy/tls-interceptor.ts` | Ephemeral CA, on-the-fly cert generation |
| `DataClassifier` | `services/data-classifier.ts` | Pattern + convention-based data classification |
| `AttestationEngine` | `services/attestation.ts` | Merkle log, receipt generation, Ed25519 signing |
| `AttestationStore` | `stores/attestation-store.ts` | Session receipts persistence |
| `SkillGenerator` | `services/skill-generator.ts` | Auto-generate enclave + service skills |
| `VaultPanel` | `renderer/components/panels/VaultPanel.tsx` | Secrets + service management UI |
| `EnclavePanel` | `renderer/components/panels/EnclavePanel.tsx` | Enclave status, attestation viewer |
| `ServiceEditor` | `renderer/components/modals/ServiceEditor.tsx` | Service configuration modal |

## Modified Modules

| Module | Change |
|--------|--------|
| `PolicyEnforcer` | Service grants, data tier, skill generation |
| `PTYManager` | Route through EnclaveManager for sandboxed sessions |
| `AuthzServer` | Proxy-level decisions, attestation event emission |
| `SessionStore` | Enclave metadata, attestation receipt references |
| `SessionWizard` | Service selection, tier display |
| `types/index.ts` | ServiceDefinition, DataTier, SessionReceipt, TokenMap types |

---

## Phasing

### Phase 1: Foundation
- Service model types + ServiceStore + ServiceCatalog (5-10 built-in services)
- EnclaveManager with Docker backend
- Basic proxy (domain blocking/allowing, no TLS interception yet)
- Credential injection (env + proxy header injection)
- Skill generation (enclave + service skills)

### Phase 2: Full Proxy
- TLS interception with ephemeral CA
- Ingress filtering (response scanning, PII detection)
- Tokenization engine (tokenize/de-tokenize with per-session map)
- Data tier enforcement at proxy level
- Agent feedback (PTY messages for blocks/redactions)

### Phase 3: Attestation
- Merkle log accumulator
- Session receipt generation + Ed25519 signing
- AttestationStore for receipt persistence
- Attestation viewer UI

### Phase 4: Native Sandboxes
- SeatbeltEnclave (macOS sandbox-exec + pf)
- BubblewrapEnclave (Linux bwrap + iptables)
- OS-level network forcing (transparent proxy via pf/iptables)

### Phase 5: Advanced
- LLM-assisted data classification
- Custom service builder UI
- PR attestation annotations (via GitHub API)
- Team/enterprise: shared service registry, policy inheritance
- Latch Cloud: centralized receipt verification
