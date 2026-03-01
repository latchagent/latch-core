---
name: enclave-credential-manager
description: Credential lifecycle management for the Latch Enclave. Tracks expiry, validates credentials against upstream services, records usage metadata. Use when working on credential health checks, token rotation, or service authentication status.
---

# Credential Manager

The CredentialManager class lives at `src/main/services/credential-manager.ts` and handles credential lifecycle tracking for enclave services.

## What It Does

The CredentialManager does NOT store credentials (that is SecretStore's job). Instead it tracks metadata about credential health: whether a credential has expired, when it was last validated, and when it was last used for injection.

### Core Responsibilities

1. **Expiry detection** — checks `ServiceCredentialConfig.expiresAt` against the current time
2. **Upstream validation** — sends a HEAD request to the service's first domain with injected headers to verify the credential is still accepted
3. **Status tracking** — maintains an in-memory map of per-service credential status (valid, lastValidated, lastUsed, expired)

## Key API

- `isExpired(service)` — Returns `true` if the service's `credential.expiresAt` is in the past. Returns `false` if no `expiresAt` is set (non-expiring credential).
- `validateCredential(service, credentials)` — Makes a HEAD request to `https://<first-domain>/` with headers populated from the service's injection config. Returns `{ valid, status, error? }`. Status codes 200, 404, and 405 are considered valid (the credential works, the endpoint just may not support HEAD).
- `recordValidation(serviceId, valid)` — Updates the in-memory status map with the validation result and timestamp.
- `recordUsage(serviceId)` — Updates the `lastUsed` timestamp (called when credentials are injected into a proxied request).
- `getStatus(serviceId)` — Returns the current `CredentialStatus` for a service, or a default status if not yet tracked.

## Types

```typescript
interface CredentialStatus {
  serviceId: string
  valid: boolean
  lastValidated: string | null  // ISO 8601
  lastUsed: string | null       // ISO 8601
  expired: boolean
}

interface ValidationResult {
  valid: boolean
  status: number | null   // HTTP status code from HEAD request
  error?: string          // network or timeout error message
}
```

## Credential Injection for Validation

The `validateCredential` method builds headers by replacing `${credential.<field>}` placeholders in the service's `injection.proxy.headers` with actual credential values. For example:

```
Header template: "Bearer ${credential.token}"
Credentials: { token: "ghp_abc123" }
Result header: "Bearer ghp_abc123"
```

This mirrors the same injection logic used by the EgressFilter during proxy operation.

## Dependencies

- `ServiceDefinition` from `../../types` — provides `credential.expiresAt`, `injection.proxy.domains`, and `injection.proxy.headers`
- `globalThis.fetch` — used for the HEAD validation request (5 second timeout via AbortSignal)

## Integration Points

- **IPC handlers** in `src/main/index.ts`:
  - `latch:credential-status` — returns expiry/validation status for a service
  - `latch:credential-refresh` — triggers validation and returns the result
- **LatchProxy** — can call `recordUsage()` when injecting credentials into proxied requests
- **Renderer** — the ServicesPanel can poll credential status to show health indicators

## Testing

Tests: `src/main/services/credential-manager.test.ts`
Run: `npx vitest run src/main/services/credential-manager.test.ts`

The test suite covers:
- Expired credential detection (past expiresAt)
- Non-expired credential detection (future expiresAt)
- Missing expiresAt treated as non-expiring
- Successful upstream validation (mocked 200)
- Failed upstream validation (mocked 401)
- Status tracking after recordValidation
- Usage tracking after recordUsage
