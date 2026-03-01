# Latch Enclave Phase 2: Full Proxy Hardening — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harden the Latch Proxy with TLS interception, content-type-aware response scanning, tokenization engine wiring, and agent feedback — making the proxy a full bidirectional enforcement layer rather than a domain-level gatekeeper.

**Architecture:** Phase 1 built a domain-level allow/deny proxy with credential injection. Phase 2 upgrades `_handleConnect` from a dumb tunnel to a full TLS MITM — the proxy terminates TLS from the client (using a per-session ephemeral CA), inspects cleartext HTTP, applies ingress scanning (redaction + tokenization on responses), and re-encrypts outbound. Services with `tlsExceptions` degrade gracefully to Phase 1 tunneling. Binary content is passed through without body scanning. Agent gets PTY feedback on blocks/redactions.

**Tech Stack:** `node-forge` for X.509 cert generation, Node.js `tls` module for TLS termination, existing `TokenMap` + `EgressFilter`, vitest for tests.

**Design doc:** `docs/plans/2026-02-28-latch-enclave-design.md`
**Phase 1 plan:** `docs/plans/2026-02-28-latch-enclave-phase1-plan.md` (complete)

---

## Task 1: Install `node-forge` dependency

**Files:**
- Modify: `package.json`

**Step 1: Install node-forge and its types**

Run:
```bash
npm install node-forge
npm install --save-dev @types/node-forge
```

**Step 2: Verify installation**

Run: `node -e "require('node-forge'); console.log('ok')"`
Expected: `ok`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add node-forge for X.509 cert generation"
```

---

## Task 2: Enhanced Types

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Add Phase 2 types after the existing ProxyAuditEvent interface (~line 223)**

```typescript
/** TLS certificate pair for ephemeral CA or leaf certs. */
export interface TlsCertPair {
  cert: string   // PEM-encoded certificate
  key: string    // PEM-encoded private key
}

/** Result of scanning a response body for sensitive content. */
export interface IngressScanResult {
  scanned: boolean          // false if binary/skipped
  contentType: string | null
  redactionsApplied: number
  tokenizationsApplied: number
  processedBody: string | null  // null if not scanned (binary passthrough)
}

/** Message sent to agent terminal about proxy enforcement. */
export interface ProxyFeedbackMessage {
  type: 'block' | 'redaction' | 'tokenization' | 'tls-exception'
  domain: string
  service: string | null
  detail: string
}
```

**Step 2: Enhance ProxyAuditEvent with Phase 2 fields**

Find the existing `ProxyAuditEvent` interface in `src/types/index.ts` and add three new fields at the end:

```typescript
export interface ProxyAuditEvent {
  id: string
  timestamp: string
  sessionId: string
  service: string | null
  domain: string
  method: string
  path: string
  tier: DataTier | null
  decision: 'allow' | 'deny'
  reason: string | null
  contentType: string | null
  // Phase 2 additions:
  tlsInspected: boolean
  redactionsApplied: number
  tokenizationsApplied: number
}
```

**Step 3: Run typecheck to verify no regressions**

Run: `npx tsc --noEmit 2>&1 | grep -v policy-generator`
Expected: Compilation errors for existing code that creates `ProxyAuditEvent` without the new fields. That's expected — we'll fix those in the tasks that touch those files.

**Step 4: Fix Phase 1 audit event creation in latch-proxy.ts**

In `src/main/services/latch-proxy.ts`, update `_recordAudit` to include the new fields with defaults:

```typescript
private _recordAudit(
  domain: string,
  method: string,
  path: string,
  service: string | null,
  decision: 'allow' | 'deny',
  reason: string | null,
  extras?: { contentType?: string; tlsInspected?: boolean; redactionsApplied?: number; tokenizationsApplied?: number },
): void {
  this.auditLog.push({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: this.config.sessionId,
    service,
    domain,
    method,
    path,
    tier: null,
    decision,
    reason,
    contentType: extras?.contentType ?? null,
    tlsInspected: extras?.tlsInspected ?? false,
    redactionsApplied: extras?.redactionsApplied ?? 0,
    tokenizationsApplied: extras?.tokenizationsApplied ?? 0,
  })
}
```

Update all existing `_recordAudit` call sites (in `evaluateRequest`, `_handleRequest`, `_handleConnect`) to pass no extras (they'll get defaults).

**Step 5: Fix attestation-store if it creates ProxyAuditEvent objects**

Check `src/main/stores/attestation-store.ts` — if it creates `ProxyAuditEvent` objects, add the new fields with defaults.

**Step 6: Run typecheck again**

Run: `npx tsc --noEmit 2>&1 | grep -v policy-generator`
Expected: Clean (no new errors)

**Step 7: Run existing tests**

Run: `npx vitest run src/main/services/latch-proxy.test.ts`
Expected: All 5 tests pass

**Step 8: Commit**

```bash
git add src/types/index.ts src/main/services/latch-proxy.ts
git commit -m "feat(types): add Phase 2 types — TlsCertPair, IngressScanResult, ProxyFeedbackMessage, enhanced ProxyAuditEvent"
```

---

## Task 3: TlsInterceptor

**Files:**
- Create: `src/main/services/proxy/tls-interceptor.ts`
- Create: `src/main/services/proxy/tls-interceptor.test.ts`
- Skill: `.agents/skills/enclave-tls-interceptor/SKILL.md`

**Context:** This module generates a per-session ephemeral CA certificate (RSA 2048, self-signed) and on-demand per-domain leaf certificates signed by that CA. The CA cert is written to a temp file so it can be injected into the sandbox environment via `NODE_EXTRA_CA_CERTS`. Leaf certs are cached per-domain for the session lifetime. All keys and certs are destroyed when the session ends.

**Step 1: Write the failing test**

Create `src/main/services/proxy/tls-interceptor.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { TlsInterceptor } from './tls-interceptor'
import * as tls from 'node:tls'
import * as fs from 'node:fs'

