---
name: enclave-latch-proxy
description: Per-session HTTP proxy for the Latch Enclave. Gates outbound requests by domain/service, injects credentials, logs all traffic for audit. Use when working on proxy lifecycle, network gating, or enclave session setup.
---

# Latch Proxy

The LatchProxy class lives at `src/main/services/latch-proxy.ts` and is the core network gating component of the Latch Enclave.

## What It Does

Each agent session gets its own LatchProxy instance. All outbound network traffic from the sandboxed session is routed through this proxy via HTTP_PROXY/HTTPS_PROXY environment variables.

### Request Flow
1. Agent makes HTTP request → routed to LatchProxy
2. LatchProxy extracts target domain
3. EgressFilter checks if domain matches a registered service
4. If no match → **403 Forbidden** (deny-by-default)
5. If match but service tier exceeds session max tier → **403 Forbidden**
6. If allowed → inject credentials via headers, forward request upstream

### HTTPS (CONNECT) Handling
Phase 1 does domain-level allow/deny only (no TLS interception). Allowed domains get a transparent tunnel.

Phase 2 adds full TLS MITM via `TlsInterceptor` (enabled with `enableTls: true` in config). When TLS is enabled:
1. Proxy terminates client TLS using an ephemeral per-domain leaf cert signed by a session CA
2. Decrypted HTTP is passed through the `EgressFilter` for credential injection
3. Request bodies are de-tokenized (tokens resolved back to real values for the destination service)
4. Request is re-encrypted and forwarded to the real upstream
5. Response body is scanned by `IngressFilter` — sensitive values matching service `redaction.patterns` are tokenized via `TokenMap`
6. Tokenized response is re-encrypted and sent back to the client

Services listed in `tlsExceptions` on their `ServiceDefinition` degrade gracefully to Phase 1 tunneling (domain-level gating only, no body inspection). The proxy sends an `onFeedback` message of type `tls-exception` when this happens.

### Response Body Scanning (Ingress)
The `IngressFilter` scans text and JSON responses for sensitive patterns defined by each service's `dataTier.redaction.patterns`. Matched values are replaced with opaque `tok_*` tokens via the session `TokenMap`. Binary content (images, archives, git packfiles) is passed through without scanning.

### Request Body De-tokenization (Egress)
Both HTTP and HTTPS handlers de-tokenize request bodies before forwarding upstream. Any `tok_*` tokens in the request body are resolved back to their real values via `TokenMap.detokenizeString()`, but only if the destination service matches the token's origin (same-origin enforcement).

### Agent Feedback
When the proxy blocks, redacts, tokenizes, or applies a TLS exception, it calls the `onFeedback` callback with a `ProxyFeedbackMessage`. This message is formatted as dim ANSI text and written to the agent's PTY, giving the agent visibility into enforcement actions without being intrusive.

## Key API

- `start()` → `Promise<number>` — Starts proxy on random port, returns port number
- `stop()` — Shuts down proxy, clears token map, destroys TLS interceptor
- `evaluateRequest(domain, method, path)` — Public method for policy evaluation (used in tests)
- `getAuditLog()` — Returns all ProxyAuditEvent records (includes `tlsInspected`, `redactionsApplied`, `tokenizationsApplied` fields)
- `getTokenMap()` — Returns the per-session TokenMap instance
- `getCaCertPath()` — Returns path to ephemeral CA cert file (for env injection), or null if TLS not enabled
- `getPort()` — Returns the bound port

## Dependencies

- `EgressFilter` (`./proxy/egress-filter`) — Domain matching, tier checks, header injection, leak detection
- `TokenMap` (`./proxy/token-map`) — Value tokenization for response scanning and egress de-tokenization
- `TlsInterceptor` (`./proxy/tls-interceptor`) — Ephemeral CA and per-domain leaf cert generation (Phase 2)
- `IngressFilter` (`./proxy/ingress-filter`) — Content-type-aware response body scanning and tokenization (Phase 2)
- `ProxyFeedback` (`./proxy/proxy-feedback`) — Formats enforcement messages for agent terminal output (Phase 2)

## Configuration

```typescript
interface LatchProxyConfig {
  sessionId: string
  services: ServiceDefinition[]
  credentials: Map<string, Record<string, string>>
  maxDataTier: DataTier
  onBlock?: (message: string) => void       // callback for UI notifications
  onFeedback?: (msg: ProxyFeedbackMessage) => void  // callback for agent terminal messages (Phase 2)
  enableTls?: boolean                       // enable TLS interception via TlsInterceptor (Phase 2, default false)
}
```

## Testing

Tests: `src/main/services/latch-proxy.test.ts`
Run: `npx vitest run src/main/services/latch-proxy.test.ts`
