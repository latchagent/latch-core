# Latch Enclave Phase 5: Advanced — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add path/method scoping per service, credential lifecycle management (expiry detection, refresh, rotation), outbound credential leak scanning, LLM-assisted data classification, and a custom service builder UI.

**Architecture:** Phase 1-4 built the full proxy pipeline (egress filter → credential injection → TLS MITM → ingress scanning → tokenization → Merkle audit → PR annotation). Phase 5 deepens three axes: (1) finer-grained access control via path/method rules on top of domain matching, (2) credential lifecycle beyond static tokens, and (3) developer-facing tooling (service builder UI, LLM classifier). Team/enterprise and Latch Cloud are deferred to future work.

**Tech Stack:** Node.js `crypto`, `openai` (existing dep), React + Zustand, vitest for tests.

**Design doc:** `docs/plans/2026-02-28-latch-enclave-design.md` (Phase 5 section, lines 529-536)

**Pre-existing issues (not our bugs):**
- `radar.test.ts` has 4 failing tests — ignore these.
- `policy-generator.ts` has a type error — filter with `grep -v policy-generator`.

---

## Task 1: Add Phase 5 Types

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Add PathRule type and extend ServiceInjectionConfig**

Find `ServiceInjectionConfig` (around line 151). Add `pathRules` to the `proxy` object:

```typescript
export interface ServiceInjectionConfig {
  env: Record<string, string>
  files: Record<string, string>
  proxy: {
    domains: string[]
    headers: Record<string, string>
    tlsExceptions?: string[]
    pathRules?: PathRule[]        // NEW — Phase 5
  }
}

/** Path/method access rule for fine-grained service scoping. */
export interface PathRule {
  methods: string[]              // e.g. ['GET', 'POST'] or ['*']
  paths: string[]                // e.g. ['/repos/**', '/orgs/**'] — glob-style
  decision: 'allow' | 'deny'
}
```

**Step 2: Extend ServiceCredentialConfig with lifecycle fields**

Find `ServiceCredentialConfig` (around line 146). Add lifecycle fields:

```typescript
export interface ServiceCredentialConfig {
  type: 'token' | 'keypair' | 'oauth' | 'env-bundle'
  fields: string[]
  expiresAt?: string             // NEW — ISO 8601, null if non-expiring
  refreshEndpoint?: string       // NEW — URL for token refresh
  rotationPolicy?: 'manual' | 'auto'  // NEW — how rotation is handled
}
```

**Step 3: Extend ProxyFeedbackMessage with new types**

Find `ProxyFeedbackMessage` (around line 243). Update the type union:

```typescript
export interface ProxyFeedbackMessage {
  type: 'block' | 'redaction' | 'tokenization' | 'tls-exception' | 'scope-violation' | 'credential-expired' | 'leak-detected'
  domain: string
  service: string | null
  detail: string
}
```

**Step 4: Add DataClassification type**

After `ProxyFeedbackMessage`, add:

```typescript
/** Result from LLM-assisted data classification (propose only, never enforce). */
export interface DataClassification {
  suggestedTier: DataTier
  confidence: number             // 0-1
  patterns: string[]             // detected patterns that drove classification
  reasoning: string              // LLM explanation
}
```

**Step 5: Add new IPC methods to LatchAPI**

After the attestation methods, add:

```typescript
  // Data classification (LLM)
  classifyData(payload: { body: string; service: string; contentType: string }): Promise<{ ok: boolean; classification?: DataClassification; error?: string }>;

  // Credential lifecycle
  refreshCredential(payload: { serviceId: string }): Promise<{ ok: boolean; error?: string }>;
  getCredentialStatus(payload: { serviceId: string }): Promise<{ ok: boolean; expired: boolean; expiresAt: string | null; lastValidated: string | null }>;
```

**Step 6: Run typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v policy-generator`
Expected: Clean (new types are additive).

**Step 7: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): add path rules, credential lifecycle, data classification types"
```

---

## Task 2: Path/Method Scoping in EgressFilter

**Files:**
- Modify: `src/main/services/proxy/egress-filter.ts`
- Modify: `src/main/services/proxy/egress-filter.test.ts`

