---
name: enclave-egress-filter
description: Domain-based egress filtering for the Latch Enclave proxy. Matches outbound requests to registered services, enforces data tier access, injects credentials into headers, and scans for credential leaks. Use when working on proxy request evaluation or network policy enforcement.
---

# Egress Filter

The EgressFilter class lives at `src/main/services/proxy/egress-filter.ts` and handles outbound request evaluation for the Latch Enclave proxy.

## Core Responsibilities

1. **Domain matching** — Maps outbound request domains to registered ServiceDefinitions using exact and wildcard patterns
2. **Tier access control** — Enforces data tier hierarchy (public < internal < confidential < restricted)
3. **Credential injection** — Substitutes `${credential.fieldName}` placeholders in header templates with actual credential values
4. **Leak detection** — Scans request bodies against service redaction patterns to prevent credential exfiltration

## Key API

- `matchService(domain)` — Returns the matching ServiceDefinition or null
- `checkTierAccess(serviceTier, maxTier)` — Returns true if service tier is within allowed max
- `injectHeaders(service, credentials)` — Returns headers with credential placeholders resolved
- `scanForLeaks(service, body)` — Returns `{ safe, leaked }` indicating if body contains credential patterns

## Phase 2: TLS MITM Usage

In Phase 2, the EgressFilter is also invoked during TLS MITM for intercepted (decrypted) HTTPS requests. When TLS interception is enabled, the proxy terminates the client's TLS, decrypts the HTTP request, and passes it through the EgressFilter for:
- **Credential injection** — `injectHeaders()` is called on the decrypted request before it is re-encrypted and forwarded upstream
- **Leak detection** — `scanForLeaks()` can be applied to decrypted request bodies

This means the EgressFilter operates on both plain HTTP requests and decrypted HTTPS requests identically.

## Architecture Notes

- Constructor pre-compiles wildcard domain patterns into RegExp for fast matching
- Domain matching is case-insensitive
- Wildcard `*` matches a single DNS label (e.g., `*.github.com` matches `raw.github.com` but not `a.b.github.com`)
- Used by LatchProxy (`src/main/services/latch-proxy.ts`) for every outbound request (both HTTP and decrypted HTTPS)

## Testing

Tests: `src/main/services/proxy/egress-filter.test.ts`
Run: `npx vitest run src/main/services/proxy/egress-filter.test.ts`
