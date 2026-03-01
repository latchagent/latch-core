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
Phase 1 does domain-level allow/deny only (no TLS interception). Allowed domains get a transparent tunnel. Phase 2 will add TLS interception with ephemeral CA.

## Key API

- `start()` → `Promise<number>` — Starts proxy on random port, returns port number
- `stop()` — Shuts down proxy, clears token map
- `evaluateRequest(domain, method, path)` — Public method for policy evaluation (used in tests)
- `getAuditLog()` — Returns all ProxyAuditEvent records
- `getTokenMap()` — Returns the per-session TokenMap instance
- `getPort()` — Returns the bound port

## Dependencies

- `EgressFilter` (`./proxy/egress-filter`) — Domain matching, tier checks, header injection
- `TokenMap` (`./proxy/token-map`) — Value tokenization (Phase 2: response scanning)

## Configuration

```typescript
interface LatchProxyConfig {
  sessionId: string
  services: ServiceDefinition[]
  credentials: Map<string, Record<string, string>>
  maxDataTier: DataTier
  onBlock?: (message: string) => void  // callback for UI notifications
}
```

## Testing

Tests: `src/main/services/latch-proxy.test.ts`
Run: `npx vitest run src/main/services/latch-proxy.test.ts`