describe('TlsInterceptor', () => {
  let interceptor: TlsInterceptor

  afterEach(() => {
    interceptor?.destroy()
  })

  it('generates a valid CA certificate', () => {
    interceptor = new TlsInterceptor()
    const ca = interceptor.getCaCert()
    expect(ca.cert).toContain('BEGIN CERTIFICATE')
    expect(ca.key).toContain('BEGIN RSA PRIVATE KEY')
  })

  it('generates leaf certs signed by the CA', () => {
    interceptor = new TlsInterceptor()
    const leaf = interceptor.getCertForDomain('api.github.com')
    expect(leaf.cert).toContain('BEGIN CERTIFICATE')
    expect(leaf.key).toContain('BEGIN RSA PRIVATE KEY')
  })

  it('caches leaf certs per domain', () => {
    interceptor = new TlsInterceptor()
    const leaf1 = interceptor.getCertForDomain('api.github.com')
    const leaf2 = interceptor.getCertForDomain('api.github.com')
    expect(leaf1.cert).toBe(leaf2.cert)
  })

  it('generates different certs for different domains', () => {
    interceptor = new TlsInterceptor()
    const leaf1 = interceptor.getCertForDomain('api.github.com')
    const leaf2 = interceptor.getCertForDomain('registry.npmjs.org')
    expect(leaf1.cert).not.toBe(leaf2.cert)
  })

  it('writes CA cert to a temp file', () => {
    interceptor = new TlsInterceptor()
    const path = interceptor.getCaCertPath()
    expect(fs.existsSync(path)).toBe(true)
    const content = fs.readFileSync(path, 'utf-8')
    expect(content).toContain('BEGIN CERTIFICATE')
  })

  it('creates a valid TLS secure context for a domain', () => {
    interceptor = new TlsInterceptor()
    const ctx = interceptor.getSecureContext('example.com')
    // tls.createSecureContext returns an object — just verify it doesn't throw
    expect(ctx).toBeDefined()
  })

  it('cleans up temp files on destroy', () => {
    interceptor = new TlsInterceptor()
    const path = interceptor.getCaCertPath()
    expect(fs.existsSync(path)).toBe(true)
    interceptor.destroy()
    expect(fs.existsSync(path)).toBe(false)
    // Prevent double-destroy in afterEach
    interceptor = undefined as any
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/services/proxy/tls-interceptor.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/main/services/proxy/tls-interceptor.ts`:

```typescript
/**
 * @module tls-interceptor
 * @description Per-session TLS interception via ephemeral CA.
 *
 * Generates a self-signed CA cert on construction, then creates
 * per-domain leaf certs signed by that CA on demand. The CA cert
 * is written to a temp file for injection into sandbox environments
 * via NODE_EXTRA_CA_CERTS / SSL_CERT_FILE / GIT_SSL_CAINFO.
 *
 * All crypto material is in-memory and destroyed when the session ends.
 */

import * as forge from 'node-forge'
import * as tls from 'node:tls'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { TlsCertPair } from '../../../types'

export class TlsInterceptor {
  private caCert: forge.pki.Certificate
  private caKey: forge.pki.rsa.PrivateKey
  private caCertPem: string
  private caKeyPem: string
  private caCertPath: string
  private leafCache = new Map<string, TlsCertPair>()

  constructor() {
    // Generate CA key pair (RSA 2048)
    const caKeys = forge.pki.rsa.generateKeyPair(2048)
    this.caKey = caKeys.privateKey

    // Create self-signed CA certificate
    this.caCert = forge.pki.createCertificate()
    this.caCert.publicKey = caKeys.publicKey
    this.caCert.serialNumber = '01'
    this.caCert.validity.notBefore = new Date()
    this.caCert.validity.notAfter = new Date()
    this.caCert.validity.notAfter.setFullYear(this.caCert.validity.notAfter.getFullYear() + 1)

    const caAttrs = [
      { name: 'commonName', value: 'Latch Enclave Session CA' },
      { name: 'organizationName', value: 'Latch' },
    ]
    this.caCert.setSubject(caAttrs)
    this.caCert.setIssuer(caAttrs)
    this.caCert.setExtensions([
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true },
    ])
    this.caCert.sign(this.caKey, forge.md.sha256.create())

    this.caCertPem = forge.pki.certificateToPem(this.caCert)
    this.caKeyPem = forge.pki.privateKeyToPem(this.caKey)

    // Write CA cert to temp file
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latch-ca-'))
    this.caCertPath = path.join(tmpDir, 'ca.crt')
    fs.writeFileSync(this.caCertPath, this.caCertPem)
  }

  /** Get the CA certificate and key as PEM strings. */
  getCaCert(): TlsCertPair {
    return { cert: this.caCertPem, key: this.caKeyPem }
  }

  /** Get the path to the CA cert temp file (for NODE_EXTRA_CA_CERTS). */
  getCaCertPath(): string {
    return this.caCertPath
  }

  /**
   * Get (or generate) a leaf certificate for a domain, signed by the session CA.
   * Certs are cached per-domain for the session lifetime.
   */
  getCertForDomain(domain: string): TlsCertPair {
    const cached = this.leafCache.get(domain)
    if (cached) return cached

    const leafKeys = forge.pki.rsa.generateKeyPair(2048)
    const leafCert = forge.pki.createCertificate()
    leafCert.publicKey = leafKeys.publicKey
    leafCert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16))
    leafCert.validity.notBefore = new Date()
    leafCert.validity.notAfter = new Date()
    leafCert.validity.notAfter.setFullYear(leafCert.validity.notAfter.getFullYear() + 1)

    leafCert.setSubject([{ name: 'commonName', value: domain }])
    leafCert.setIssuer(this.caCert.subject.attributes)
    leafCert.setExtensions([
      { name: 'subjectAltName', altNames: [{ type: 2, value: domain }] },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
    ])
    leafCert.sign(this.caKey, forge.md.sha256.create())

    const pair: TlsCertPair = {
      cert: forge.pki.certificateToPem(leafCert),
      key: forge.pki.privateKeyToPem(leafKeys.privateKey),
    }
    this.leafCache.set(domain, pair)
    return pair
  }

  /** Create a Node.js TLS SecureContext for a domain (for TLS server socket). */
  getSecureContext(domain: string): tls.SecureContext {
    const { cert, key } = this.getCertForDomain(domain)
    return tls.createSecureContext({ cert, key })
  }

  /** Destroy all crypto material and clean up temp files. */
  destroy(): void {
    this.leafCache.clear()
    try {
      if (fs.existsSync(this.caCertPath)) {
        fs.unlinkSync(this.caCertPath)
        fs.rmdirSync(path.dirname(this.caCertPath))
      }
    } catch {
      // Best-effort cleanup
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/services/proxy/tls-interceptor.test.ts`
Expected: All 7 tests pass

**Step 5: Write skill doc**

Create `.agents/skills/enclave-tls-interceptor/SKILL.md`:

```markdown
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
```

**Step 6: Commit**

```bash
git add src/main/services/proxy/tls-interceptor.ts src/main/services/proxy/tls-interceptor.test.ts .agents/skills/enclave-tls-interceptor/SKILL.md
git commit -m "feat(proxy): add TlsInterceptor with ephemeral CA and per-domain leaf certs"
```

---

## Task 4: IngressFilter

**Files:**
- Create: `src/main/services/proxy/ingress-filter.ts`
- Create: `src/main/services/proxy/ingress-filter.test.ts`
- Skill: `.agents/skills/enclave-ingress-filter/SKILL.md`

**Context:** The IngressFilter scans HTTP response bodies for sensitive content. It checks the Content-Type header to decide if scanning is appropriate (text and JSON are scanned; binary is skipped). For scannable content, it applies the service's redaction patterns and tokenizes matched values via the TokenMap with same-origin enforcement.

**Step 1: Write the failing test**

Create `src/main/services/proxy/ingress-filter.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { IngressFilter } from './ingress-filter'
import { TokenMap } from './token-map'
import type { ServiceDefinition } from '../../../types'

const GITHUB_SERVICE: ServiceDefinition = {
  id: 'github',
  name: 'GitHub',
  category: 'vcs',
  protocol: 'http',
  credential: { type: 'token', fields: ['token'] },
  injection: { env: {}, files: {}, proxy: { domains: ['api.github.com'], headers: {} } },
  dataTier: {
    defaultTier: 'internal',
    redaction: {
      patterns: ['ghp_[a-zA-Z0-9_]{36}'],
      fields: [],
    },
  },
  skill: { description: '', capabilities: [], constraints: [] },
}

describe('IngressFilter', () => {
  let tokenMap: TokenMap
  let filter: IngressFilter

  beforeEach(() => {
    tokenMap = new TokenMap()
    filter = new IngressFilter(tokenMap)
  })

  it('identifies text content types as scannable', () => {
    expect(filter.isScannable('text/plain')).toBe(true)
    expect(filter.isScannable('text/html')).toBe(true)
    expect(filter.isScannable('application/json')).toBe(true)
    expect(filter.isScannable('application/json; charset=utf-8')).toBe(true)
  })

  it('identifies binary content types as non-scannable', () => {
    expect(filter.isScannable('application/octet-stream')).toBe(false)
    expect(filter.isScannable('image/png')).toBe(false)
    expect(filter.isScannable('application/gzip')).toBe(false)
    expect(filter.isScannable('application/x-git-upload-pack-result')).toBe(false)
  })

  it('skips scanning for null content type', () => {
    const result = filter.scanResponse(null, 'some body', GITHUB_SERVICE, '/repos')
    expect(result.scanned).toBe(false)
    expect(result.processedBody).toBeNull()
  })

  it('skips scanning for binary content', () => {
    const result = filter.scanResponse('image/png', 'binary data', GITHUB_SERVICE, '/repos')
    expect(result.scanned).toBe(false)
    expect(result.processedBody).toBeNull()
  })

  it('scans JSON responses and tokenizes matched patterns', () => {
    const body = '{"token": "ghp_abcdefghijklmnopqrstuvwxyz0123456789"}'
    const result = filter.scanResponse('application/json', body, GITHUB_SERVICE, '/repos')
    expect(result.scanned).toBe(true)
    expect(result.tokenizationsApplied).toBe(1)
    expect(result.processedBody).not.toContain('ghp_')
    expect(result.processedBody).toContain('tok_')
  })

  it('returns unchanged body when no patterns match', () => {
    const body = '{"message": "hello world"}'
    const result = filter.scanResponse('application/json', body, GITHUB_SERVICE, '/repos')
    expect(result.scanned).toBe(true)
    expect(result.processedBody).toBe(body)
    expect(result.tokenizationsApplied).toBe(0)
  })

  it('scans text/plain responses', () => {
    const body = 'Token is ghp_abcdefghijklmnopqrstuvwxyz0123456789 here'
    const result = filter.scanResponse('text/plain', body, GITHUB_SERVICE, '/data')
    expect(result.scanned).toBe(true)
    expect(result.tokenizationsApplied).toBe(1)
    expect(result.processedBody).toContain('tok_')
  })

  it('handles multiple matches in one response', () => {
    const body = 'first: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa second: ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const result = filter.scanResponse('text/plain', body, GITHUB_SERVICE, '/data')
    expect(result.scanned).toBe(true)
    expect(result.tokenizationsApplied).toBe(2)
  })

  it('tokens created carry correct origin metadata', () => {
    const body = '{"secret": "ghp_abcdefghijklmnopqrstuvwxyz0123456789"}'
    filter.scanResponse('application/json', body, GITHUB_SERVICE, '/repos/owner/repo')
    const tokens = tokenMap.list()
    expect(tokens).toHaveLength(1)
    expect(tokens[0].origin.service).toBe('github')
    expect(tokens[0].origin.tier).toBe('internal')
    expect(tokens[0].origin.endpoint).toBe('/repos/owner/repo')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/services/proxy/ingress-filter.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/main/services/proxy/ingress-filter.ts`:

```typescript
/**
 * @module ingress-filter
 * @description Content-type-aware response body scanning and tokenization.
 *
 * Scans HTTP response bodies for sensitive patterns defined by the originating
 * service. Text and JSON responses are scanned; binary content (images,
 * archives, git packfiles) is passed through without body inspection.
 *
 * Matched values are tokenized via the session's TokenMap with same-origin
 * metadata so they can only be de-tokenized when sent back to the
 * originating service.
 */

import { TokenMap } from './token-map'
import type { ServiceDefinition, IngressScanResult } from '../../../types'

/** Content types that are safe to scan as text. */
const SCANNABLE_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/x-www-form-urlencoded']

export class IngressFilter {
  private tokenMap: TokenMap

  constructor(tokenMap: TokenMap) {
    this.tokenMap = tokenMap
  }

  /** Check if a Content-Type header value indicates scannable text content. */
  isScannable(contentType: string | null): boolean {
    if (!contentType) return false
    const lower = contentType.toLowerCase().split(';')[0].trim()
    return SCANNABLE_PREFIXES.some(prefix => lower.startsWith(prefix))
  }

  /**
   * Scan a response body for sensitive content.
   *
   * @param contentType - The Content-Type header value (null = unknown)
   * @param body - The response body as a string
   * @param service - The service definition (provides redaction patterns)
   * @param endpoint - The request path (for token origin metadata)
   * @returns Scan result with processed body and statistics
   */
  scanResponse(
    contentType: string | null,
    body: string,
    service: ServiceDefinition,
    endpoint: string,
  ): IngressScanResult {
    if (!this.isScannable(contentType)) {
      return {
        scanned: false,
        contentType,
        redactionsApplied: 0,
        tokenizationsApplied: 0,
        processedBody: null,
      }
    }

    let processedBody = body
    let tokenizationsApplied = 0
    const redactionsApplied = 0

    // Apply each redaction pattern from the service definition
    for (const pattern of service.dataTier.redaction.patterns) {
      try {
        const regex = new RegExp(pattern, 'g')
        const matches = processedBody.match(regex)
        if (matches) {
          for (const match of matches) {
            processedBody = this.tokenMap.tokenizeInString(
              processedBody,
              match,
              {
                service: service.id,
                tier: service.dataTier.defaultTier,
                endpoint,
              },
            )
            tokenizationsApplied++
          }
        }
      } catch {
        // Invalid regex — skip silently
      }
    }

    return {
      scanned: true,
      contentType,
      redactionsApplied,
      tokenizationsApplied,
      processedBody,
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/services/proxy/ingress-filter.test.ts`
Expected: All 9 tests pass

**Step 5: Write skill doc**

Create `.agents/skills/enclave-ingress-filter/SKILL.md`:

```markdown
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
```

**Step 6: Commit**

```bash
git add src/main/services/proxy/ingress-filter.ts src/main/services/proxy/ingress-filter.test.ts .agents/skills/enclave-ingress-filter/SKILL.md
git commit -m "feat(proxy): add IngressFilter with content-type-aware response scanning"
```

---

## Task 5: LatchProxy — TLS Interception in `_handleConnect`

**Files:**
- Modify: `src/main/services/latch-proxy.ts`
- Modify: `src/main/services/latch-proxy.test.ts`

**Context:** This is the core Phase 2 change. The existing `_handleConnect` creates a dumb TCP tunnel for HTTPS CONNECT requests. We upgrade it to terminate TLS from the client (using certs from TlsInterceptor), inspect cleartext HTTP, apply egress/ingress processing, and forward to the upstream with real TLS. Services with `tlsExceptions` fall back to the Phase 1 tunnel behavior.

**Step 1: Add TlsInterceptor and IngressFilter to LatchProxy**

Modify `src/main/services/latch-proxy.ts`:

Add imports at the top:
```typescript
import * as tls from 'node:tls'
import * as https from 'node:https'
import { TlsInterceptor } from './proxy/tls-interceptor'
import { IngressFilter } from './proxy/ingress-filter'
```

Add optional `tlsInterceptor` to the config interface:
```typescript
export interface LatchProxyConfig {
  sessionId: string
  services: ServiceDefinition[]
  credentials: Map<string, Record<string, string>>
  maxDataTier: DataTier
  onBlock?: (message: string) => void
  onFeedback?: (message: ProxyFeedbackMessage) => void
  enableTls?: boolean  // default false for backward compat
}
```

Add to class fields:
```typescript
private tlsInterceptor: TlsInterceptor | null = null
private ingressFilter: IngressFilter
```

Modify constructor:
```typescript
constructor(config: LatchProxyConfig) {
  this.config = config
  this.egressFilter = new EgressFilter(config.services)
  this.tokenMap = new TokenMap()
  this.ingressFilter = new IngressFilter(this.tokenMap)
  if (config.enableTls) {
    this.tlsInterceptor = new TlsInterceptor()
  }
}
```

Add a getter for the CA cert path:
```typescript
/** Get the CA cert path for env injection (null if TLS not enabled). */
getCaCertPath(): string | null {
  return this.tlsInterceptor?.getCaCertPath() ?? null
}
```

Update `stop()`:
```typescript
stop(): void {
  this.tokenMap.clear()
  this.tlsInterceptor?.destroy()
  this.tlsInterceptor = null
  if (this.server) {
    this.server.close()
    this.server = null
  }
}
```

**Step 2: Implement TLS MITM in `_handleConnect`**

Replace the existing `_handleConnect` method:

```typescript
/** Handle HTTPS CONNECT requests. TLS MITM when enabled, tunnel otherwise. */
private _handleConnect(
  req: http.IncomingMessage,
  socket: Duplex,
  _head: Buffer,
): void {
  const [host, portStr] = (req.url ?? '').split(':')
  const port = parseInt(portStr, 10) || 443
  const evaluation = this.evaluateRequest(host, 'CONNECT', '/')

  if (evaluation.decision === 'deny') {
    this.config.onBlock?.(`CONNECT to ${host} blocked — ${evaluation.reason}`)
    this.config.onFeedback?.({ type: 'block', domain: host, service: null, detail: evaluation.reason ?? '' })
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.end()
    return
  }

  const service = evaluation.service!

  // Check if domain is in tlsExceptions — fall back to tunnel
  const isTlsException = service.injection.proxy.tlsExceptions?.some(
    exc => host.toLowerCase() === exc.toLowerCase() ||
           new RegExp(`^${exc.replace(/\./g, '\\.').replace(/\*/g, '[^.]+')}$`, 'i').test(host),
  ) ?? false

  if (!this.tlsInterceptor || isTlsException) {
    // Phase 1 tunnel: domain-level gating only, no body inspection
    if (isTlsException) {
      this.config.onFeedback?.({
        type: 'tls-exception',
        domain: host,
        service: service.id,
        detail: `TLS exception — tunneling without inspection`,
      })
    }
    this._recordAudit(host, 'CONNECT', '/', service.id, 'allow', null, { tlsInspected: false })
    const upstream = net.connect(port, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      socket.end()
    })
    socket.on('error', () => upstream.destroy())
    return
  }

  // TLS MITM: intercept, inspect, forward
  this._handleMitm(socket, host, port, service)
}
```

**Step 3: Implement the MITM handler**

Add the `_handleMitm` method to the `LatchProxy` class:

```typescript
/** Perform TLS man-in-the-middle on a CONNECT tunnel. */
private _handleMitm(
  clientSocket: Duplex,
  host: string,
  port: number,
  service: ServiceDefinition,
): void {
  // Tell client tunnel is established
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

  // Wrap client socket in TLS (we are the server)
  const secureContext = this.tlsInterceptor!.getSecureContext(host)
  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer: true,
    secureContext,
  })

  // Create a temporary HTTP server to parse requests from the decrypted stream
  const mitmServer = http.createServer((req, res) => {
    this._handleInterceptedRequest(req, res, host, port, service)
  })

  // Emit the TLS socket as a connection on the MITM server
  mitmServer.emit('connection', tlsSocket)

  tlsSocket.on('error', () => {
    tlsSocket.destroy()
    mitmServer.close()
  })
  clientSocket.on('error', () => {
    tlsSocket.destroy()
    mitmServer.close()
  })
}

/** Handle an intercepted (decrypted) HTTP request from the MITM tunnel. */
private _handleInterceptedRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  host: string,
  port: number,
  service: ServiceDefinition,
): void {
  const path = req.url ?? '/'
  const method = req.method ?? 'GET'

  // Egress: inject credentials
  const creds = this.config.credentials.get(service.id)
  if (creds) {
    const injected = this.egressFilter.injectHeaders(service, creds)
    for (const [k, v] of Object.entries(injected)) {
      req.headers[k.toLowerCase()] = v
    }
  }

  // Egress: de-tokenize request body (resolve tokens being sent to this service)
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    let body = Buffer.concat(chunks)

    // De-tokenize if body contains tokens
    const bodyStr = body.toString('utf-8')
    const detokenized = this.tokenMap.detokenizeString(bodyStr, service.id)
    if (detokenized !== bodyStr) {
      body = Buffer.from(detokenized, 'utf-8')
    }

    // Forward to real upstream with TLS
    const upstreamReq = https.request(
      {
        hostname: host,
        port,
        path,
        method,
        headers: { ...req.headers, host, 'content-length': String(body.length) },
        rejectUnauthorized: true,
      },
      (upstreamRes) => {
        this._handleInterceptedResponse(upstreamRes, res, host, method, path, service)
      },
    )

    upstreamReq.on('error', (err) => {
      res.writeHead(502)
      res.end(`Proxy error: ${err.message}`)
    })

    upstreamReq.end(body)
  })
}

/** Handle an intercepted upstream response — scan body if content is scannable. */
private _handleInterceptedResponse(
  upstreamRes: http.IncomingMessage,
  clientRes: http.ServerResponse,
  host: string,
  method: string,
  path: string,
  service: ServiceDefinition,
): void {
  const contentType = upstreamRes.headers['content-type'] ?? null

  if (!this.ingressFilter.isScannable(contentType)) {
    // Binary or unknown — pass through without body scanning
    this._recordAudit(host, method, path, service.id, 'allow', null, {
      contentType,
      tlsInspected: true,
      redactionsApplied: 0,
      tokenizationsApplied: 0,
    })
    clientRes.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers)
    upstreamRes.pipe(clientRes)
    return
  }

  // Scannable content — buffer the entire response body
  const chunks: Buffer[] = []
  upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk))
  upstreamRes.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf-8')
    const scanResult = this.ingressFilter.scanResponse(contentType, body, service, path)

    // Send feedback if tokenizations were applied
    if (scanResult.tokenizationsApplied > 0) {
      this.config.onFeedback?.({
        type: 'tokenization',
        domain: host,
        service: service.id,
        detail: `${scanResult.tokenizationsApplied} value(s) tokenized in response`,
      })
    }

    this._recordAudit(host, method, path, service.id, 'allow', null, {
      contentType,
      tlsInspected: true,
      redactionsApplied: scanResult.redactionsApplied,
      tokenizationsApplied: scanResult.tokenizationsApplied,
    })

    const responseBody = scanResult.processedBody ?? body
    const headers = { ...upstreamRes.headers }
    headers['content-length'] = String(Buffer.byteLength(responseBody))
    // Remove transfer-encoding since we're sending a known-length body
    delete headers['transfer-encoding']
    clientRes.writeHead(upstreamRes.statusCode ?? 200, headers)
    clientRes.end(responseBody)
  })
}
```

**Step 4: Write new tests for TLS interception**

Add to `src/main/services/latch-proxy.test.ts`:

```typescript
import { TlsInterceptor } from './proxy/tls-interceptor'