**Step 1: Write the failing tests**

Add to `egress-filter.test.ts`:

```typescript
  describe('path/method scoping', () => {
    const scopedService: ServiceDefinition = {
      ...testService,
      id: 'scoped-github',
      injection: {
        ...testService.injection,
        proxy: {
          ...testService.injection.proxy,
          pathRules: [
            { methods: ['GET', 'POST'], paths: ['/repos/**'], decision: 'allow' },
            { methods: ['DELETE'], paths: ['/repos/**'], decision: 'deny' },
            { methods: ['*'], paths: ['/admin/**'], decision: 'deny' },
          ],
        },
      },
    }

    it('allows request matching an allow rule', () => {
      const filter = new EgressFilter([scopedService])
      const result = filter.checkPathScope(scopedService, 'GET', '/repos/foo/bar')
      expect(result.allowed).toBe(true)
    })

    it('denies request matching a deny rule', () => {
      const filter = new EgressFilter([scopedService])
      const result = filter.checkPathScope(scopedService, 'DELETE', '/repos/foo/bar')
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('DELETE')
    })

    it('denies wildcard method on denied path', () => {
      const filter = new EgressFilter([scopedService])
      const result = filter.checkPathScope(scopedService, 'GET', '/admin/users')
      expect(result.allowed).toBe(false)
    })

    it('allows request when no pathRules defined', () => {
      const filter = new EgressFilter([testService])
      const result = filter.checkPathScope(testService, 'DELETE', '/anything')
      expect(result.allowed).toBe(true)
    })

    it('matches glob patterns with **', () => {
      const filter = new EgressFilter([scopedService])
      expect(filter.checkPathScope(scopedService, 'GET', '/repos/a/b/c').allowed).toBe(true)
      expect(filter.checkPathScope(scopedService, 'GET', '/other/path').allowed).toBe(true) // no matching deny rule
    })

    it('deny rules take precedence over allow rules for same path', () => {
      const filter = new EgressFilter([scopedService])
      // DELETE on /repos/** matches both allow (methods: ['*']) and deny (methods: ['DELETE'])
      // Deny should win when both match
      const result = filter.checkPathScope(scopedService, 'DELETE', '/repos/foo')
      expect(result.allowed).toBe(false)
    })
  })
```

Use the existing `testService` from the test file as the base — read the file first to see its shape.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/services/proxy/egress-filter.test.ts`
Expected: FAIL — `checkPathScope` not found.

**Step 3: Implement checkPathScope**

Add to `EgressFilter` class:

```typescript
  /**
   * Check if a request's method and path are allowed by the service's path rules.
   * Returns { allowed: true } if no rules defined or request passes.
   * Deny rules take precedence over allow rules.
   */
  checkPathScope(
    service: ServiceDefinition,
    method: string,
    path: string,
  ): { allowed: boolean; reason?: string } {
    const rules = service.injection.proxy.pathRules
    if (!rules || rules.length === 0) return { allowed: true }

    // Check deny rules first (deny takes precedence)
    for (const rule of rules) {
      if (rule.decision !== 'deny') continue
      if (this._methodMatches(rule.methods, method) && this._pathMatches(rule.paths, path)) {
        return { allowed: false, reason: `${method} ${path} denied by path rule` }
      }
    }

    // Check allow rules — if any allow rules exist, request must match one
    const allowRules = rules.filter(r => r.decision === 'allow')
    if (allowRules.length === 0) return { allowed: true }

    for (const rule of allowRules) {
      if (this._methodMatches(rule.methods, method) && this._pathMatches(rule.paths, path)) {
        return { allowed: true }
      }
    }

    // Allow rules exist but none matched — allow by default (deny must be explicit)
    return { allowed: true }
  }

  private _methodMatches(methods: string[], method: string): boolean {
    return methods.includes('*') || methods.includes(method.toUpperCase())
  }

  private _pathMatches(patterns: string[], path: string): boolean {
    return patterns.some(pattern => {
      const regex = new RegExp(
        '^' + pattern.replace(/\*\*/g, '.*').replace(/(?<!\.)(\*)/g, '[^/]*') + '$'
      )
      return regex.test(path)
    })
  }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/services/proxy/egress-filter.test.ts`
Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/main/services/proxy/egress-filter.ts src/main/services/proxy/egress-filter.test.ts
git commit -m "feat(egress-filter): add path/method scoping with glob patterns"
```

