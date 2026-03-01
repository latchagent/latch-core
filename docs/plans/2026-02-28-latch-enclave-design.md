# Latch Enclave: Zero-Trust Infrastructure for AI Agents

**Date**: 2026-02-28
**Status**: Approved (v2 — refined after external review)
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
║                          └─ Audit log → signed Session Receipt    ║
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

## Design Principles

1. **Capabilities, not credentials** — agents can "use GitHub" without seeing a token.
2. **No sandbox = no session** — the enclave is mandatory, not optional.
3. **LLMs never allow** — LLMs may propose policies, explain blocks, classify data, and suggest fixes. They never participate in enforcement decisions with an allow outcome. Enforcement is deterministic (rules + static evaluation). Conservative deny is the only LLM-reachable enforcement outcome.
4. **Token same-origin** — tokenized values carry origin labels and can only be de-tokenized when sent back to the originating service.
5. **Influence is a known limitation** — data tiers control information boundaries (ingress/egress/storage), not agent cognition. Once data enters an LLM's context, we cannot control how it influences reasoning. Tiers prevent data from crossing boundaries, not from being "thought about."
6. **Content-type-aware scanning** — the proxy scans text-based responses (`application/json`, `text/*`). Binary payloads (`application/octet-stream`, git packfiles, images, archives) are passed through without body inspection. Domain/service gating still applies.
7. **TLS interception is a capability, not a constant** — some services or tools may require exceptions (cert pinning, custom TLS stacks). The proxy falls back to domain-level gating + credential injection without body inspection when interception isn't possible.

---

## Core Concepts

### 1. Service Model

A **Service** is the fundamental unit representing an external system the agent can interact with.

```typescript
interface ServiceDefinition {
  id: string                    // "github"
  name: string                  // "GitHub"
  category: ServiceCategory     // "vcs" | "cloud" | "comms" | "ci" | "registry" | "custom"
  protocol: ServiceProtocol     // "http" | "ssh" | "db" | "grpc" | "custom"

  credential: {
    type: "token" | "keypair" | "oauth" | "env-bundle"
    fields: string[]            // what the user provides, e.g. ["token"]
    // stored encrypted in vault via safeStorage — never on disk in plaintext
    expiresAt?: string          // ISO 8601 — null if non-expiring
    refreshToken?: string       // for OAuth flows (v2+)
    lastUsed?: string           // updated on each proxy injection
    lastValidated?: string      // updated on successful auth response
    createdBy?: string          // provenance: who added this credential
  }

  injection: {
    env: Record<string, string>           // e.g. { "GH_TOKEN": "${credential.token}" }
    files: Record<string, string>         // e.g. { "~/.config/gh/hosts.yml": "<template>" }
    proxy: {
      domains: string[]                   // e.g. ["api.github.com", "*.githubusercontent.com"]
      headers: Record<string, string>     // e.g. { "Authorization": "Bearer ${credential.token}" }
      tlsExceptions?: string[]            // domains where TLS interception is skipped
                                          // (cert pinning, custom TLS) — still gated by domain
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
type ServiceProtocol = "http" | "ssh" | "db" | "grpc" | "custom"
```

**Note on protocol scope**: v1 focuses exclusively on HTTP-protocol services (which covers ~99% of agent CLI activity — `gh`, `aws`, `npm`, `curl`, `git` over HTTPS all use HTTP under the hood). The `protocol` field exists in the type system so the service catalog can categorize SSH/DB/gRPC services, but proxy enforcement for non-HTTP protocols is deferred to v2+.

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

#### Token Same-Origin Policy

Tokens carry origin metadata and enforce destination constraints. A token created from a GitHub response cannot be de-tokenized when sent to Slack. This prevents tokenization from becoming an exfiltration channel.

```typescript
interface TokenEntry {
  id: string              // "tok_a3f8b2"
  value: string           // the actual sensitive value
  origin: {
    service: string       // "github" — which service produced this value
    tier: DataTier        // "internal" — tier at time of tokenization
    endpoint: string      // "api.github.com/repos/..." — source endpoint
  }
  validDestinations: string[]  // service IDs where de-tokenization is allowed
                               // default: [origin.service] (same-origin only)
  createdAt: string
}
```