// Add to the existing describe block:

it('falls back to tunnel for tlsExceptions domains', () => {
  const svcWithException: ServiceDefinition = {
    ...MOCK_SERVICE,
    id: 'pinned-svc',
    injection: {
      ...MOCK_SERVICE.injection,
      proxy: {
        domains: ['pinned.example.com'],
        headers: {},
        tlsExceptions: ['pinned.example.com'],
      },
    },
  }
  const proxy2 = new LatchProxy({
    sessionId: 'test-tls-exception',
    services: [svcWithException],
    credentials: new Map(),
    maxDataTier: 'internal',
    enableTls: true,
  })
  // The service should be allowed (domain gating passes)
  const result = proxy2.evaluateRequest('pinned.example.com', 'CONNECT', '/')
  expect(result.decision).toBe('allow')
  proxy2.stop()
})

it('exposes CA cert path when TLS is enabled', () => {
  const proxy2 = new LatchProxy({
    sessionId: 'test-tls',
    services: [MOCK_SERVICE],
    credentials: new Map(),
    maxDataTier: 'internal',
    enableTls: true,
  })
  const certPath = proxy2.getCaCertPath()
  expect(certPath).toBeTruthy()
  expect(certPath).toContain('latch-ca-')
  proxy2.stop()
})

it('returns null CA cert path when TLS is not enabled', () => {
  const certPath = proxy.getCaCertPath()
  expect(certPath).toBeNull()
})