---

## Task 3: Wire Path Scoping into LatchProxy

**Files:**
- Modify: `src/main/services/latch-proxy.ts`
- Modify: `src/main/services/latch-proxy.test.ts`

**Step 1: Write the failing test**

Add to `latch-proxy.test.ts`:

```typescript
  it('blocks request when path scope is violated', async () => {
    const scopedService = {
      ...testService,
      injection: {
        ...testService.injection,
        proxy: {
          ...testService.injection.proxy,
          pathRules: [
            { methods: ['DELETE'], paths: ['/repos/**'], decision: 'deny' as const },
          ],
        },
      },
    }

    const proxy = new LatchProxy({
      sessionId: 'test-session',
      services: [scopedService],
      credentials: new Map(),
      maxDataTier: 'internal' as const,
    })
    await proxy.start()

    // GET should still be allowed
    const allow = proxy.evaluateRequest(testService.injection.proxy.domains[0], 'GET', '/repos/foo')
    expect(allow.decision).toBe('allow')

    // DELETE should be blocked
    const deny = proxy.evaluateRequest(testService.injection.proxy.domains[0], 'DELETE', '/repos/foo')
    expect(deny.decision).toBe('deny')
    expect(deny.reason).toContain('denied by path rule')

    proxy.stop()
  })
```

Read the test file first to get the exact `testService` variable name and domain.

**Step 2: Run tests to verify it fails**

Run: `npx vitest run src/main/services/latch-proxy.test.ts`
Expected: FAIL — evaluateRequest doesn't check path scope.

**Step 3: Update evaluateRequest**

In `LatchProxy.evaluateRequest`, after the tier check and before the allow return, add:

```typescript
    // Path/method scope check
    const scopeCheck = this.egressFilter.checkPathScope(service, method, path)
    if (!scopeCheck.allowed) {
      const reason = scopeCheck.reason ?? `${method} ${path} not allowed for service "${service.name}"`
      this._recordAudit(domain, method, path, service.id, 'deny', reason)
      return { decision: 'deny', service, reason }
    }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/services/latch-proxy.test.ts`
Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/main/services/latch-proxy.ts src/main/services/latch-proxy.test.ts
git commit -m "feat(latch-proxy): enforce path/method scoping in request evaluation"
```

---

## Task 4: Wire Outbound Leak Scanning

**Files:**
- Modify: `src/main/services/latch-proxy.ts`
- Modify: `src/main/services/latch-proxy.test.ts`

`EgressFilter.scanForLeaks` is fully implemented but never called. Wire it into both request paths.

**Step 1: Write the failing test**

```typescript
  it('detects credential leaks in outbound request bodies', () => {
    const creds = new Map([['httpbin', { token: 'secret-api-key-12345' }]])
    const proxy = new LatchProxy({
      sessionId: 'test-session',
      services: [testService],
      credentials: creds,
      maxDataTier: 'internal' as const,
    })

    // The proxy's egress filter should detect 'secret-api-key-12345' in an outbound body
    // We test via the egress filter directly since we can't easily intercept request bodies in unit tests
    const result = proxy['egressFilter'].scanForLeaks(testService, 'sending secret-api-key-12345 in body')
    expect(result.safe).toBe(false)
    expect(result.leaked).toContain('token')
  })
