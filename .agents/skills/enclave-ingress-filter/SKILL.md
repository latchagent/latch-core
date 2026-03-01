# Enclave Ingress Filter

## What This Module Does

The Ingress Filter (`src/main/services/proxy/ingress-filter.ts`) scans HTTP response bodies for sensitive content before they reach the agent. It's the ingress half of the Latch Proxy's bidirectional enforcement.

## Content-Type Classification

- **Scannable:** `text/*`, `application/json`, `application/xml`, `application/x-www-form-urlencoded`
- **Binary (skip):** `image/*`, `application/octet-stream`, `application/gzip`, `application/x-git-*`, etc.
- **Unknown (null):** Skip scanning

Binary responses still pass through domain/service gating and audit logging — only body scanning is skipped.

## Scanning Pipeline

1. Check Content-Type → skip if binary
2. For each redaction pattern in the service definition, regex-match the body
3. Each match is tokenized via the session's `TokenMap` with same-origin metadata
4. Return processed body + statistics (tokenizations applied, redactions applied)

## Key API

- `isScannable(contentType)` — Classify a Content-Type header
- `scanResponse(contentType, body, service, endpoint)` — Full scan pipeline

## Token Same-Origin

Tokens created by the ingress filter carry `{ service, tier, endpoint }` origin metadata. They can only be de-tokenized when sent back to the originating service. See the `enclave-token-map` skill for details.

## Testing

Run: `npx vitest run src/main/services/proxy/ingress-filter.test.ts`
