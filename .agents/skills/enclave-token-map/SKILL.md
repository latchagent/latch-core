---
name: enclave-token-map
description: Per-session tokenization engine with same-origin enforcement for the Latch Enclave. Replaces sensitive values with opaque tokens in proxy responses, and only resolves them when sent back to the originating service. Use when working on data tier enforcement, response redaction, or the token same-origin policy.
---

# Token Map

The TokenMap class lives at `src/main/services/proxy/token-map.ts` and implements per-session value tokenization with same-origin enforcement.

## Core Concept: Token Same-Origin Policy

Sensitive values from service responses are replaced with opaque tokens (`tok_a3f8b2c1`). These tokens carry origin metadata (service, tier, endpoint) and can ONLY be resolved back to their real value when the destination matches the origin service. This prevents cross-service data exfiltration.

## Key API

- `tokenize(value, origin)` — Creates a token for a sensitive value. Returns existing token if same value+service already tokenized.
- `resolve(tokenId, destService)` — Returns the real value if destService matches origin, null otherwise.
- `tokenizeInString(text, value, origin)` — Replaces all occurrences of a value in a string with its token.
- `detokenizeString(text, destService)` — Resolves all `tok_*` patterns in text for the given destination service.
- `list()` — Returns all active TokenEntry objects for audit.
- `clear()` — Destroys all tokens (called on session end).

## Token Format

Tokens are `tok_` followed by 8 hex characters: `tok_[a-f0-9]{8}`

## Architecture Notes

- Each TokenMap instance is per-session — created when a session starts, cleared when it ends
- Deduplication: same value+service pair always returns the same token
- Used by LatchProxy for response body processing
- TokenEntry includes: id, value, origin (service, tier, endpoint), validDestinations, createdAt

## Testing

Tests: `src/main/services/proxy/token-map.test.ts`
Run: `npx vitest run src/main/services/proxy/token-map.test.ts`