```

Note: Directly testing the leak scanning in an HTTP flow requires a real upstream server, which is complex. The test above verifies the egress filter itself works. The wiring into `_handleRequest` and `_handleInterceptedRequest` is done by code review.

**Step 2: Update _handleRequest to scan outbound body**

In `_handleRequest`, after de-tokenization and before `http.request`, add a leak scan:

```typescript
      // Scan outbound body for credential leaks
      if (creds) {
        const leakCheck = this.egressFilter.scanForLeaks(service, detokenized)
        if (!leakCheck.safe) {
          this.config.onFeedback?.({
            type: 'leak-detected',
            domain,
            service: service.id,
            detail: `Credential leak detected in request body: ${leakCheck.leaked.join(', ')}`,
          })
          this._recordAudit(domain, req.method ?? 'GET', url.pathname, service.id, 'deny', `Credential leak: ${leakCheck.leaked.join(', ')}`)
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `Request blocked: credential leak detected` }))
          return
        }
      }
```

**Step 3: Update _handleInterceptedRequest similarly**

In `_handleInterceptedRequest`, after de-tokenization and before `https.request`, add the same leak scan pattern.

**Step 4: Update proxy-feedback.ts with new label**

Add `'leak-detected': 'LEAK-DETECTED'` and `'scope-violation': 'SCOPE-DENIED'` and `'credential-expired': 'CRED-EXPIRED'` to the `LABELS` record.

**Step 5: Run tests**

Run: `npx vitest run src/main/services/latch-proxy.test.ts src/main/services/proxy/proxy-feedback.test.ts`
Expected: All tests PASS.

**Step 6: Commit**

```bash
git add src/main/services/latch-proxy.ts src/main/services/latch-proxy.test.ts src/main/services/proxy/proxy-feedback.ts
git commit -m "feat(latch-proxy): wire outbound credential leak scanning"
```

---

## Task 5: Credential Lifecycle Manager

**Files:**
- Create: `src/main/services/credential-manager.ts`
- Create: `src/main/services/credential-manager.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { CredentialManager } from './credential-manager'
import type { ServiceDefinition } from '../../types'

const mockService: ServiceDefinition = {
  id: 'test-svc',
  name: 'Test Service',
  category: 'cloud',
  protocol: 'http',
  credential: {
    type: 'token',
    fields: ['token'],
    expiresAt: new Date(Date.now() - 60000).toISOString(), // expired 1 minute ago
  },
  injection: { env: {}, files: {}, proxy: { domains: ['api.test.com'], headers: { Authorization: 'Bearer ${credential.token}' } } },
  dataTier: { defaultTier: 'internal', redaction: { patterns: [], fields: [] } },
  skill: { description: '', capabilities: [], constraints: [] },
}

