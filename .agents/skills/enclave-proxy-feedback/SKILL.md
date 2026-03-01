# Enclave Proxy Feedback

## What This Module Does

The Proxy Feedback module (`src/main/services/proxy/proxy-feedback.ts`) formats proxy enforcement messages for agent terminal output. When the Latch Proxy blocks a request, redacts sensitive data, or tokenizes values, the agent sees a dim-styled `[LATCH]` message in their terminal.

## Message Types

| Type | Label | Example |
|------|-------|---------|
| `block` | `BLOCKED` | `[LATCH] BLOCKED: evil.com — not an authorized service` |
| `redaction` | `REDACTED` | `[LATCH] REDACTED: api.github.com (github) — 3 values redacted` |
| `tokenization` | `TOKENIZED` | `[LATCH] TOKENIZED: api.github.com (github) — 2 values tokenized` |
| `tls-exception` | `TLS-EXCEPTION` | `[LATCH] TLS-EXCEPTION: pinned.com — tunneling without inspection` |

## Key API

- `formatFeedback(msg)` — Format a `ProxyFeedbackMessage` as a terminal string
- `createFeedbackSender(writeFn)` — Create a callback for `LatchProxyConfig.onFeedback`

## Wiring

The feedback sender is created in the session setup code and passed to `LatchProxyConfig.onFeedback`. The `writeFn` should write directly to the agent's PTY output (via `pty-manager.send`).

## Testing

Run: `npx vitest run src/main/services/proxy/proxy-feedback.test.ts`