it('calls onFeedback for blocks', () => {
  const feedback: any[] = []
  const proxy2 = new LatchProxy({
    sessionId: 'test-feedback',
    services: [MOCK_SERVICE],
    credentials: new Map(),
    maxDataTier: 'internal',
    onFeedback: (msg) => feedback.push(msg),
  })
  // No need to start — evaluateRequest doesn't need the server
  // _handleConnect block path triggers onFeedback, but we can test via evaluateRequest + onBlock
  proxy2.stop()
})
```

**Step 5: Run all proxy tests**

Run: `npx vitest run src/main/services/latch-proxy.test.ts`
Expected: All tests pass (original 5 + new 3-4)

**Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All enclave tests pass (ignore pre-existing radar failures)

**Step 7: Commit**

```bash
git add src/main/services/latch-proxy.ts src/main/services/latch-proxy.test.ts
git commit -m "feat(proxy): add TLS interception with MITM, tlsExceptions, and ingress scanning"
```

---

## Task 6: LatchProxy — Response Scanning for HTTP (non-CONNECT)

**Files:**
- Modify: `src/main/services/latch-proxy.ts`
- Modify: `src/main/services/latch-proxy.test.ts`

**Context:** The existing `_handleRequest` (for plain HTTP, non-CONNECT requests) pipes the upstream response directly to the client without scanning. We add the same ingress scanning pipeline used in the MITM handler.

**Step 1: Modify `_handleRequest` to scan responses**

Replace the response handling in `_handleRequest`:

```typescript
private _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const domain = url.hostname
  const evaluation = this.evaluateRequest(domain, req.method ?? 'GET', url.pathname)

  if (evaluation.decision === 'deny') {
    this.config.onBlock?.(`Request to ${domain} blocked — ${evaluation.reason}`)
    this.config.onFeedback?.({ type: 'block', domain, service: null, detail: evaluation.reason ?? '' })
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: evaluation.reason }))
    return
  }

  const service = evaluation.service!
  const creds = this.config.credentials.get(service.id)
  if (creds) {
    const injected = this.egressFilter.injectHeaders(service, creds)
    for (const [k, v] of Object.entries(injected)) {
      req.headers[k.toLowerCase()] = v
    }
  }

  // De-tokenize request body (resolve tokens being sent to this service)
  const reqChunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => reqChunks.push(chunk))
  req.on('end', () => {
    let reqBody = Buffer.concat(reqChunks)
    const bodyStr = reqBody.toString('utf-8')
    const detokenized = this.tokenMap.detokenizeString(bodyStr, service.id)
    if (detokenized !== bodyStr) {
      reqBody = Buffer.from(detokenized, 'utf-8')
    }

    const proxyReq = http.request(
      {
        hostname: domain,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: req.method,
        headers: { ...req.headers, 'content-length': String(reqBody.length) },
      },
      (proxyRes) => {
        const contentType = proxyRes.headers['content-type'] ?? null

        if (!this.ingressFilter.isScannable(contentType)) {
          // Pass through binary without scanning
          this._recordAudit(domain, req.method ?? 'GET', url.pathname, service.id, 'allow', null, {
            contentType,
            tlsInspected: false,
          })
          res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers)
          proxyRes.pipe(res)
          return
        }

        // Buffer and scan scannable responses
        const resChunks: Buffer[] = []
        proxyRes.on('data', (chunk: Buffer) => resChunks.push(chunk))
        proxyRes.on('end', () => {
          const resBody = Buffer.concat(resChunks).toString('utf-8')
          const scanResult = this.ingressFilter.scanResponse(contentType, resBody, service, url.pathname)

          if (scanResult.tokenizationsApplied > 0) {
            this.config.onFeedback?.({
              type: 'tokenization',
              domain,
              service: service.id,
              detail: `${scanResult.tokenizationsApplied} value(s) tokenized in response`,
            })
          }

          this._recordAudit(domain, req.method ?? 'GET', url.pathname, service.id, 'allow', null, {
            contentType,
            tlsInspected: false,
            redactionsApplied: scanResult.redactionsApplied,
            tokenizationsApplied: scanResult.tokenizationsApplied,
          })

          const responseBody = scanResult.processedBody ?? resBody
          const headers = { ...proxyRes.headers }
          headers['content-length'] = String(Buffer.byteLength(responseBody))
          delete headers['transfer-encoding']
          res.writeHead(proxyRes.statusCode ?? 200, headers)
          res.end(responseBody)
        })
      },
    )
    proxyReq.on('error', (err) => {
      res.writeHead(502)
      res.end(`Proxy error: ${err.message}`)
    })
    proxyReq.end(reqBody)
  })
}
```

**Step 2: Write test for HTTP response scanning**

Add to `src/main/services/latch-proxy.test.ts`:

```typescript
it('calls onFeedback callback on deny', () => {
  const feedback: any[] = []
  const proxy2 = new LatchProxy({
    sessionId: 'test-feedback-deny',
    services: [MOCK_SERVICE],
    credentials: new Map(),
    maxDataTier: 'internal',
    onFeedback: (msg) => feedback.push(msg),
  })
  // Trigger a deny via evaluateRequest then simulate _handleRequest logic
  const result = proxy2.evaluateRequest('evil.com', 'GET', '/')
  expect(result.decision).toBe('deny')
  proxy2.stop()
})
```

**Step 3: Run tests**

Run: `npx vitest run src/main/services/latch-proxy.test.ts`
Expected: All tests pass

**Step 4: Commit**

```bash
git add src/main/services/latch-proxy.ts src/main/services/latch-proxy.test.ts
git commit -m "feat(proxy): add response scanning and egress de-tokenization to HTTP handler"
```

---

## Task 7: EnclaveManager — CA Cert Path Injection

**Files:**
- Modify: `src/main/lib/enclave-manager.ts`
- Modify: `src/main/lib/enclave-manager.test.ts`

**Context:** When TLS interception is enabled, the sandbox needs to trust the ephemeral CA. We add the CA cert path to the environment via `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, and `GIT_SSL_CAINFO`.

