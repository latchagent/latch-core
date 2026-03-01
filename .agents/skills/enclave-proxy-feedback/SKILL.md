# Enclave Proxy Feedback

## What This Module Does

The Proxy Feedback module (`src/main/services/proxy/proxy-feedback.ts`) formats proxy enforcement messages for agent terminal output. When the Latch Proxy blocks a request, redacts sensitive data, tokenizes values, detects credential leaks, or enforces path scope rules, the agent sees a dim-styled `[LATCH]` message in their terminal.

## Message Types

| Type | Label | Example |
|------|-------|---------|
| `block` | `BLOCKED` | `[LATCH] BLOCKED: evil.com -- not an authorized service` |
| `redaction` | `REDACTED` | `[LATCH] REDACTED: api.github.com (github) -- 3 values redacted` |
| `tokenization` | `TOKENIZED` | `[LATCH] TOKENIZED: api.github.com (github) -- 2 values tokenized` |
| `tls-exception` | `TLS-EXCEPTION` | `[LATCH] TLS-EXCEPTION: pinned.com -- tunneling without inspection` |
| `scope-violation` | `SCOPE-DENIED` | `[LATCH] SCOPE-DENIED: api.github.com (github) -- DELETE /repos/foo denied by path rule` |
| `credential-expired` | `CRED-EXPIRED` | `[LATCH] CRED-EXPIRED: api.github.com (github) -- credential expired at 2026-02-28T00:00:00Z` |
| `leak-detected` | `LEAK-DETECTED` | `[LATCH] LEAK-DETECTED: api.github.com (github) -- Credential leak detected in request body: ghp_abc...` |

The `ProxyFeedbackMessage` type in `src/types/index.ts` defines the full type union:

```typescript
interface ProxyFeedbackMessage {
  type: 'block' | 'redaction' | 'tokenization' | 'tls-exception' | 'scope-violation' | 'credential-expired' | 'leak-detected'
  domain: string
  service: string | null
  detail: string
}
```

## Key API

- `formatFeedback(msg)` -- Format a `ProxyFeedbackMessage` as a terminal string with ANSI dim styling
- `createFeedbackSender(writeFn)` -- Create a callback for `LatchProxyConfig.onFeedback`

## Wiring

The feedback sender is created in the session setup code and passed to `LatchProxyConfig.onFeedback`. The `writeFn` should write directly to the agent's PTY output (via `pty-manager.send`).

### Phase 5 feedback sources

- **`leak-detected`** -- Emitted by `LatchProxy._handleRequest` and `_handleInterceptedRequest` when `egressFilter.scanForLeaks()` finds credential patterns in de-tokenized outbound request bodies
- **`scope-violation`** -- Emitted when `evaluateRequest` detects a path/method rule violation via `checkPathScope`
- **`credential-expired`** -- Available for use when the `CredentialManager` detects an expired credential

## Testing

Run: `npx vitest run src/main/services/proxy/proxy-feedback.test.ts`