De-tokenization rules:
- By default, tokens can only be de-tokenized when sent back to the originating service (same-origin)
- Cross-service de-tokenization requires explicit policy grant (rare, audited)
- Tokens are never de-tokenized for unknown/unauthorized destinations
- Token ordering and selection patterns are not meaningful — IDs are random, not sequential

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
   ├→ Check Content-Type:
   │    text/*, application/json → scan body
   │    binary (octet-stream, images, archives, git packfiles) → skip body scan
   ├→ Scan scannable response bodies for sensitive patterns
   ├→ Apply tier-appropriate redaction/tokenization
   ├→ Enforce token same-origin: new tokens tagged with source service
   ├→ Store new token mappings in session token map
   └→ Return processed response to agent

6. TLS EXCEPTION HANDLING
   └→ If domain is in service's tlsExceptions list:
       → Skip TLS interception (no body inspection)
       → Still enforce: domain gating, credential injection, audit logging
       → Log: { ..., tlsInspected: false }

7. AUDIT
   └→ Append event to audit log
       { timestamp, domain, method, path, service, tier, decision,
         redactions[], tlsInspected, contentType }
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
- DNS: block UDP/53 entirely, all DNS resolved by proxy (prevents DNS exfiltration)
- Loopback: allow ONLY the specific proxy port and authz server port on 127.0.0.1 — all other localhost ports blocked (prevents local relay/side-channel attacks)

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
- `/proc/self/environ` blocked (prevents credential extraction from process env)
- No shell history (`HISTFILE=/dev/null`)
- Minimal process visibility (PID namespace prevents seeing host processes)

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

### Audit Log

Every proxy request, redaction, policy decision, and tool call is appended to an append-only audit log per session. Events are stored in SQLite with a running SHA-256 hash chain for tamper evidence.

### Session Receipt (v1: signed JSON)

v1 ships signed receipts without full Merkle proofs. The receipt is a JSON document signed with an ephemeral Ed25519 key. This provides tamper evidence and internal audit value. Full Merkle log with inclusion/consistency proofs is a v2 hardening layer.

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
    tokenizationsApplied: number
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
    auditEventCount: number
    auditHashChain: string    // final hash in the chain
    signature: string         // Ed25519 over receipt
    publicKey: string         // session ephemeral pubkey
  }
}
```

### Trust Root

v1: The user trusts their own machine. The signing key is ephemeral, receipts are stored locally. Useful for audit trails and team review.

Future hardening paths (not v1):
- **Remote verifier / transparency log**: Receipts uploaded to Latch Cloud for centralized verification
- **TEE-backed signing** (Nitro/SEV/SGX): Hardware attestation for third-party verifiable claims
- **Shared team key**: Team-wide signing key for cross-machine receipt verification
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

## Known Limitations & Threat Model Boundaries

1. **Semantic influence is not controllable.** Once data enters an LLM's context window, we cannot control how it influences reasoning. Data tiers prevent sensitive data from crossing ingress/egress/storage boundaries, but a "public tier" agent could still be influenced by confidential data present in filenames, error messages, or token placeholders. This is a fundamental property of LLMs, not a design gap.

2. **v1 domain scoping, not path/method scoping.** Services are gated by domain in v1. An agent with GitHub access can hit any GitHub API endpoint. Path/method scoping (e.g., allow GET but block DELETE) is a v5 refinement.

3. **Binary content is not inspected.** The proxy skips body scanning for binary content types (images, archives, git packfiles). Domain-level gating and credential injection still apply, but sensitive data embedded in binary payloads won't be detected.

4. **v1 trust root is local.** Session receipts are signed by ephemeral keys on the user's machine. A compromised host could forge receipts. Third-party verifiable attestation requires a remote verifier or TEE-backed signing (future).

5. **Non-HTTP protocols are gated but not inspected in v1.** SSH, database, and gRPC connections are blocked or allowed at the domain/port level, but the proxy cannot inject credentials or inspect payloads for non-HTTP protocols until v5.

---

## Phasing

### Phase 1: Foundation (shippable, already valuable)
- Service model types + ServiceStore + ServiceCatalog (5-10 built-in services)
- EnclaveManager with Docker backend
- Deny-by-default egress proxy (domain/service gating, no TLS interception yet)
- Credential injection (proxy-first header injection, env fallback with redaction)
- Skill generation (enclave + service skills)
- Audit log + signed session receipts (hash-chained, Ed25519 signed)
- Sandbox requirement enforced (no sandbox = no session)
- Localhost port restriction, DNS blocking, /proc hardening

### Phase 2: Full Proxy (hardening)
- TLS interception with ephemeral CA + degraded mode for pinned services
- `tlsExceptions` support per service
- Content-type-aware ingress scanning (text/json only, skip binary)
- Tokenization engine with same-origin policy
- Data tier enforcement at proxy level
- Agent feedback (PTY messages for blocks/redactions)

### Phase 3: Native Sandboxes
- SeatbeltEnclave (macOS sandbox-exec + pf)
- BubblewrapEnclave (Linux bwrap + iptables)
- OS-level transparent proxy forcing (pf/iptables rules)

### Phase 4: Attestation Hardening
- Merkle log with inclusion/consistency proofs
- PR attestation annotations (via GitHub API)
- Attestation viewer UI in Latch

### Phase 5: Advanced
- Credential lifecycle (OAuth refresh, rotation, expiry, reauth flows)
- Path/method scoping per service (GET allowed, DELETE blocked)
- Non-HTTP protocol support (SSH, database, gRPC)
- LLM-assisted data classification (propose only, never enforce)
- Custom service builder UI
- Team/enterprise: shared service registry, policy inheritance
- Latch Cloud: remote verifier, transparency log, centralized receipts