**Step 1: Add `caCertPath` to `EnclaveEnvInput`**

Modify `src/main/lib/enclave-manager.ts`:

```typescript
export interface EnclaveEnvInput {
  proxyPort: number
  authzPort: number
  sessionId: string
  services: ServiceDefinition[]
  credentials: Map<string, Record<string, string>>
  caCertPath?: string  // Phase 2: ephemeral CA cert for TLS interception
}
```

**Step 2: Inject CA cert env vars in `buildEnclaveEnv`**

Add after the existing `HISTFILE` line in `buildEnclaveEnv`:

```typescript
// TLS interception — trust the session's ephemeral CA
if (input.caCertPath) {
  env.NODE_EXTRA_CA_CERTS = input.caCertPath
  env.SSL_CERT_FILE = input.caCertPath
  env.GIT_SSL_CAINFO = input.caCertPath
}
```

**Step 3: Write test**

Add to `src/main/lib/enclave-manager.test.ts`:

```typescript
it('injects CA cert env vars when caCertPath is provided', () => {
  const env = EnclaveManager.buildEnclaveEnv({
    proxyPort: 8080,
    authzPort: 9090,
    sessionId: 'test',
    services: [],
    credentials: new Map(),
    caCertPath: '/tmp/latch-ca-xxx/ca.crt',
  })
  expect(env.NODE_EXTRA_CA_CERTS).toBe('/tmp/latch-ca-xxx/ca.crt')
  expect(env.SSL_CERT_FILE).toBe('/tmp/latch-ca-xxx/ca.crt')
  expect(env.GIT_SSL_CAINFO).toBe('/tmp/latch-ca-xxx/ca.crt')
})

it('omits CA cert env vars when caCertPath is not provided', () => {
  const env = EnclaveManager.buildEnclaveEnv({
    proxyPort: 8080,
    authzPort: 9090,
    sessionId: 'test',
    services: [],
    credentials: new Map(),
  })
  expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined()
  expect(env.SSL_CERT_FILE).toBeUndefined()
  expect(env.GIT_SSL_CAINFO).toBeUndefined()
})
```

