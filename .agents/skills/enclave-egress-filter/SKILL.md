---
name: enclave-egress-filter
description: Domain-based egress filtering for the Latch Enclave proxy. Matches outbound requests to registered services, enforces data tier access, injects credentials into headers, scans for credential leaks, and enforces path/method scoping with glob patterns. Use when working on proxy request evaluation, network policy enforcement, or fine-grained service access control.
---

# Egress Filter

The EgressFilter class lives at `src/main/services/proxy/egress-filter.ts` and handles outbound request evaluation for the Latch Enclave proxy.

## Core Responsibilities

1. **Domain matching** -- Maps outbound request domains to registered ServiceDefinitions using exact and wildcard patterns
2. **Tier access control** -- Enforces data tier hierarchy (public < internal < confidential < restricted)
3. **Credential injection** -- Substitutes `${credential.fieldName}` placeholders in header templates with actual credential values
4. **Leak detection** -- Scans request bodies against service redaction patterns to prevent credential exfiltration
5. **Path/method scoping** (Phase 5) -- Enforces fine-grained access control via `PathRule` definitions on each service, using glob-style path matching and HTTP method restrictions

## Key API

- `matchService(domain)` -- Returns the matching ServiceDefinition or null
- `checkTierAccess(serviceTier, maxTier)` -- Returns true if service tier is within allowed max
- `injectHeaders(service, credentials)` -- Returns headers with credential placeholders resolved
- `scanForLeaks(service, body)` -- Returns `{ safe, leaked }` indicating if body contains credential patterns
- `checkPathScope(service, method, path)` -- (Phase 5) Returns `{ allowed, reason? }` based on the service's `pathRules`

## Path/Method Scoping (Phase 5)

### PathRule type (`src/types/index.ts`)

```typescript
interface PathRule {
  methods: string[]              // e.g. ['GET', 'POST'] or ['*'] for all methods
  paths: string[]                // glob-style, e.g. ['/repos/**', '/orgs/**']
  decision: 'allow' | 'deny'
}
```

PathRules are defined on `ServiceInjectionConfig.proxy.pathRules` (optional). When no rules are defined, all requests are allowed (backward compatible).

### checkPathScope(service, method, path)

Evaluates a request against the service's path rules. Key behaviors:

1. **No rules = allow** -- If `pathRules` is undefined or empty, returns `{ allowed: true }`.
2. **Deny takes precedence** -- Deny rules are evaluated first. If any deny rule matches both method and path, the request is blocked immediately.
3. **Allow rules are additive** -- If allow rules exist and none match, the request is still allowed (deny must be explicit).
4. **Method matching** -- `'*'` matches any HTTP method. Otherwise, exact case-insensitive match.
5. **Path matching** -- Glob-style patterns:
   - `**` matches any sequence of characters (including `/`)
   - `*` (single) matches a single path segment (no `/`)
   - Converted to regex: `**` becomes `.*`, standalone `*` becomes `[^/]*`

### Examples from the service catalog

**GitHub** (`src/main/lib/service-catalog.ts`):
```typescript
pathRules: [
  { methods: ['DELETE'], paths: ['/repos/*/collaborators/*'], decision: 'deny' },
  { methods: ['DELETE'], paths: ['/repos/*/*'], decision: 'deny' },
  { methods: ['PUT'], paths: ['/repos/*/topics'], decision: 'deny' },
]
```

**AWS**:
```typescript
pathRules: [
  { methods: ['*'], paths: ['/iam/**'], decision: 'deny' },
  { methods: ['DELETE'], paths: ['/**'], decision: 'deny' },
]
```

### Adding path rules to a new service

Add `pathRules` to the service's `injection.proxy` config. Rules are evaluated by the `EgressFilter.checkPathScope` method, which is called from `LatchProxy.evaluateRequest` after domain matching and tier checks.

## Leak Detection

The `scanForLeaks(service, body)` method checks outbound request bodies against the service's `dataTier.redaction.patterns`. Each pattern is treated as a regex. Returns `{ safe: true/false, leaked: string[] }` where `leaked` contains the matched strings.

In Phase 5, leak scanning is wired into both HTTP and HTTPS request paths in LatchProxy. When a leak is detected:
- A `leak-detected` feedback message is sent to the agent terminal
- The request is blocked with HTTP 403
- An audit event is recorded with the leak details

## Phase 2: TLS MITM Usage

In Phase 2, the EgressFilter is also invoked during TLS MITM for intercepted (decrypted) HTTPS requests. When TLS interception is enabled, the proxy terminates the client's TLS, decrypts the HTTP request, and passes it through the EgressFilter for:
- **Credential injection** -- `injectHeaders()` is called on the decrypted request before it is re-encrypted and forwarded upstream
- **Leak detection** -- `scanForLeaks()` is applied to decrypted request bodies
- **Path scoping** -- `checkPathScope()` is evaluated in `evaluateRequest` before the MITM tunnel is established

This means the EgressFilter operates on both plain HTTP requests and decrypted HTTPS requests identically.

## Architecture Notes

- Constructor pre-compiles wildcard domain patterns into RegExp for fast matching
- Domain matching is case-insensitive
- Wildcard `*` matches a single DNS label (e.g., `*.github.com` matches `raw.github.com` but not `a.b.github.com`)
- Path glob matching is computed per-request (not pre-compiled), since path rules are typically few
- Used by LatchProxy (`src/main/services/latch-proxy.ts`) for every outbound request (both HTTP and decrypted HTTPS)

## Testing

Tests: `src/main/services/proxy/egress-filter.test.ts`
Run: `npx vitest run src/main/services/proxy/egress-filter.test.ts`

The test suite covers:
- Domain matching (exact, wildcard, unknown, case-insensitive)
- Tier access control (same, lower, higher)
- Header injection with credential placeholders
- Leak detection (positive and negative)
- Path/method scoping: allow rules, deny rules, deny precedence, wildcard methods, glob patterns, no-rules passthrough