describe('CredentialManager', () => {
  it('detects expired credentials', () => {
    const mgr = new CredentialManager()
    expect(mgr.isExpired(mockService)).toBe(true)
  })

  it('detects non-expired credentials', () => {
    const mgr = new CredentialManager()
    const fresh = { ...mockService, credential: { ...mockService.credential, expiresAt: new Date(Date.now() + 60000).toISOString() } }
    expect(mgr.isExpired(fresh)).toBe(false)
  })

  it('returns not expired when no expiresAt set', () => {
    const mgr = new CredentialManager()
    const noExpiry = { ...mockService, credential: { ...mockService.credential, expiresAt: undefined } }
    expect(mgr.isExpired(noExpiry)).toBe(false)
  })

  it('validates credential against upstream (mock)', async () => {
    const mgr = new CredentialManager()
    // Mock fetch to simulate a 200 OK
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })

    const result = await mgr.validateCredential(mockService, { token: 'test-token' })
    expect(result.valid).toBe(true)

    globalThis.fetch = origFetch
  })

  it('detects invalid credential via 401', async () => {
    const mgr = new CredentialManager()
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 })

    const result = await mgr.validateCredential(mockService, { token: 'bad-token' })
    expect(result.valid).toBe(false)
    expect(result.status).toBe(401)

    globalThis.fetch = origFetch
  })

  it('tracks credential status per service', () => {
    const mgr = new CredentialManager()
    mgr.recordValidation('test-svc', true)
    const status = mgr.getStatus('test-svc')
    expect(status.lastValidated).toBeDefined()
    expect(status.valid).toBe(true)
  })

  it('tracks last usage', () => {
    const mgr = new CredentialManager()
    mgr.recordUsage('test-svc')
    const status = mgr.getStatus('test-svc')
    expect(status.lastUsed).toBeDefined()
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/services/credential-manager.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement CredentialManager**

```typescript
/**
 * @module credential-manager
 * @description Manages credential lifecycle: expiry detection, validation,
 * usage tracking, and status reporting.
 *
 * Does NOT store credentials — that's SecretStore's job. This module
 * tracks metadata about credential health and provides lifecycle hooks.
 */

import type { ServiceDefinition } from '../../types'

export interface CredentialStatus {
  serviceId: string
  valid: boolean
  lastValidated: string | null
  lastUsed: string | null
  expired: boolean
}

export interface ValidationResult {
  valid: boolean
  status: number | null
  error?: string
}

export class CredentialManager {
  private statuses = new Map<string, CredentialStatus>()

  /** Check if a service's credential has expired based on expiresAt. */
  isExpired(service: ServiceDefinition): boolean {
    const expiresAt = service.credential.expiresAt
    if (!expiresAt) return false
    return new Date(expiresAt).getTime() < Date.now()
  }

  /**
   * Validate a credential by making a lightweight request to the service.
   * Uses the first domain in the service's proxy config.
   */
  async validateCredential(
    service: ServiceDefinition,
    credentials: Record<string, string>,
  ): Promise<ValidationResult> {
    const domain = service.injection.proxy.domains[0]
    if (!domain) return { valid: false, status: null, error: 'No domain configured' }

    try {
      // Build headers with credential injection
      const headers: Record<string, string> = {}
      for (const [key, template] of Object.entries(service.injection.proxy.headers)) {
        let value = template
        for (const [field, fieldValue] of Object.entries(credentials)) {
          value = value.replace(`\${credential.${field}}`, fieldValue)
        }
        headers[key] = value
      }

      const response = await fetch(`https://${domain}/`, {
        method: 'HEAD',
        headers,
        signal: AbortSignal.timeout(5000),
      })

      const valid = response.ok || response.status === 404 || response.status === 405
      this.recordValidation(service.id, valid)
      return { valid, status: response.status }
    } catch (err: any) {
      return { valid: false, status: null, error: err.message }
    }
  }

  /** Record that a credential was validated. */
  recordValidation(serviceId: string, valid: boolean): void {
    const existing = this.statuses.get(serviceId) ?? this._defaultStatus(serviceId)
    existing.valid = valid
    existing.lastValidated = new Date().toISOString()
    existing.expired = !valid
    this.statuses.set(serviceId, existing)
  }

  /** Record that a credential was used (injected into a request). */
  recordUsage(serviceId: string): void {
    const existing = this.statuses.get(serviceId) ?? this._defaultStatus(serviceId)
    existing.lastUsed = new Date().toISOString()
    this.statuses.set(serviceId, existing)
  }

  /** Get the current status for a service's credential. */
  getStatus(serviceId: string): CredentialStatus {
    return this.statuses.get(serviceId) ?? this._defaultStatus(serviceId)
  }

  private _defaultStatus(serviceId: string): CredentialStatus {
    return { serviceId, valid: true, lastValidated: null, lastUsed: null, expired: false }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/services/credential-manager.test.ts`
Expected: All 7 tests PASS.

**Step 5: Commit**

```bash
git add src/main/services/credential-manager.ts src/main/services/credential-manager.test.ts
git commit -m "feat(credential-manager): credential lifecycle with expiry detection and validation"
```

---

## Task 6: Data Classifier Service

**Files:**
- Create: `src/main/services/data-classifier.ts`
- Create: `src/main/services/data-classifier.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { DataClassifier, buildClassificationPrompt } from './data-classifier'

describe('DataClassifier', () => {
  it('buildClassificationPrompt includes body excerpt', () => {
    const prompt = buildClassificationPrompt('{"user":"alice"}', 'github', 'application/json')
    expect(prompt).toContain('alice')
    expect(prompt).toContain('github')
  })

  it('buildClassificationPrompt truncates long bodies', () => {
    const longBody = 'x'.repeat(10000)
    const prompt = buildClassificationPrompt(longBody, 'svc', 'text/plain')
    expect(prompt.length).toBeLessThan(6000)
  })

  it('parseClassificationResponse extracts tier and patterns', () => {
    const { parseClassificationResponse } = require('./data-classifier')
    const response = JSON.stringify({
      suggestedTier: 'confidential',
      confidence: 0.85,
      patterns: ['email address', 'API key'],
      reasoning: 'Contains PII and credentials',
    })
    const result = parseClassificationResponse(response)
    expect(result).not.toBeNull()
    expect(result!.suggestedTier).toBe('confidential')
    expect(result!.confidence).toBe(0.85)
    expect(result!.patterns).toContain('email address')
  })

  it('parseClassificationResponse returns null for invalid JSON', () => {
    const { parseClassificationResponse } = require('./data-classifier')
    expect(parseClassificationResponse('not json')).toBeNull()
  })

  it('parseClassificationResponse rejects invalid tiers', () => {
    const { parseClassificationResponse } = require('./data-classifier')
    const response = JSON.stringify({
      suggestedTier: 'ultra-secret',
      confidence: 0.5,
      patterns: [],
      reasoning: 'test',
    })
    expect(parseClassificationResponse(response)).toBeNull()
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/services/data-classifier.test.ts`
Expected: FAIL — module not found.

**Step 3: Write the implementation**

```typescript
/**
 * @module data-classifier
 * @description LLM-assisted data classification for response bodies.
 *
 * Design principle: LLMs may PROPOSE classifications but NEVER ENFORCE.
 * All classifications are advisory — the user must review and promote
 * suggestions to service definition patterns.
 */

import type { DataClassification, DataTier } from '../../types'

const VALID_TIERS: DataTier[] = ['public', 'internal', 'confidential', 'restricted']

const MAX_BODY_LENGTH = 4000

/** Build the classification prompt for the LLM. */
export function buildClassificationPrompt(
  body: string,
  serviceId: string,
  contentType: string,
): string {
  const excerpt = body.length > MAX_BODY_LENGTH
    ? body.slice(0, MAX_BODY_LENGTH) + '\n... [truncated]'
    : body

  return `You are a data classification assistant. Analyze the following API response body and classify its sensitivity tier.

Service: ${serviceId}
Content-Type: ${contentType}

Response body:
\`\`\`
${excerpt}
\`\`\`

Classify the data into one of these tiers:
- public: No sensitive data, safe for any context
- internal: Internal identifiers, non-public URLs, internal config
- confidential: PII (emails, names, addresses), API keys, tokens, credentials
- restricted: Financial data, health records, SSNs, encryption keys

Respond with a JSON object:
{
  "suggestedTier": "<tier>",
  "confidence": <0-1>,
  "patterns": ["<pattern description>", ...],
  "reasoning": "<explanation>"
}`
}

/** Parse and validate the LLM's classification response. */
export function parseClassificationResponse(response: string): DataClassification | null {
  try {
    const parsed = JSON.parse(response)
    if (!VALID_TIERS.includes(parsed.suggestedTier)) return null
    if (typeof parsed.confidence !== 'number') return null

    return {
      suggestedTier: parsed.suggestedTier,
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
      patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
      reasoning: String(parsed.reasoning ?? ''),
    }
  } catch {
    return null
  }
}

/**
 * Data classifier using the OpenAI API (same dep as policy-generator).
 * Requires an OpenAI API key in settings.
 */
export class DataClassifier {
  private apiKey: string | null

  constructor(apiKey: string | null) {
    this.apiKey = apiKey
  }

  /** Classify a response body. Returns null if no API key or classification fails. */
  async classify(
    body: string,
    serviceId: string,
    contentType: string,
  ): Promise<DataClassification | null> {
    if (!this.apiKey) return null

    const prompt = buildClassificationPrompt(body, serviceId, contentType)

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(15000),
      })

      if (!response.ok) return null

      const data = await response.json() as any
      const content = data.choices?.[0]?.message?.content
      if (!content) return null

      return parseClassificationResponse(content)
    } catch {
      return null
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/services/data-classifier.test.ts`
Expected: All 5 tests PASS.

**Step 5: Commit**

```bash
git add src/main/services/data-classifier.ts src/main/services/data-classifier.test.ts
git commit -m "feat(data-classifier): LLM-assisted data classification (propose only)"
```

---

## Task 7: Add Classifier + Credential IPC Handlers

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

**Step 1: Add imports and singletons**

In `src/main/index.ts`:

```typescript
import { DataClassifier } from './services/data-classifier'
import { CredentialManager } from './services/credential-manager'
```

Add singletons:
```typescript
let dataClassifier: DataClassifier | null = null
let credentialManager: CredentialManager | null = null
```

In app.whenReady(), initialize:
```typescript
    credentialManager = new CredentialManager()
    // DataClassifier needs OpenAI key — resolve from settings
    const openaiKey = settingsStore?.get('openai-api-key')
    dataClassifier = new DataClassifier(openaiKey?.value ?? null)
```

Note: Read how `settingsStore` works in index.ts to use the correct API.

**Step 2: Add IPC handlers**

```typescript
  ipcMain.handle('latch:data-classify', async (_event: any, { body, service, contentType }: any) => {
    if (!dataClassifier) return { ok: false, error: 'DataClassifier unavailable' }
    const classification = await dataClassifier.classify(body, service, contentType)
    if (!classification) return { ok: false, error: 'Classification failed' }
    return { ok: true, classification }
  })

  ipcMain.handle('latch:credential-refresh', async (_event: any, { serviceId }: any) => {
    if (!credentialManager || !serviceStore) return { ok: false, error: 'CredentialManager unavailable' }
    const svcRecord = serviceStore.getById(serviceId)
    if (!svcRecord) return { ok: false, error: 'Service not found' }
    if (!secretStore) return { ok: false, error: 'SecretStore unavailable' }

    const credValue = secretStore.resolve(`svc-${serviceId}`)
    if (!credValue) return { ok: false, error: 'No credential stored' }

    let creds: Record<string, string>
    try { creds = JSON.parse(credValue) } catch { return { ok: false, error: 'Invalid credential format' } }

    const result = await credentialManager.validateCredential(svcRecord.definition, creds)
    return { ok: true, valid: result.valid, status: result.status }
  })

  ipcMain.handle('latch:credential-status', async (_event: any, { serviceId }: any) => {
    if (!credentialManager) return { ok: false, expired: false, expiresAt: null, lastValidated: null }
    const status = credentialManager.getStatus(serviceId)
    return { ok: true, expired: status.expired, expiresAt: null, lastValidated: status.lastValidated }
  })
```

**Step 3: Add preload entries**

```typescript
  classifyData: (payload: { body: string; service: string; contentType: string }) =>
    ipcRenderer.invoke('latch:data-classify', payload),

  refreshCredential: (payload: { serviceId: string }) =>
    ipcRenderer.invoke('latch:credential-refresh', payload),

  getCredentialStatus: (payload: { serviceId: string }) =>
    ipcRenderer.invoke('latch:credential-status', payload),
```

**Step 4: Run typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v policy-generator`
Expected: Clean.

**Step 5: Commit**

```bash
git add src/main/index.ts src/preload/index.ts
git commit -m "feat(ipc): add data classification and credential lifecycle handlers"
```

---

## Task 8: Custom Service Builder UI

**Files:**
- Create: `src/renderer/components/modals/ServiceEditor.tsx`
- Modify: `src/renderer/components/panels/ServicesPanel.tsx`
- Modify: `src/renderer/styles.css`

**Step 1: Read existing patterns**

Read `src/renderer/components/modals/PolicyEditor.tsx` for the modal pattern.
Read `src/renderer/components/panels/ServicesPanel.tsx` for how services are listed and how to add a "Create Service" button.
Read `src/renderer/store/useAppStore.ts` for any existing service-related state.

**Step 2: Create ServiceEditor.tsx**

A modal form for creating/editing custom services. Fields:
- ID (auto-generated or editable for custom)
- Name (text input)
- Category (select: vcs, cloud, comms, ci, registry, custom)
- Protocol (select: http, ssh, db, grpc, custom)
- Domains (multi-line input, one per line)
- Headers (key-value pair inputs)
- TLS Exceptions (multi-line, one per line)
- Credential type (select: token, keypair, oauth, env-bundle)
- Credential fields (multi-line, one per line)
- Data tier (select: public, internal, confidential, restricted)
- Redaction patterns (multi-line, regex per line)
- Skill description (textarea)
- Capabilities (multi-line)
- Constraints (multi-line)

Form submits via `window.latch.saveService({ definition })`.
Include a "Save" button and a "Cancel" button.

**Step 3: Add "Create Service" button to ServicesPanel**

Add a button at the top of ServicesPanel that opens the ServiceEditor modal.
Use existing state pattern — add `showServiceEditor` boolean to the panel's local state.

**Step 4: Add styles**

Append service editor styles to `styles.css`:

```css
/* ─── Service Editor ─────────────────────────────────────────────────────── */

.service-editor-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.service-editor {
  background: var(--bg-primary);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 24px;
  width: 520px;
  max-height: 80vh;
  overflow-y: auto;
}

.service-editor h3 {
  margin: 0 0 16px 0;
  font-size: 16px;
}

.service-editor-field {
  margin-bottom: 12px;
}

.service-editor-field label {
  display: block;
  font-size: 11px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 4px;
}

.service-editor-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}
```

**Step 5: Run typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v policy-generator`
Expected: Clean.

**Step 6: Commit**

```bash
git add src/renderer/components/modals/ServiceEditor.tsx src/renderer/components/panels/ServicesPanel.tsx src/renderer/styles.css
git commit -m "feat(ui): add custom service builder modal"
```

---

## Task 9: Update Service Catalog with Path Rules

**Files:**
- Modify: `src/main/lib/service-catalog.ts`

**Step 1: Add path rules to GitHub service**

The GitHub service should have path rules that block destructive operations:

```typescript
pathRules: [
  { methods: ['DELETE'], paths: ['/repos/*/collaborators/*'], decision: 'deny' },
  { methods: ['DELETE'], paths: ['/repos/*/*'], decision: 'deny' },
  { methods: ['PUT'], paths: ['/repos/*/topics'], decision: 'deny' },
],
```

**Step 2: Add path rules to AWS service**

Block dangerous IAM operations:

```typescript
pathRules: [
  { methods: ['*'], paths: ['/iam/**'], decision: 'deny' },
  { methods: ['DELETE'], paths: ['/**'], decision: 'deny' },
],
```

**Step 3: Run tests**

Run: `npx vitest run src/main/lib/service-catalog.test.ts`
Expected: All tests PASS.

**Step 4: Commit**

```bash
git add src/main/lib/service-catalog.ts
git commit -m "feat(service-catalog): add path/method scoping rules for GitHub and AWS"
```

---

## Task 10: Update Agent Skills

**Files:**
- Modify: `.agents/skills/enclave-egress-filter/SKILL.md` (if exists) or create
- Modify: `.agents/skills/enclave-latch-proxy/SKILL.md`
- Create: `.agents/skills/enclave-credential-manager/SKILL.md`
- Create: `.agents/skills/enclave-data-classifier/SKILL.md`

Update/create skill docs covering:
- Path/method scoping in egress filter (`checkPathScope`, `PathRule`, glob matching)
- Leak scanning in latch-proxy (`scanForLeaks` now wired)
- Credential lifecycle (`CredentialManager`, expiry detection, validation)
- Data classification (`DataClassifier`, prompt building, `parseClassificationResponse`)
- Custom service builder UI (`ServiceEditor.tsx`)
- Service catalog path rules

**Step 1: Create/update each skill doc**

**Step 2: Commit**

```bash
git add .agents/skills/
git commit -m "docs(skills): add Phase 5 skills for path scoping, credentials, data classification"
```

---

## Task 11: Full Test Suite Verification

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests pass except the 4 pre-existing `radar.test.ts` failures.

**Step 2: Run typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v policy-generator`
Expected: Clean (no errors).

**Step 3: Report results**

Report total test count, new tests added, commit count, and any issues.