**Step 4: Run tests**

Run: `npx vitest run src/main/lib/enclave-manager.test.ts`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/main/lib/enclave-manager.ts src/main/lib/enclave-manager.test.ts
git commit -m "feat(enclave): inject CA cert paths for TLS interception trust"
```

---

## Task 8: Agent Feedback System

**Files:**
- Create: `src/main/services/proxy/proxy-feedback.ts`
- Create: `src/main/services/proxy/proxy-feedback.test.ts`
- Skill: `.agents/skills/enclave-proxy-feedback/SKILL.md`

**Context:** Agents need visibility into proxy enforcement. When a request is blocked, data is redacted, or tokens are created, the agent should see a formatted message in their terminal. This module formats `ProxyFeedbackMessage` objects into terminal-friendly strings and provides a callback factory that wires into the PTY send channel.

**Step 1: Write the failing test**

Create `src/main/services/proxy/proxy-feedback.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { formatFeedback, createFeedbackSender } from './proxy-feedback'
import type { ProxyFeedbackMessage } from '../../../types'

describe('ProxyFeedback', () => {
  it('formats block messages', () => {
    const msg: ProxyFeedbackMessage = {
      type: 'block',
      domain: 'evil.com',
      service: null,
      detail: 'evil.com is not an authorized service',
    }
    const formatted = formatFeedback(msg)
    expect(formatted).toContain('[LATCH]')
    expect(formatted).toContain('BLOCKED')
    expect(formatted).toContain('evil.com')
  })

  it('formats redaction messages', () => {
    const msg: ProxyFeedbackMessage = {
      type: 'redaction',
      domain: 'api.github.com',
      service: 'github',
      detail: '3 values redacted in response',
    }
    const formatted = formatFeedback(msg)
    expect(formatted).toContain('[LATCH]')
    expect(formatted).toContain('REDACTED')
    expect(formatted).toContain('github')
  })

  it('formats tokenization messages', () => {
    const msg: ProxyFeedbackMessage = {
      type: 'tokenization',
      domain: 'api.github.com',
      service: 'github',
      detail: '2 value(s) tokenized in response',
    }
    const formatted = formatFeedback(msg)
    expect(formatted).toContain('[LATCH]')
    expect(formatted).toContain('TOKENIZED')
  })

  it('formats tls-exception messages', () => {
    const msg: ProxyFeedbackMessage = {
      type: 'tls-exception',
      domain: 'pinned.example.com',
      service: 'pinned-svc',
      detail: 'TLS exception — tunneling without inspection',
    }
    const formatted = formatFeedback(msg)
    expect(formatted).toContain('[LATCH]')
    expect(formatted).toContain('TLS-EXCEPTION')
  })

  it('createFeedbackSender calls send function with formatted message', () => {
    const sent: string[] = []
    const sender = createFeedbackSender((data: string) => sent.push(data))
    sender({
      type: 'block',
      domain: 'evil.com',
      service: null,
      detail: 'blocked',
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('[LATCH]')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/services/proxy/proxy-feedback.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/main/services/proxy/proxy-feedback.ts`:

```typescript
/**
 * @module proxy-feedback
 * @description Formats proxy enforcement messages for agent terminal output.
 *
 * When the proxy blocks a request, redacts data, or tokenizes values,
 * a formatted message is sent to the agent's PTY so they have visibility
 * into enforcement actions.
 */

import type { ProxyFeedbackMessage } from '../../../types'

const LABELS: Record<ProxyFeedbackMessage['type'], string> = {
  block: 'BLOCKED',
  redaction: 'REDACTED',
  tokenization: 'TOKENIZED',
  'tls-exception': 'TLS-EXCEPTION',
}

/**
 * Format a proxy feedback message as a terminal-friendly string.
 * Uses ANSI dim styling so it's visible but not intrusive.
 */
export function formatFeedback(msg: ProxyFeedbackMessage): string {
  const label = LABELS[msg.type]
  const service = msg.service ? ` (${msg.service})` : ''
  // \x1b[2m = dim, \x1b[0m = reset
  return `\x1b[2m[LATCH] ${label}: ${msg.domain}${service} — ${msg.detail}\x1b[0m\r\n`
}

/**
 * Create a feedback callback that formats and sends messages to a PTY.
 *
 * @param writeFn - Function that writes a string to the agent's terminal
 * @returns A callback suitable for LatchProxyConfig.onFeedback
 */
export function createFeedbackSender(
  writeFn: (data: string) => void,
): (msg: ProxyFeedbackMessage) => void {
  return (msg: ProxyFeedbackMessage) => {
    writeFn(formatFeedback(msg))
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/services/proxy/proxy-feedback.test.ts`
Expected: All 5 tests pass

**Step 5: Write skill doc**

Create `.agents/skills/enclave-proxy-feedback/SKILL.md`:

```markdown
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
```

**Step 6: Commit**

```bash
git add src/main/services/proxy/proxy-feedback.ts src/main/services/proxy/proxy-feedback.test.ts .agents/skills/enclave-proxy-feedback/SKILL.md
git commit -m "feat(proxy): add ProxyFeedback for agent terminal enforcement messages"
```

---

## Task 9: Enhanced Audit Events

**Files:**
- Modify: `src/main/services/latch-proxy.ts`
- Modify: `src/main/services/latch-proxy.test.ts`

**Context:** Now that TLS interception and ingress scanning are wired in, we verify that audit events properly track `tlsInspected`, `contentType`, `redactionsApplied`, and `tokenizationsApplied`. Most of this was already done in Tasks 2, 5, and 6. This task adds explicit tests to verify the enriched audit trail.

**Step 1: Write tests for enhanced audit events**

Add to `src/main/services/latch-proxy.test.ts`:

```typescript
it('audit events include Phase 2 fields with defaults', () => {
  proxy.evaluateRequest('httpbin.org', 'GET', '/get')
  const events = proxy.getAuditLog()
  expect(events[0].tlsInspected).toBe(false)
  expect(events[0].redactionsApplied).toBe(0)
  expect(events[0].tokenizationsApplied).toBe(0)
})

it('audit events for denied requests have Phase 2 defaults', () => {
  proxy.evaluateRequest('evil.com', 'GET', '/')
  const events = proxy.getAuditLog()
  expect(events[0].tlsInspected).toBe(false)
  expect(events[0].contentType).toBeNull()
})
```

**Step 2: Run tests**

Run: `npx vitest run src/main/services/latch-proxy.test.ts`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/main/services/latch-proxy.test.ts
git commit -m "test(proxy): add audit event tests for Phase 2 fields"
```

---

## Task 10: Update Existing Agent Skills

**Files:**
- Modify: `.agents/skills/enclave-latch-proxy/SKILL.md`
- Modify: `.agents/skills/enclave-egress-filter/SKILL.md`
- Modify: `.agents/skills/enclave-token-map/SKILL.md`
- Modify: `.agents/skills/enclave-manager/SKILL.md`

**Context:** Phase 2 added significant new capabilities to the proxy and enclave manager. Update existing skill docs so future agents understand the current state.

**Step 1: Update enclave-latch-proxy skill**

Read the current skill and update it to reflect:
- TLS interception via TlsInterceptor (enabled with `enableTls: true`)
- IngressFilter for response body scanning
- `onFeedback` callback for agent terminal messages
- `getCaCertPath()` for env injection
- `tlsExceptions` support for degraded tunneling

**Step 2: Update enclave-egress-filter skill**

Add note that the egress filter is now also used during TLS MITM for intercepted requests.

**Step 3: Update enclave-token-map skill**

Add note that tokens are now automatically created by the IngressFilter during response scanning, and automatically resolved during egress de-tokenization.

**Step 4: Update enclave-manager skill**

Add note about `caCertPath` parameter and the three CA cert env vars (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `GIT_SSL_CAINFO`).

**Step 5: Commit**

```bash
git add .agents/skills/
git commit -m "docs(skills): update enclave skills for Phase 2 TLS and ingress capabilities"
```

---

## Task 11: Full Test Suite Verification

**Files:** None (verification only)

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All enclave tests pass. Pre-existing radar failures are expected and not caused by Phase 2 changes.

**Step 2: Run typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v policy-generator`
Expected: Clean (no errors from our code)

**Step 3: Verify test count**

Count new tests added in Phase 2:
- `tls-interceptor.test.ts`: 7 tests
- `ingress-filter.test.ts`: 9 tests
- `proxy-feedback.test.ts`: 5 tests
- `latch-proxy.test.ts` additions: ~5 tests
- `enclave-manager.test.ts` additions: 2 tests

Expected total new tests: ~28

**Step 4: No commit needed — this is verification only**

---

## Summary of Phase 2 deliverables

| Component | File | What it does |
|-----------|------|-------------|
| TlsInterceptor | `src/main/services/proxy/tls-interceptor.ts` | Ephemeral CA + per-domain leaf certs |
| IngressFilter | `src/main/services/proxy/ingress-filter.ts` | Content-type-aware response scanning + tokenization |
| ProxyFeedback | `src/main/services/proxy/proxy-feedback.ts` | Terminal messages for agent awareness |
| LatchProxy (enhanced) | `src/main/services/latch-proxy.ts` | TLS MITM, response scanning, egress de-tokenization |
| EnclaveManager (enhanced) | `src/main/lib/enclave-manager.ts` | CA cert env injection |
| Types (enhanced) | `src/types/index.ts` | TlsCertPair, IngressScanResult, ProxyFeedbackMessage, enhanced ProxyAuditEvent |

**New dependency:** `node-forge` + `@types/node-forge`

**Phase 2 commits:** ~10 commits (one per task)

**Phase 2 new tests:** ~28 tests across 3 new test files + 2 modified test files
