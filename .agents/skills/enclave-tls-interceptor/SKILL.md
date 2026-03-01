# Enclave TLS Interceptor

## What This Module Does

The TLS Interceptor (`src/main/services/proxy/tls-interceptor.ts`) provides per-session TLS interception for the Latch Enclave proxy. It generates:

1. **Ephemeral CA** — A self-signed RSA 2048 CA certificate created when a session starts. The CA cert is written to a temp file and injected into the sandbox via `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, and `GIT_SSL_CAINFO`.

2. **Per-domain leaf certs** — On-demand certificates for each domain the proxy intercepts, signed by the ephemeral CA. Cached per-domain for the session lifetime.

## Key API

- `new TlsInterceptor()` — Generates CA on construction
- `getCaCertPath()` — Temp file path for env injection
- `getCertForDomain(domain)` — Returns `{ cert, key }` PEM pair
- `getSecureContext(domain)` — Returns Node.js `tls.SecureContext` for TLS server socket
- `destroy()` — Wipes all keys and deletes temp files

## Architecture

- Uses `node-forge` for X.509 cert generation (pure JS, no native deps)
- CA key stored in memory only, never on disk
- Leaf certs cached per-domain (RSA keygen is expensive)
- Entire lifecycle tied to session — construct on start, destroy on end

## Testing

Run: `npx vitest run src/main/services/proxy/tls-interceptor.test.ts`
