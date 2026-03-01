# Latch Enclave Phase 1: Foundation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship the foundational zero-trust enclave infrastructure — service registry, deny-by-default egress proxy, credential injection, sandbox enforcement, signed session receipts, and auto-generated agent skills.

**Architecture:** Every agent session runs inside a Docker sandbox with a single network exit — the Latch Proxy. Services are first-class objects (credential + injection rules + policy scope + skill). The proxy gates by domain/service, injects credentials, and logs all requests. Session receipts prove what policy was enforced.

**Tech Stack:** Node.js HTTP proxy, better-sqlite3, Electron safeStorage, Ed25519 (Node crypto), Docker (via existing docker-manager), vitest for tests.

**Design doc:** `docs/plans/2026-02-28-latch-enclave-design.md`

---

## Task 1: Core Types

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Add enclave types after the SecretRecord section (line ~139)**

```typescript
// ─── Service (enclave) ──────────────────────────────────────────────────────

export type DataTier = 'public' | 'internal' | 'confidential' | 'restricted'
export type ServiceCategory = 'vcs' | 'cloud' | 'comms' | 'ci' | 'registry' | 'custom'
export type ServiceProtocol = 'http' | 'ssh' | 'db' | 'grpc' | 'custom'

export interface ServiceCredentialConfig {
  type: 'token' | 'keypair' | 'oauth' | 'env-bundle'
  fields: string[]
}

export interface ServiceInjectionConfig {
  env: Record<string, string>
  files: Record<string, string>
  proxy: {
    domains: string[]
    headers: Record<string, string>
    tlsExceptions?: string[]
  }
}

export interface ServiceDefinition {
  id: string
  name: string
  category: ServiceCategory
  protocol: ServiceProtocol
  credential: ServiceCredentialConfig
  injection: ServiceInjectionConfig
  dataTier: {
    defaultTier: DataTier
    redaction: {
      patterns: string[]
      fields: string[]
    }
  }
  skill: {
    description: string
    capabilities: string[]
    constraints: string[]
  }
}

/** Stored service instance — definition + user credential metadata. */
export interface ServiceRecord {
  id: string
  definitionId: string
  name: string
  category: ServiceCategory
  protocol: ServiceProtocol
  definition: ServiceDefinition
  hasCredential: boolean
  expiresAt: string | null
  lastUsed: string | null
  createdAt: string
  updatedAt: string
}

/** Token entry for same-origin tokenization. */
export interface TokenEntry {
  id: string
  value: string
  origin: {
    service: string
    tier: DataTier
    endpoint: string
  }
  validDestinations: string[]
  createdAt: string
}

/** Proxy audit event. */
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
}

/** Signed session receipt. */
export interface SessionReceipt {
  version: 1
  sessionId: string
  policy: {
    id: string
    hash: string
    maxDataTier: DataTier
    servicesGranted: string[]
  }
  activity: {
    servicesUsed: string[]
    networkRequests: number
    blockedRequests: number
    redactionsApplied: number
    tokenizationsApplied: number
    toolCalls: number
    toolDenials: number
    approvalEscalations: number
  }
  enclave: {
    sandboxType: 'docker' | 'seatbelt' | 'bubblewrap'
    networkForced: boolean
    startedAt: string
    endedAt: string
    exitReason: 'normal' | 'timeout' | 'killed' | 'error'
  }
  proof: {
    auditEventCount: number
    auditHashChain: string
    signature: string
    publicKey: string
  }
}
```

**Step 2: Add `'services'` to the `RailPanel` union type (line ~321)**

Change:
```typescript
export type RailPanel = 'activity' | 'policy';
```
To:
```typescript
export type RailPanel = 'activity' | 'policy' | 'services';
```

**Step 3: Add service/enclave methods to the `LatchAPI` interface (after line ~443, before Feed section)**

```typescript
  // Services (enclave)
  listServices(): Promise<{ ok: boolean; services: ServiceRecord[] }>;
  getService(payload: { id: string }): Promise<{ ok: boolean; service?: ServiceRecord; error?: string }>;
  saveService(payload: { definition: ServiceDefinition; credentialValue?: string }): Promise<{ ok: boolean; error?: string }>;
  deleteService(payload: { id: string }): Promise<{ ok: boolean }>;
  getServiceCatalog(): Promise<{ ok: boolean; catalog: ServiceDefinition[] }>;

  // Attestation
  getAttestation(payload: { sessionId: string }): Promise<{ ok: boolean; receipt?: SessionReceipt; error?: string }>;
  listProxyAudit(payload: { sessionId: string; limit?: number }): Promise<{ ok: boolean; events: ProxyAuditEvent[] }>;
```

**Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (types are additive, nothing uses them yet)

**Step 5: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): add Service, DataTier, SessionReceipt, and ProxyAuditEvent types"
```

---

## Task 2: Service Store

**Files:**
- Create: `src/main/stores/service-store.ts`
- Test: `src/main/stores/service-store.test.ts`

**Step 1: Write the failing test**

```typescript
// src/main/stores/service-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { ServiceStore } from './service-store'
import type { ServiceDefinition } from '../../types'

const GITHUB_DEF: ServiceDefinition = {
  id: 'github',
  name: 'GitHub',
  category: 'vcs',
  protocol: 'http',
  credential: { type: 'token', fields: ['token'] },
  injection: {
    env: { GH_TOKEN: '${credential.token}' },
    files: {},
    proxy: {
      domains: ['api.github.com', '*.githubusercontent.com'],
      headers: { Authorization: 'Bearer ${credential.token}' },
    },
  },
  dataTier: {
    defaultTier: 'internal',
    redaction: { patterns: ['ghp_[a-zA-Z0-9_]+'], fields: [] },
  },
  skill: {
    description: 'GitHub access via gh CLI.',
    capabilities: ['gh pr', 'gh issue'],
    constraints: ['Never print tokens'],
  },
}

describe('ServiceStore', () => {
  let store: ServiceStore

  beforeEach(() => {
    const db = new Database(':memory:')
    store = ServiceStore.open(db)
  })

  it('saves and lists services', () => {
    const result = store.save(GITHUB_DEF)
    expect(result.ok).toBe(true)

    const { services } = store.list()
    expect(services).toHaveLength(1)
    expect(services[0].definitionId).toBe('github')
    expect(services[0].name).toBe('GitHub')
    expect(services[0].hasCredential).toBe(false)
  })

  it('gets a service by id', () => {
    store.save(GITHUB_DEF)
    const result = store.get('github')
    expect(result.ok).toBe(true)
    expect(result.service?.definition.injection.proxy.domains).toContain('api.github.com')
  })

  it('returns error for missing service', () => {
    const result = store.get('nonexistent')
    expect(result.ok).toBe(false)
  })

  it('deletes a service', () => {
    store.save(GITHUB_DEF)
    store.delete('github')
    expect(store.list().services).toHaveLength(0)
  })

  it('grants and lists services for a session', () => {
    store.save(GITHUB_DEF)
    store.grantToSession('github', 'session-1')
    const granted = store.listForSession('session-1')
    expect(granted).toHaveLength(1)
    expect(granted[0].definitionId).toBe('github')
  })

  it('revokes session grant', () => {
    store.save(GITHUB_DEF)
    store.grantToSession('github', 'session-1')
    store.revokeFromSession('github', 'session-1')
    expect(store.listForSession('session-1')).toHaveLength(0)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/stores/service-store.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/main/stores/service-store.ts
/**
 * @module service-store
 * @description CRUD for service definitions and session grants.
 *
 * Service definitions (ServiceDefinition) are stored as JSON blobs.
 * Credential values are stored separately via SecretStore (never in this table).
 * Session grants track which services are available to which sessions.
 */

import type Database from 'better-sqlite3'
import type { ServiceDefinition, ServiceRecord } from '../../types'

export class ServiceStore {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  static open(db: Database.Database): ServiceStore {
    const store = new ServiceStore(db)
    store._init()
    return store
  }

  private _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS services (
        id            TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL,
        name          TEXT NOT NULL,
        category      TEXT NOT NULL,
        protocol      TEXT NOT NULL DEFAULT 'http',
        body          TEXT NOT NULL,
        has_credential INTEGER NOT NULL DEFAULT 0,
        expires_at    TEXT,
        last_used     TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS service_grants (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id  TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        granted_at  TEXT NOT NULL,
        UNIQUE(service_id, session_id)
      )
    `)
  }

  /** Save or update a service definition. */
  save(definition: ServiceDefinition): { ok: boolean; error?: string } {
    if (!definition.id || !definition.name) {
      return { ok: false, error: 'Service must have an id and name.' }
    }
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO services (id, definition_id, name, category, protocol, body, created_at, updated_at)
      VALUES (@id, @definitionId, @name, @category, @protocol, @body, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        definition_id = @definitionId, name = @name, category = @category,
        protocol = @protocol, body = @body, updated_at = @now
    `).run({
      id: definition.id,
      definitionId: definition.id,
      name: definition.name,
      category: definition.category,
      protocol: definition.protocol,
      body: JSON.stringify(definition),
      now,
    })
    return { ok: true }
  }

  /** List all registered services. */
  list(): { ok: boolean; services: ServiceRecord[] } {
    const rows = this.db.prepare('SELECT * FROM services ORDER BY name ASC').all() as any[]
    return { ok: true, services: rows.map(r => this._toRecord(r)) }
  }

  /** Get a single service by id. */
  get(id: string): { ok: boolean; service?: ServiceRecord; error?: string } {
    const row = this.db.prepare('SELECT * FROM services WHERE id = ?').get(id) as any
    if (!row) return { ok: false, error: `Service '${id}' not found.` }
    return { ok: true, service: this._toRecord(row) }
  }

  /** Delete a service and its grants. */
  delete(id: string): { ok: boolean } {
    this.db.prepare('DELETE FROM service_grants WHERE service_id = ?').run(id)
    this.db.prepare('DELETE FROM services WHERE id = ?').run(id)
    return { ok: true }
  }

  /** Mark that a credential has been stored for this service. */
  markCredentialStored(id: string): void {
    this.db.prepare('UPDATE services SET has_credential = 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id)
  }

  /** Update last-used timestamp. */
  touchLastUsed(id: string): void {
    this.db.prepare('UPDATE services SET last_used = ?, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), new Date().toISOString(), id)
  }

  /** Grant a service to a session. */
  grantToSession(serviceId: string, sessionId: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO service_grants (service_id, session_id, granted_at)
      VALUES (?, ?, ?)
    `).run(serviceId, sessionId, new Date().toISOString())
  }

  /** Revoke a service from a session. */
  revokeFromSession(serviceId: string, sessionId: string): void {
    this.db.prepare('DELETE FROM service_grants WHERE service_id = ? AND session_id = ?')
      .run(serviceId, sessionId)
  }

  /** List services granted to a specific session. */
  listForSession(sessionId: string): ServiceRecord[] {
    const rows = this.db.prepare(`
      SELECT s.* FROM services s
      JOIN service_grants g ON s.id = g.service_id
      WHERE g.session_id = ?
      ORDER BY s.name ASC
    `).all(sessionId) as any[]
    return rows.map(r => this._toRecord(r))
  }

  private _toRecord(row: any): ServiceRecord {
    let definition: ServiceDefinition
    try {
      definition = JSON.parse(row.body)
    } catch {
      definition = { id: row.id, name: row.name } as any
    }
    return {
      id: row.id,
      definitionId: row.definition_id,
      name: row.name,
      category: row.category,
      protocol: row.protocol,
      definition,
      hasCredential: !!row.has_credential,
      expiresAt: row.expires_at,
      lastUsed: row.last_used,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/stores/service-store.test.ts`
Expected: PASS (all 6 tests)

**Step 5: Commit**

```bash
git add src/main/stores/service-store.ts src/main/stores/service-store.test.ts
git commit -m "feat(stores): add ServiceStore with session grants"
```

---

## Task 3: Service Catalog

**Files:**
- Create: `src/main/lib/service-catalog.ts`
- Test: `src/main/lib/service-catalog.test.ts`

**Step 1: Write the failing test**

```typescript
// src/main/lib/service-catalog.test.ts
import { describe, it, expect } from 'vitest'
import { SERVICE_CATALOG, getCatalogService } from './service-catalog'

describe('ServiceCatalog', () => {
  it('has at least 5 built-in services', () => {
    expect(SERVICE_CATALOG.length).toBeGreaterThanOrEqual(5)
  })

  it('every service has required fields', () => {
    for (const svc of SERVICE_CATALOG) {
      expect(svc.id).toBeTruthy()
      expect(svc.name).toBeTruthy()
      expect(svc.category).toBeTruthy()
      expect(svc.protocol).toBe('http') // v1: all HTTP
      expect(svc.credential.fields.length).toBeGreaterThan(0)
      expect(svc.injection.proxy.domains.length).toBeGreaterThan(0)
      expect(svc.skill.description).toBeTruthy()
    }
  })

  it('looks up service by id', () => {
    const gh = getCatalogService('github')
    expect(gh).toBeDefined()
    expect(gh!.name).toBe('GitHub')
  })

  it('returns undefined for unknown id', () => {
    expect(getCatalogService('nope')).toBeUndefined()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/lib/service-catalog.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/main/lib/service-catalog.ts
/**
 * @module service-catalog
 * @description Built-in service definitions for common developer tools.
 *
 * Each entry is a ServiceDefinition that can be installed by the user.
 * The catalog is static — user-customized services live in ServiceStore.
 */

import type { ServiceDefinition } from '../../types'

export const SERVICE_CATALOG: ServiceDefinition[] = [
  {
    id: 'github',
    name: 'GitHub',
    category: 'vcs',
    protocol: 'http',
    credential: { type: 'token', fields: ['token'] },
    injection: {
      env: { GH_TOKEN: '${credential.token}', GITHUB_TOKEN: '${credential.token}' },
      files: {},
      proxy: {
        domains: ['api.github.com', '*.githubusercontent.com', 'github.com'],
        headers: { Authorization: 'Bearer ${credential.token}' },
      },
    },
    dataTier: {
      defaultTier: 'internal',
      redaction: { patterns: ['ghp_[a-zA-Z0-9_]{36}', 'ghu_[a-zA-Z0-9_]+', 'ghs_[a-zA-Z0-9_]+'], fields: [] },
    },
    skill: {
      description: 'GitHub access via gh CLI and GitHub API. Auth is automatic.',
      capabilities: ['gh pr create', 'gh issue list', 'gh api', 'git push', 'git pull'],
      constraints: ['Never print or log tokens', 'Use gh CLI when possible', 'Do not modify ~/.config/gh/'],
    },
  },
  {
    id: 'npm',
    name: 'npm',
    category: 'registry',
    protocol: 'http',
    credential: { type: 'token', fields: ['token'] },
    injection: {
      env: { NPM_TOKEN: '${credential.token}' },
      files: {},
      proxy: {
        domains: ['registry.npmjs.org', 'www.npmjs.com'],
        headers: { Authorization: 'Bearer ${credential.token}' },
      },
    },
    dataTier: {
      defaultTier: 'internal',
      redaction: { patterns: ['npm_[a-zA-Z0-9]{36}'], fields: [] },
    },
    skill: {
      description: 'npm registry access for publishing and installing private packages.',
      capabilities: ['npm publish', 'npm install (private)'],
      constraints: ['Never print tokens', 'Do not modify ~/.npmrc'],
    },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    category: 'cloud',
    protocol: 'http',
    credential: { type: 'token', fields: ['token'] },
    injection: {
      env: { OPENAI_API_KEY: '${credential.token}' },
      files: {},
      proxy: {
        domains: ['api.openai.com'],
        headers: { Authorization: 'Bearer ${credential.token}' },
      },
    },
    dataTier: {
      defaultTier: 'internal',
      redaction: { patterns: ['sk-[a-zA-Z0-9]{48}', 'sk-proj-[a-zA-Z0-9_-]+'], fields: [] },
    },
    skill: {
      description: 'OpenAI API access. Auth is automatic.',
      capabilities: ['OpenAI API calls', 'curl to api.openai.com'],
      constraints: ['Never print API keys', 'Use environment variable, not hardcoded keys'],
    },
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    category: 'cloud',
    protocol: 'http',
    credential: { type: 'token', fields: ['token'] },
    injection: {
      env: { ANTHROPIC_API_KEY: '${credential.token}' },
      files: {},
      proxy: {
        domains: ['api.anthropic.com'],
        headers: { 'x-api-key': '${credential.token}' },
      },
    },
    dataTier: {
      defaultTier: 'internal',
      redaction: { patterns: ['sk-ant-[a-zA-Z0-9_-]+'], fields: [] },
    },
    skill: {
      description: 'Anthropic API access. Auth is automatic.',
      capabilities: ['Anthropic API calls'],
      constraints: ['Never print API keys'],
    },
  },
  {
    id: 'vercel',
    name: 'Vercel',
    category: 'ci',
    protocol: 'http',
    credential: { type: 'token', fields: ['token'] },
    injection: {
      env: { VERCEL_TOKEN: '${credential.token}' },
      files: {},
      proxy: {
        domains: ['api.vercel.com', 'vercel.com'],
        headers: { Authorization: 'Bearer ${credential.token}' },
      },
    },
    dataTier: {
      defaultTier: 'internal',
      redaction: { patterns: [], fields: [] },
    },
    skill: {
      description: 'Vercel deployment and project management. Auth is automatic.',
      capabilities: ['vercel deploy', 'vercel env', 'vercel ls'],
      constraints: ['Never print tokens', 'Do not modify ~/.vercel/'],
    },
  },
  {
    id: 'slack',
    name: 'Slack',
    category: 'comms',
    protocol: 'http',
    credential: { type: 'token', fields: ['token'] },
    injection: {
      env: { SLACK_TOKEN: '${credential.token}' },
      files: {},
      proxy: {
        domains: ['slack.com', '*.slack.com'],
        headers: { Authorization: 'Bearer ${credential.token}' },
      },
    },
    dataTier: {
      defaultTier: 'confidential',
      redaction: { patterns: ['xoxb-[0-9]+-[a-zA-Z0-9]+', 'xoxp-[0-9]+-[a-zA-Z0-9]+'], fields: [] },
    },
    skill: {
      description: 'Slack API access for messaging and workspace operations.',
      capabilities: ['Slack API calls', 'curl to slack.com'],
      constraints: ['Never print tokens', 'Do not post to channels without explicit instruction'],
    },
  },
  {
    id: 'aws',
    name: 'AWS',
    category: 'cloud',
    protocol: 'http',
    credential: { type: 'env-bundle', fields: ['accessKeyId', 'secretAccessKey'] },
    injection: {
      env: {
        AWS_ACCESS_KEY_ID: '${credential.accessKeyId}',
        AWS_SECRET_ACCESS_KEY: '${credential.secretAccessKey}',
      },
      files: {},
      proxy: {
        domains: ['*.amazonaws.com', '*.aws.amazon.com'],
        headers: {},
      },
    },
    dataTier: {
      defaultTier: 'confidential',
      redaction: {
        patterns: ['AKIA[0-9A-Z]{16}', '[a-zA-Z0-9/+=]{40}'],
        fields: [],
      },
    },
    skill: {
      description: 'AWS access via aws CLI. Auth is automatic via environment variables.',
      capabilities: ['aws s3', 'aws ec2', 'aws lambda', 'aws iam'],
      constraints: ['Never print access keys', 'Do not modify ~/.aws/'],
    },
  },
]

/** Look up a catalog service definition by id. */
export function getCatalogService(id: string): ServiceDefinition | undefined {
  return SERVICE_CATALOG.find(s => s.id === id)
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/lib/service-catalog.test.ts`
Expected: PASS (all 4 tests)

**Step 5: Commit**

```bash
git add src/main/lib/service-catalog.ts src/main/lib/service-catalog.test.ts
git commit -m "feat(catalog): add built-in service definitions for 7 services"
```

---

## Task 4: Egress Filter

**Files:**
- Create: `src/main/services/proxy/egress-filter.ts`
- Test: `src/main/services/proxy/egress-filter.test.ts`

**Step 1: Write the failing test**

```typescript
// src/main/services/proxy/egress-filter.test.ts
import { describe, it, expect } from 'vitest'
import { EgressFilter } from './egress-filter'
import type { ServiceDefinition, DataTier } from '../../../types'

const GITHUB: ServiceDefinition = {
  id: 'github',
  name: 'GitHub',
  category: 'vcs',
  protocol: 'http',
  credential: { type: 'token', fields: ['token'] },
  injection: {
    env: {},
    files: {},
    proxy: {
      domains: ['api.github.com', '*.githubusercontent.com'],
      headers: { Authorization: 'Bearer ${credential.token}' },
    },
  },
  dataTier: { defaultTier: 'internal', redaction: { patterns: ['ghp_[a-zA-Z0-9_]+'], fields: [] } },
  skill: { description: '', capabilities: [], constraints: [] },
}

describe('EgressFilter', () => {
  const filter = new EgressFilter([GITHUB])

  describe('matchService', () => {
    it('matches exact domain', () => {
      expect(filter.matchService('api.github.com')?.id).toBe('github')
    })

    it('matches wildcard domain', () => {
      expect(filter.matchService('raw.githubusercontent.com')?.id).toBe('github')
    })

    it('returns null for unknown domain', () => {
      expect(filter.matchService('evil.com')).toBeNull()
    })

    it('is case-insensitive', () => {
      expect(filter.matchService('API.GITHUB.COM')?.id).toBe('github')
    })
  })

  describe('checkTierAccess', () => {
    it('allows same tier', () => {
      expect(filter.checkTierAccess('internal', 'internal')).toBe(true)
    })

    it('allows lower tier', () => {
      expect(filter.checkTierAccess('public', 'confidential')).toBe(true)
    })

    it('blocks higher tier', () => {
      expect(filter.checkTierAccess('confidential', 'internal')).toBe(false)
    })
  })

  describe('injectHeaders', () => {
    it('substitutes credential placeholders', () => {
      const headers = filter.injectHeaders(GITHUB, { token: 'ghp_abc123' })
      expect(headers['Authorization']).toBe('Bearer ghp_abc123')
    })
  })

  describe('scanForLeaks', () => {
    it('detects credential pattern in body', () => {
      const result = filter.scanForLeaks(GITHUB, 'token=ghp_abcdefghijklmnopqrstuvwxyz012345')
      expect(result.safe).toBe(false)
      expect(result.leaked.length).toBeGreaterThan(0)
    })

    it('passes clean body', () => {
      const result = filter.scanForLeaks(GITHUB, '{"message": "hello"}')
      expect(result.safe).toBe(true)
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/services/proxy/egress-filter.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/main/services/proxy/egress-filter.ts
/**
 * @module egress-filter
 * @description Domain matching, tier checking, credential injection, and
 * exfiltration detection for outbound proxy requests.
 */

import type { ServiceDefinition, DataTier } from '../../../types'

const TIER_LEVELS: Record<DataTier, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
}

export class EgressFilter {
  private services: ServiceDefinition[]
  /** Pre-compiled wildcard patterns: { regex, service } */
  private domainRules: Array<{ regex: RegExp; service: ServiceDefinition }>

  constructor(services: ServiceDefinition[]) {
    this.services = services
    this.domainRules = []
    for (const svc of services) {
      for (const domain of svc.injection.proxy.domains) {
        const pattern = domain.replace(/\./g, '\\.').replace(/\*/g, '[^.]+')
        this.domainRules.push({
          regex: new RegExp(`^${pattern}$`, 'i'),
          service: svc,
        })
      }
    }
  }

  /** Match a domain to a registered service. Returns null if no match. */
  matchService(domain: string): ServiceDefinition | null {
    const lower = domain.toLowerCase()
    for (const rule of this.domainRules) {
      if (rule.regex.test(lower)) return rule.service
    }
    return null
  }

  /** Check if a service's tier is accessible given the session's max tier. */
  checkTierAccess(serviceTier: DataTier, maxTier: DataTier): boolean {
    return TIER_LEVELS[serviceTier] <= TIER_LEVELS[maxTier]
  }

  /**
   * Build request headers with credential values injected.
   * Replaces ${credential.fieldName} placeholders in header templates.
   */
  injectHeaders(
    service: ServiceDefinition,
    credentials: Record<string, string>,
  ): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, template] of Object.entries(service.injection.proxy.headers)) {
      let value = template
      for (const [field, fieldValue] of Object.entries(credentials)) {
        value = value.replace(`\${credential.${field}}`, fieldValue)
      }
      result[key] = value
    }
    return result
  }

  /**
   * Scan a request body for leaked credential patterns.
   * Uses the service's redaction patterns to detect exfiltration attempts.
   */
  scanForLeaks(
    service: ServiceDefinition,
    body: string,
  ): { safe: boolean; leaked: string[] } {
    const leaked: string[] = []
    for (const pattern of service.dataTier.redaction.patterns) {
      try {
        const regex = new RegExp(pattern, 'g')
        const matches = body.match(regex)
        if (matches) leaked.push(...matches)
      } catch {
        // Invalid regex in service definition — skip
      }
    }
    return { safe: leaked.length === 0, leaked }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/services/proxy/egress-filter.test.ts`
Expected: PASS (all 7 tests)

**Step 5: Commit**

```bash
git add src/main/services/proxy/egress-filter.ts src/main/services/proxy/egress-filter.test.ts
git commit -m "feat(proxy): add EgressFilter with domain matching, tier checks, cred injection"
```

---

## Task 5: Token Map

**Files:**
- Create: `src/main/services/proxy/token-map.ts`
- Test: `src/main/services/proxy/token-map.test.ts`

**Step 1: Write the failing test**

```typescript
// src/main/services/proxy/token-map.test.ts
import { describe, it, expect } from 'vitest'
import { TokenMap } from './token-map'

describe('TokenMap', () => {
  it('tokenizes a value and returns a token id', () => {
    const map = new TokenMap()
    const entry = map.tokenize('user@corp.com', {
      service: 'github',
      tier: 'internal',
      endpoint: 'api.github.com/repos/foo/pulls',
    })
    expect(entry.id).toMatch(/^tok_[a-f0-9]{8}$/)
    expect(entry.value).toBe('user@corp.com')
    expect(entry.origin.service).toBe('github')
    expect(entry.validDestinations).toEqual(['github'])
  })

  it('resolves token for same-origin service', () => {
    const map = new TokenMap()
    const entry = map.tokenize('secret', {
      service: 'github',
      tier: 'internal',
      endpoint: 'api.github.com/user',
    })
    expect(map.resolve(entry.id, 'github')).toBe('secret')
  })

  it('blocks resolution for different service (same-origin policy)', () => {
    const map = new TokenMap()
    const entry = map.tokenize('secret', {
      service: 'github',
      tier: 'internal',
      endpoint: 'api.github.com/user',
    })
    expect(map.resolve(entry.id, 'slack')).toBeNull()
  })

  it('returns null for unknown token', () => {
    const map = new TokenMap()
    expect(map.resolve('tok_nonexist', 'github')).toBeNull()
  })

  it('replaces all occurrences in a string', () => {
    const map = new TokenMap()
    const body = '{"email": "user@corp.com", "backup": "user@corp.com"}'
    const result = map.tokenizeInString(body, 'user@corp.com', {
      service: 'github',
      tier: 'internal',
      endpoint: 'api.github.com/user',
    })
    expect(result).not.toContain('user@corp.com')
    expect(result).toMatch(/tok_[a-f0-9]{8}/)
  })

  it('de-tokenizes tokens in a string for allowed service', () => {
    const map = new TokenMap()
    const entry = map.tokenize('user@corp.com', {
      service: 'github',
      tier: 'internal',
      endpoint: 'api.github.com/user',
    })
    const input = `update user ${entry.id} please`
    const result = map.detokenizeString(input, 'github')
    expect(result).toBe('update user user@corp.com please')
  })

  it('leaves tokens untouched for disallowed service', () => {
    const map = new TokenMap()
    const entry = map.tokenize('user@corp.com', {
      service: 'github',
      tier: 'internal',
      endpoint: 'api.github.com/user',
    })
    const input = `send to ${entry.id}`
    const result = map.detokenizeString(input, 'slack')
    expect(result).toContain(entry.id) // not resolved
  })

  it('clear destroys all tokens', () => {
    const map = new TokenMap()
    const entry = map.tokenize('secret', {
      service: 'github',
      tier: 'internal',
      endpoint: 'api.github.com/user',
    })
    map.clear()
    expect(map.resolve(entry.id, 'github')).toBeNull()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/services/proxy/token-map.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/main/services/proxy/token-map.ts
/**
 * @module token-map
 * @description Per-session tokenization with same-origin enforcement.
 *
 * Tokens replace sensitive values in proxy responses. They carry origin
 * metadata (service, tier, endpoint) and can only be de-tokenized when
 * sent back to the originating service (same-origin policy).
 */

import { randomBytes } from 'node:crypto'
import type { TokenEntry, DataTier } from '../../../types'

const TOKEN_RE = /tok_[a-f0-9]{8}/g

export class TokenMap {
  private tokens = new Map<string, TokenEntry>()

  /** Create a token for a sensitive value. */
  tokenize(
    value: string,
    origin: { service: string; tier: DataTier; endpoint: string },
  ): TokenEntry {
    // Check if this exact value+service is already tokenized
    for (const entry of this.tokens.values()) {
      if (entry.value === value && entry.origin.service === origin.service) {
        return entry
      }
    }

    const id = `tok_${randomBytes(4).toString('hex')}`
    const entry: TokenEntry = {
      id,
      value,
      origin,
      validDestinations: [origin.service],
      createdAt: new Date().toISOString(),
    }
    this.tokens.set(id, entry)
    return entry
  }

  /** Resolve a token to its value IF the destination service is allowed. */
  resolve(tokenId: string, destService: string): string | null {
    const entry = this.tokens.get(tokenId)
    if (!entry) return null
    if (!entry.validDestinations.includes(destService)) return null
    return entry.value
  }

  /** Replace all occurrences of a value in a string with its token. */
  tokenizeInString(
    text: string,
    value: string,
    origin: { service: string; tier: DataTier; endpoint: string },
  ): string {
    if (!text.includes(value)) return text
    const entry = this.tokenize(value, origin)
    return text.replaceAll(value, entry.id)
  }

  /** Replace all tokens in a string with their real values (for allowed service only). */
  detokenizeString(text: string, destService: string): string {
    return text.replace(TOKEN_RE, (match) => {
      const resolved = this.resolve(match, destService)
      return resolved ?? match
    })
  }

  /** List all active tokens (for audit). */
  list(): TokenEntry[] {
    return Array.from(this.tokens.values())
  }

  /** Destroy all tokens (called on session end). */
  clear(): void {
    this.tokens.clear()
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/services/proxy/token-map.test.ts`
Expected: PASS (all 8 tests)

**Step 5: Commit**

```bash
git add src/main/services/proxy/token-map.ts src/main/services/proxy/token-map.test.ts
git commit -m "feat(proxy): add TokenMap with same-origin enforcement"
```

---

## Task 6: Latch Proxy

**Files:**
- Create: `src/main/services/latch-proxy.ts`
- Test: `src/main/services/latch-proxy.test.ts`

**Step 1: Write the failing test**

```typescript
// src/main/services/latch-proxy.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { LatchProxy } from './latch-proxy'
import type { ServiceDefinition, DataTier } from '../../types'

const MOCK_SERVICE: ServiceDefinition = {
  id: 'httpbin',
  name: 'HTTPBin',
  category: 'custom',
  protocol: 'http',
  credential: { type: 'token', fields: ['token'] },
  injection: {
    env: {},
    files: {},
    proxy: {
      domains: ['httpbin.org'],
      headers: { Authorization: 'Bearer ${credential.token}' },
    },
  },
  dataTier: { defaultTier: 'public', redaction: { patterns: [], fields: [] } },
  skill: { description: '', capabilities: [], constraints: [] },
}

describe('LatchProxy', () => {
  let proxy: LatchProxy

  beforeEach(async () => {
    proxy = new LatchProxy({
      sessionId: 'test-session',
      services: [MOCK_SERVICE],
      credentials: new Map([['httpbin', { token: 'test-token-123' }]]),
      maxDataTier: 'internal' as DataTier,
    })
  })

  afterEach(() => {
    proxy.stop()
  })

  it('starts on a random port', async () => {
    const port = await proxy.start()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65536)
  })

  it('blocks requests to unknown domains', async () => {
    const port = await proxy.start()
    const result = proxy.evaluateRequest('evil.com', 'GET', '/')
    expect(result.decision).toBe('deny')
    expect(result.reason).toContain('not an authorized service')
  })

  it('allows requests to registered service domains', () => {
    const result = proxy.evaluateRequest('httpbin.org', 'GET', '/get')
    expect(result.decision).toBe('allow')
    expect(result.service?.id).toBe('httpbin')
  })

  it('blocks services above max data tier', () => {
    const proxy2 = new LatchProxy({
      sessionId: 'test-session-2',
      services: [{
        ...MOCK_SERVICE,
        id: 'restricted-svc',
        dataTier: { defaultTier: 'restricted', redaction: { patterns: [], fields: [] } },
        injection: { ...MOCK_SERVICE.injection, proxy: { ...MOCK_SERVICE.injection.proxy, domains: ['restricted.com'] } },
      }],
      credentials: new Map(),
      maxDataTier: 'internal',
    })
    const result = proxy2.evaluateRequest('restricted.com', 'GET', '/')
    expect(result.decision).toBe('deny')
    expect(result.reason).toContain('tier')
    proxy2.stop()
  })

  it('records audit events', () => {
    proxy.evaluateRequest('httpbin.org', 'GET', '/get')
    proxy.evaluateRequest('evil.com', 'POST', '/exfil')
    const events = proxy.getAuditLog()
    expect(events).toHaveLength(2)
    expect(events[0].decision).toBe('allow')
    expect(events[1].decision).toBe('deny')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/services/latch-proxy.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/main/services/latch-proxy.ts
/**
 * @module latch-proxy
 * @description Per-session HTTP proxy with domain-based service gating,
 * credential injection, and audit logging.
 *
 * Phase 1 scope:
 * - Domain-level allow/deny based on registered services
 * - Credential injection via headers
 * - Audit logging of all requests
 * - No TLS interception (Phase 2)
 * - No response body scanning (Phase 2)
 */

import http from 'node:http'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { EgressFilter } from './proxy/egress-filter'
import { TokenMap } from './proxy/token-map'
import type { ServiceDefinition, DataTier, ProxyAuditEvent } from '../../types'

export interface LatchProxyConfig {
  sessionId: string
  services: ServiceDefinition[]
  credentials: Map<string, Record<string, string>>
  maxDataTier: DataTier
  onBlock?: (message: string) => void
}

export interface RequestEvaluation {
  decision: 'allow' | 'deny'
  service: ServiceDefinition | null
  reason: string | null
}

export class LatchProxy {
  private server: http.Server | null = null
  private port = 0
  private config: LatchProxyConfig
  private egressFilter: EgressFilter
  private tokenMap: TokenMap
  private auditLog: ProxyAuditEvent[] = []

  constructor(config: LatchProxyConfig) {
    this.config = config
    this.egressFilter = new EgressFilter(config.services)
    this.tokenMap = new TokenMap()
  }

  /** Start the proxy server. Returns the port number. */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handleRequest(req, res))
      this.server.on('connect', (req, socket, head) => this._handleConnect(req, socket, head))
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
          console.log(`[LatchProxy] Session ${this.config.sessionId} listening on 127.0.0.1:${this.port}`)
          resolve(this.port)
        } else {
          reject(new Error('Failed to bind proxy'))
        }
      })
      this.server.on('error', reject)
    })
  }

  /** Evaluate a request against policy (public for testing). */
  evaluateRequest(domain: string, method: string, path: string): RequestEvaluation {
    const service = this.egressFilter.matchService(domain)

    if (!service) {
      this._recordAudit(domain, method, path, null, 'deny', `${domain} is not an authorized service`)
      return { decision: 'deny', service: null, reason: `${domain} is not an authorized service` }
    }

    if (!this.egressFilter.checkTierAccess(service.dataTier.defaultTier, this.config.maxDataTier)) {
      const reason = `Service "${service.name}" tier (${service.dataTier.defaultTier}) exceeds session max tier (${this.config.maxDataTier})`
      this._recordAudit(domain, method, path, service.id, 'deny', reason)
      return { decision: 'deny', service, reason }
    }

    this._recordAudit(domain, method, path, service.id, 'allow', null)
    return { decision: 'allow', service, reason: null }
  }

  /** Get all audit events for this session. */
  getAuditLog(): ProxyAuditEvent[] {
    return [...this.auditLog]
  }

  /** Get the token map (for attestation). */
  getTokenMap(): TokenMap {
    return this.tokenMap
  }

  /** Stop the proxy and clean up. */
  stop(): void {
    this.tokenMap.clear()
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  /** Get the port number. */
  getPort(): number {
    return this.port
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /** Handle regular HTTP requests (non-CONNECT). */
  private _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const domain = url.hostname
    const evaluation = this.evaluateRequest(domain, req.method ?? 'GET', url.pathname)

    if (evaluation.decision === 'deny') {
      this.config.onBlock?.(`Request to ${domain} blocked — ${evaluation.reason}`)
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: evaluation.reason }))
      return
    }

    // Inject credentials
    const service = evaluation.service!
    const creds = this.config.credentials.get(service.id)
    if (creds) {
      const injected = this.egressFilter.injectHeaders(service, creds)
      for (const [k, v] of Object.entries(injected)) {
        req.headers[k.toLowerCase()] = v
      }
    }

    // Forward request
    const proxyReq = http.request(
      {
        hostname: domain,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: req.method,
        headers: req.headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers)
        proxyRes.pipe(res)
      },
    )
    proxyReq.on('error', (err) => {
      res.writeHead(502)
      res.end(`Proxy error: ${err.message}`)
    })
    req.pipe(proxyReq)
  }

  /** Handle HTTPS CONNECT tunneling. Phase 1: allow/deny at domain level only. */
  private _handleConnect(
    req: http.IncomingMessage,
    socket: net.Socket,
    _head: Buffer,
  ): void {
    const [host, portStr] = (req.url ?? '').split(':')
    const port = parseInt(portStr, 10) || 443
    const evaluation = this.evaluateRequest(host, 'CONNECT', '/')

    if (evaluation.decision === 'deny') {
      this.config.onBlock?.(`CONNECT to ${host} blocked — ${evaluation.reason}`)
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.end()
      return
    }

    // Phase 1: tunnel without TLS interception
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
  }

  private _recordAudit(
    domain: string,
    method: string,
    path: string,
    service: string | null,
    decision: 'allow' | 'deny',
    reason: string | null,
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
      contentType: null,
    })
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/services/latch-proxy.test.ts`
Expected: PASS (all 5 tests)

**Step 5: Commit**

```bash
git add src/main/services/latch-proxy.ts src/main/services/latch-proxy.test.ts
git commit -m "feat(proxy): add LatchProxy with domain gating, cred injection, and audit log"
```

---

## Task 7: Attestation Store

**Files:**
- Create: `src/main/stores/attestation-store.ts`
- Test: `src/main/stores/attestation-store.test.ts`

**Step 1: Write the failing test**

```typescript
// src/main/stores/attestation-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { AttestationStore } from './attestation-store'
import type { ProxyAuditEvent, SessionReceipt } from '../../types'

function makeEvent(overrides: Partial<ProxyAuditEvent> = {}): ProxyAuditEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    sessionId: 'session-1',
    service: 'github',
    domain: 'api.github.com',
    method: 'GET',
    path: '/repos/foo/bar',
    tier: 'internal',
    decision: 'allow',
    reason: null,
    contentType: 'application/json',
    ...overrides,
  }
}

describe('AttestationStore', () => {
  let store: AttestationStore

  beforeEach(() => {
    const db = new Database(':memory:')
    store = AttestationStore.open(db)
  })

  it('records and lists proxy audit events', () => {
    store.recordEvent(makeEvent())
    store.recordEvent(makeEvent({ decision: 'deny' }))
    const events = store.listEvents('session-1')
    expect(events).toHaveLength(2)
  })

  it('computes hash chain across events', () => {
    store.recordEvent(makeEvent())
    store.recordEvent(makeEvent())
    const chain = store.getHashChain('session-1')
    expect(chain).toBeTruthy()
    expect(chain!.length).toBe(64) // SHA-256 hex
  })

  it('hash chain changes when events differ', () => {
    store.recordEvent(makeEvent({ domain: 'a.com' }))
    const chain1 = store.getHashChain('session-1')

    const db2 = new Database(':memory:')
    const store2 = AttestationStore.open(db2)
    store2.recordEvent(makeEvent({ domain: 'b.com' }))
    const chain2 = store2.getHashChain('session-1')

    expect(chain1).not.toBe(chain2)
  })

  it('saves and retrieves a session receipt', () => {
    const receipt: SessionReceipt = {
      version: 1,
      sessionId: 'session-1',
      policy: { id: 'strict', hash: 'abc123', maxDataTier: 'internal', servicesGranted: ['github'] },
      activity: {
        servicesUsed: ['github'], networkRequests: 10, blockedRequests: 1,
        redactionsApplied: 0, tokenizationsApplied: 0,
        toolCalls: 5, toolDenials: 0, approvalEscalations: 0,
      },
      enclave: {
        sandboxType: 'docker', networkForced: true,
        startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
        exitReason: 'normal',
      },
      proof: { auditEventCount: 10, auditHashChain: 'abc', signature: 'sig', publicKey: 'pub' },
    }
    store.saveReceipt(receipt)
    const retrieved = store.getReceipt('session-1')
    expect(retrieved).toBeDefined()
    expect(retrieved!.policy.id).toBe('strict')
    expect(retrieved!.activity.networkRequests).toBe(10)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/stores/attestation-store.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/main/stores/attestation-store.ts
/**
 * @module attestation-store
 * @description Stores proxy audit events and session receipts.
 *
 * Audit events are hash-chained for tamper evidence. Session receipts
 * are signed JSON documents proving what policy was enforced.
 */

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { ProxyAuditEvent, SessionReceipt } from '../../types'

export class AttestationStore {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  static open(db: Database.Database): AttestationStore {
    const store = new AttestationStore(db)
    store._init()
    return store
  }

  private _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proxy_audit_log (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        event_json  TEXT NOT NULL,
        prev_hash   TEXT,
        hash        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_receipts (
        session_id  TEXT PRIMARY KEY,
        receipt_json TEXT NOT NULL,
        created_at  TEXT NOT NULL
      )
    `)
  }

  /** Record a proxy audit event with hash chaining. */
  recordEvent(event: ProxyAuditEvent): void {
    const prevRow = this.db.prepare(
      'SELECT hash FROM proxy_audit_log WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(event.sessionId) as { hash: string } | undefined
    const prevHash = prevRow?.hash ?? ''

    const eventJson = JSON.stringify(event)
    const hash = createHash('sha256').update(prevHash + eventJson).digest('hex')

    this.db.prepare(`
      INSERT INTO proxy_audit_log (id, session_id, event_json, prev_hash, hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(event.id, event.sessionId, eventJson, prevHash || null, hash, event.timestamp)
  }

  /** List audit events for a session. */
  listEvents(sessionId: string, limit?: number): ProxyAuditEvent[] {
    const sql = limit
      ? 'SELECT event_json FROM proxy_audit_log WHERE session_id = ? ORDER BY created_at ASC LIMIT ?'
      : 'SELECT event_json FROM proxy_audit_log WHERE session_id = ? ORDER BY created_at ASC'
    const rows = limit
      ? this.db.prepare(sql).all(sessionId, limit) as any[]
      : this.db.prepare(sql).all(sessionId) as any[]
    return rows.map(r => JSON.parse(r.event_json))
  }

  /** Get the final hash in the chain for a session (for receipt proof). */
  getHashChain(sessionId: string): string | null {
    const row = this.db.prepare(
      'SELECT hash FROM proxy_audit_log WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(sessionId) as { hash: string } | undefined
    return row?.hash ?? null
  }

  /** Get the count of audit events for a session. */
  getEventCount(sessionId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM proxy_audit_log WHERE session_id = ?'
    ).get(sessionId) as { count: number }
    return row.count
  }

  /** Save a signed session receipt. */
  saveReceipt(receipt: SessionReceipt): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO session_receipts (session_id, receipt_json, created_at)
      VALUES (?, ?, ?)
    `).run(receipt.sessionId, JSON.stringify(receipt), new Date().toISOString())
  }

  /** Get the session receipt for a session. */
  getReceipt(sessionId: string): SessionReceipt | null {
    const row = this.db.prepare(
      'SELECT receipt_json FROM session_receipts WHERE session_id = ?'
    ).get(sessionId) as { receipt_json: string } | undefined
    if (!row) return null
    return JSON.parse(row.receipt_json)
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/stores/attestation-store.test.ts`
Expected: PASS (all 4 tests)

**Step 5: Commit**

```bash
git add src/main/stores/attestation-store.ts src/main/stores/attestation-store.test.ts
git commit -m "feat(stores): add AttestationStore with hash-chained audit log and receipts"
```

---

## Task 8: Attestation Engine

**Files:**
- Create: `src/main/services/attestation.ts`
- Test: `src/main/services/attestation.test.ts`

**Step 1: Write the failing test**

```typescript
// src/main/services/attestation.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { AttestationEngine } from './attestation'
import { AttestationStore } from '../stores/attestation-store'
import type { PolicyDocument } from '../../types'

const MOCK_POLICY: PolicyDocument = {
  id: 'strict',
  name: 'Strict',
  description: 'Test policy',
  permissions: { allowBash: true, allowNetwork: false, allowFileWrite: true, confirmDestructive: true, blockedGlobs: [] },
  harnesses: {},
}

describe('AttestationEngine', () => {
  let engine: AttestationEngine
  let store: AttestationStore

  beforeEach(() => {
    const db = new Database(':memory:')
    store = AttestationStore.open(db)
    engine = new AttestationEngine(store)
  })

  it('generates a signed session receipt', () => {
    const receipt = engine.generateReceipt({
      sessionId: 'session-1',
      policy: MOCK_POLICY,
      maxDataTier: 'internal',
      servicesGranted: ['github'],
      servicesUsed: ['github'],
      activity: { requests: 10, blocked: 1, redactions: 0, tokenizations: 0 },
      sandboxType: 'docker',
      exitReason: 'normal',
      startTime: Date.now() - 60000,
      endTime: Date.now(),
    })

    expect(receipt.version).toBe(1)
    expect(receipt.sessionId).toBe('session-1')
    expect(receipt.policy.id).toBe('strict')
    expect(receipt.policy.hash).toBeTruthy()
    expect(receipt.proof.signature).toBeTruthy()
    expect(receipt.proof.publicKey).toBeTruthy()
  })

  it('saves receipt to store', () => {
    engine.generateReceipt({
      sessionId: 'session-1',
      policy: MOCK_POLICY,
      maxDataTier: 'internal',
      servicesGranted: [],
      servicesUsed: [],
      activity: { requests: 0, blocked: 0, redactions: 0, tokenizations: 0 },
      sandboxType: 'docker',
      exitReason: 'normal',
      startTime: Date.now(),
      endTime: Date.now(),
    })

    const retrieved = store.getReceipt('session-1')
    expect(retrieved).toBeDefined()
    expect(retrieved!.policy.id).toBe('strict')
  })

  it('signature is verifiable', () => {
    const receipt = engine.generateReceipt({
      sessionId: 'session-2',
      policy: MOCK_POLICY,
      maxDataTier: 'internal',
      servicesGranted: [],
      servicesUsed: [],
      activity: { requests: 0, blocked: 0, redactions: 0, tokenizations: 0 },
      sandboxType: 'docker',
      exitReason: 'normal',
      startTime: Date.now(),
      endTime: Date.now(),
    })

    const verified = engine.verifyReceipt(receipt)
    expect(verified).toBe(true)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/services/attestation.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/main/services/attestation.ts
/**
 * @module attestation
 * @description Generates signed session receipts for audit and compliance.
 *
 * Uses Ed25519 for signing. Keys are ephemeral per AttestationEngine instance
 * (typically per app lifecycle). Receipts are self-contained and verifiable.
 */

import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import type { AttestationStore } from '../stores/attestation-store'
import type { PolicyDocument, SessionReceipt, DataTier } from '../../types'

export interface ReceiptInput {
  sessionId: string
  policy: PolicyDocument
  maxDataTier: DataTier
  servicesGranted: string[]
  servicesUsed: string[]
  activity: {
    requests: number
    blocked: number
    redactions: number
    tokenizations: number
  }
  sandboxType: 'docker' | 'seatbelt' | 'bubblewrap'
  exitReason: 'normal' | 'timeout' | 'killed' | 'error'
  startTime: number
  endTime: number
}

export class AttestationEngine {
  private store: AttestationStore
  private privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
  private publicKeyPem: string

  constructor(store: AttestationStore) {
    this.store = store
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    this.privateKey = privateKey
    this.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
  }

  /** Generate a signed session receipt and save it to the store. */
  generateReceipt(input: ReceiptInput): SessionReceipt {
    const policyHash = createHash('sha256')
      .update(JSON.stringify(input.policy))
      .digest('hex')

    const auditHashChain = this.store.getHashChain(input.sessionId) ?? ''
    const auditEventCount = this.store.getEventCount(input.sessionId)

    const receipt: SessionReceipt = {
      version: 1,
      sessionId: input.sessionId,
      policy: {
        id: input.policy.id,
        hash: policyHash,
        maxDataTier: input.maxDataTier,
        servicesGranted: input.servicesGranted,
      },
      activity: {
        servicesUsed: input.servicesUsed,
        networkRequests: input.activity.requests,
        blockedRequests: input.activity.blocked,
        redactionsApplied: input.activity.redactions,
        tokenizationsApplied: input.activity.tokenizations,
        toolCalls: 0,
        toolDenials: 0,
        approvalEscalations: 0,
      },
      enclave: {
        sandboxType: input.sandboxType,
        networkForced: true,
        startedAt: new Date(input.startTime).toISOString(),
        endedAt: new Date(input.endTime).toISOString(),
        exitReason: input.exitReason,
      },
      proof: {
        auditEventCount,
        auditHashChain,
        signature: '',
        publicKey: this.publicKeyPem,
      },
    }

    // Sign the receipt (excluding the signature field itself)
    const payload = JSON.stringify({ ...receipt, proof: { ...receipt.proof, signature: '' } })
    receipt.proof.signature = sign(null, Buffer.from(payload), this.privateKey).toString('base64')

    this.store.saveReceipt(receipt)
    return receipt
  }

  /** Verify a receipt's signature. */
  verifyReceipt(receipt: SessionReceipt): boolean {
    try {
      const payload = JSON.stringify({ ...receipt, proof: { ...receipt.proof, signature: '' } })
      const { createPublicKey } = require('node:crypto')
      const pubKey = createPublicKey(receipt.proof.publicKey)
      return verify(null, Buffer.from(payload), pubKey, Buffer.from(receipt.proof.signature, 'base64'))
    } catch {
      return false
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/services/attestation.test.ts`
Expected: PASS (all 3 tests)

**Step 5: Commit**

```bash
git add src/main/services/attestation.ts src/main/services/attestation.test.ts
git commit -m "feat(attestation): add AttestationEngine with Ed25519 signed receipts"
```

---

## Task 9: Skill Generator

**Files:**
- Create: `src/main/services/skill-generator.ts`
- Test: `src/main/services/skill-generator.test.ts`

**Step 1: Write the failing test**

```typescript
// src/main/services/skill-generator.test.ts
import { describe, it, expect } from 'vitest'
import { SkillGenerator } from './skill-generator'
import type { ServiceDefinition } from '../../types'

const GITHUB: ServiceDefinition = {
  id: 'github',
  name: 'GitHub',
  category: 'vcs',
  protocol: 'http',
  credential: { type: 'token', fields: ['token'] },
  injection: { env: {}, files: {}, proxy: { domains: ['api.github.com'], headers: {} } },
  dataTier: { defaultTier: 'internal', redaction: { patterns: [], fields: [] } },
  skill: {
    description: 'GitHub access via gh CLI.',
    capabilities: ['gh pr create', 'git push'],
    constraints: ['Never print tokens'],
  },
}

describe('SkillGenerator', () => {
  const gen = new SkillGenerator()

  it('generates enclave meta skill', () => {
    const content = gen.generateEnclaveMeta([GITHUB])
    expect(content).toContain('Latch Enclave')
    expect(content).toContain('GitHub')
    expect(content).toContain('Do not bypass network restrictions')
  })

  it('generates service skill', () => {
    const content = gen.generateServiceSkill(GITHUB)
    expect(content).toContain('GitHub')
    expect(content).toContain('gh pr create')
    expect(content).toContain('Never print tokens')
    expect(content).toContain('do NOT ask for tokens')
  })

  it('enclave meta lists all services', () => {
    const svc2: ServiceDefinition = { ...GITHUB, id: 'npm', name: 'npm', skill: { ...GITHUB.skill, description: 'npm access.' } }
    const content = gen.generateEnclaveMeta([GITHUB, svc2])
    expect(content).toContain('GitHub')
    expect(content).toContain('npm')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/services/skill-generator.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/main/services/skill-generator.ts
/**
 * @module skill-generator
 * @description Auto-generates enclave and service skill files for agent awareness.
 *
 * Skills are injected into the harness discovery path so agents know:
 * - They're running in an enclave
 * - What services are available
 * - How to use each service
 * - What NOT to do (constraints)
 */

import type { ServiceDefinition } from '../../types'

export class SkillGenerator {
  /** Generate the enclave meta-skill (injected into every enclave session). */
  generateEnclaveMeta(services: ServiceDefinition[]): string {
    const serviceList = services
      .map(s => `- **${s.name}**: ${s.skill.description}`)
      .join('\n')

    return `# Latch Enclave

You are running inside a Latch security enclave.

## What's Different
- All network traffic is monitored and policy-enforced
- Credentials are injected automatically — never ask for them
- Sensitive data in responses may be tokenized (e.g., \`tok_a3f8b2\`)
  — reference tokens naturally, they resolve transparently
- Your filesystem access is scoped to this workspace

## Available Services
${serviceList || '- No services configured for this session'}

## Rules
- Do not bypass network restrictions
- Do not exfiltrate credentials from environment variables
- If a request is blocked, respect the policy — do not retry or work around it
- Use tokenized values naturally — they resolve transparently
- Never attempt to read /proc/self/environ or similar credential sources
`
  }

  /** Generate a service-specific skill file. */
  generateServiceSkill(service: ServiceDefinition): string {
    const capabilities = service.skill.capabilities
      .map(c => `- \`${c}\``)
      .join('\n')

    const constraints = service.skill.constraints
      .map(c => `- ${c}`)
      .join('\n')

    return `# Service: ${service.name} (auto-generated by Latch)

## Available Capabilities
You have authenticated access to ${service.name}.
Authentication is handled automatically — do NOT ask for tokens or credentials.

## How To Use
${capabilities || '- Use standard CLI tools for this service'}

## Constraints
${constraints || '- Follow standard security practices'}
- Do not modify authentication configuration files — managed by Latch
- If you get a 401 error, report it — do not attempt to fix auth yourself
`
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/services/skill-generator.test.ts`
Expected: PASS (all 3 tests)

**Step 5: Commit**

```bash
git add src/main/services/skill-generator.ts src/main/services/skill-generator.test.ts
git commit -m "feat(skills): add SkillGenerator for enclave and service awareness"
```

---

## Task 10: Enclave Manager

**Files:**
- Create: `src/main/lib/enclave-manager.ts`
- Test: `src/main/lib/enclave-manager.test.ts`

**Step 1: Write the failing test**

```typescript
// src/main/lib/enclave-manager.test.ts
import { describe, it, expect } from 'vitest'
import { EnclaveManager } from './enclave-manager'
import type { ServiceDefinition } from '../../types'

const GITHUB: ServiceDefinition = {
  id: 'github',
  name: 'GitHub',
  category: 'vcs',
  protocol: 'http',
  credential: { type: 'token', fields: ['token'] },
  injection: {
    env: { GH_TOKEN: '${credential.token}' },
    files: {},
    proxy: { domains: ['api.github.com'], headers: {} },
  },
  dataTier: { defaultTier: 'internal', redaction: { patterns: [], fields: [] } },
  skill: { description: '', capabilities: [], constraints: [] },
}

describe('EnclaveManager', () => {
  it('builds enclave environment with proxy vars', () => {
    const env = EnclaveManager.buildEnclaveEnv({
      proxyPort: 9801,
      authzPort: 9901,
      sessionId: 'session-1',
      services: [GITHUB],
      credentials: new Map([['github', { token: 'ghp_secret' }]]),
    })

    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:9801')
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:9801')
    expect(env.NO_PROXY).toBe('')
    expect(env.LATCH_ENCLAVE).toBe('true')
    expect(env.LATCH_SESSION_ID).toBe('session-1')
    expect(env.GH_TOKEN).toBe('ghp_secret')
    expect(env.HISTFILE).toBe('/dev/null')
  })

  it('resolves credential placeholders in env vars', () => {
    const env = EnclaveManager.buildEnclaveEnv({
      proxyPort: 9801,
      authzPort: 9901,
      sessionId: 'session-1',
      services: [GITHUB],
      credentials: new Map([['github', { token: 'ghp_test123' }]]),
    })
    expect(env.GH_TOKEN).toBe('ghp_test123')
  })

  it('includes all services env vars', () => {
    const svc2: ServiceDefinition = {
      ...GITHUB,
      id: 'npm',
      injection: { env: { NPM_TOKEN: '${credential.token}' }, files: {}, proxy: { domains: [], headers: {} } },
    }
    const env = EnclaveManager.buildEnclaveEnv({
      proxyPort: 9801,
      authzPort: 9901,
      sessionId: 'session-1',
      services: [GITHUB, svc2],
      credentials: new Map([
        ['github', { token: 'ghp_abc' }],
        ['npm', { token: 'npm_xyz' }],
      ]),
    })
    expect(env.GH_TOKEN).toBe('ghp_abc')
    expect(env.NPM_TOKEN).toBe('npm_xyz')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/lib/enclave-manager.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/main/lib/enclave-manager.ts
/**
 * @module enclave-manager
 * @description Manages sandbox lifecycle for enclave sessions.
 *
 * Phase 1: Docker backend only. Seatbelt (macOS) and bubblewrap (Linux) are Phase 3.
 * No sandbox = no session — the enclave is mandatory.
 */

import type { ServiceDefinition } from '../../types'

export interface EnclaveEnvInput {
  proxyPort: number
  authzPort: number
  sessionId: string
  services: ServiceDefinition[]
  credentials: Map<string, Record<string, string>>
}

export type SandboxBackend = 'docker' | 'seatbelt' | 'bubblewrap'

export class EnclaveManager {
  /**
   * Build the environment variables for an enclave session.
   * Includes proxy vars, service-specific env, and Latch metadata.
   */
  static buildEnclaveEnv(input: EnclaveEnvInput): Record<string, string> {
    const env: Record<string, string> = {
      // Proxy routing — all traffic through Latch proxy
      HTTP_PROXY: `http://127.0.0.1:${input.proxyPort}`,
      HTTPS_PROXY: `http://127.0.0.1:${input.proxyPort}`,
      http_proxy: `http://127.0.0.1:${input.proxyPort}`,
      https_proxy: `http://127.0.0.1:${input.proxyPort}`,
      NO_PROXY: '',

      // Latch metadata
      LATCH_ENCLAVE: 'true',
      LATCH_SESSION_ID: input.sessionId,

      // Security hardening
      HISTFILE: '/dev/null',
    }

    // Inject service-specific env vars with credential substitution
    for (const service of input.services) {
      const creds = input.credentials.get(service.id) ?? {}
      for (const [envKey, template] of Object.entries(service.injection.env)) {
        let value = template
        for (const [field, fieldValue] of Object.entries(creds)) {
          value = value.replace(`\${credential.${field}}`, fieldValue)
        }
        // Only set if all placeholders were resolved
        if (!value.includes('${credential.')) {
          env[envKey] = value
        }
      }
    }

    return env
  }

  /**
   * Detect which sandbox backend is available.
   * Phase 1: Docker only.
   */
  static async detectBackend(): Promise<SandboxBackend | null> {
    // Check Docker availability
    try {
      const { execSync } = await import('node:child_process')
      execSync('docker info', { stdio: 'ignore', timeout: 5000 })
      return 'docker'
    } catch {
      // Docker not available
    }

    // Phase 3: check seatbelt (macOS) and bubblewrap (Linux)
    return null
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/lib/enclave-manager.test.ts`
Expected: PASS (all 3 tests)

**Step 5: Commit**

```bash
git add src/main/lib/enclave-manager.ts src/main/lib/enclave-manager.test.ts
git commit -m "feat(enclave): add EnclaveManager with env building and backend detection"
```

---

## Task 11: IPC Handlers

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

**Step 1: Add store initialization and IPC handlers to `src/main/index.ts`**

At the top of the file, add imports:
```typescript
import { ServiceStore } from './stores/service-store'
import { AttestationStore } from './stores/attestation-store'
import { SERVICE_CATALOG, getCatalogService } from './lib/service-catalog'
```

In `app.whenReady()`, after existing store initialization, add:
```typescript
const serviceStore = ServiceStore.open(db)
const attestationStore = AttestationStore.open(db)
```

Add IPC handlers after existing handlers:
```typescript
// ── Services (enclave) ────────────────────────────────────────────────────
ipcMain.handle('latch:service-list', async () => {
  return serviceStore.list()
})

ipcMain.handle('latch:service-get', async (_event, { id }: { id: string }) => {
  return serviceStore.get(id)
})

ipcMain.handle('latch:service-save', async (_event, payload: { definition: any; credentialValue?: string }) => {
  const result = serviceStore.save(payload.definition)
  if (result.ok && payload.credentialValue) {
    // Store credential in SecretStore with service-scoped key
    const secretKey = `service:${payload.definition.id}`
    secretStore.save({
      id: `svc-${payload.definition.id}`,
      name: `${payload.definition.name} credential`,
      key: secretKey,
      value: payload.credentialValue,
      description: `Auto-managed credential for ${payload.definition.name} service`,
      scope: 'global',
      tags: ['service', payload.definition.id],
    })
    serviceStore.markCredentialStored(payload.definition.id)
  }
  return result
})

ipcMain.handle('latch:service-delete', async (_event, { id }: { id: string }) => {
  secretStore.delete(`svc-${id}`)
  return serviceStore.delete(id)
})

ipcMain.handle('latch:service-catalog', async () => {
  return { ok: true, catalog: SERVICE_CATALOG }
})

// ── Attestation ──────────────────────────────────────────────────────────
ipcMain.handle('latch:attestation-get', async (_event, { sessionId }: { sessionId: string }) => {
  const receipt = attestationStore.getReceipt(sessionId)
  if (!receipt) return { ok: false, error: 'No attestation receipt for this session' }
  return { ok: true, receipt }
})

ipcMain.handle('latch:attestation-audit-log', async (_event, { sessionId, limit }: { sessionId: string; limit?: number }) => {
  return { ok: true, events: attestationStore.listEvents(sessionId, limit) }
})
```

**Step 2: Add preload API methods to `src/preload/index.ts`**

Add after the Secrets section, before Feed section:
```typescript
// Services (enclave)
listServices: () => ipcRenderer.invoke('latch:service-list'),
getService: (payload: { id: string }) => ipcRenderer.invoke('latch:service-get', payload),
saveService: (payload: { definition: any; credentialValue?: string }) => ipcRenderer.invoke('latch:service-save', payload),
deleteService: (payload: { id: string }) => ipcRenderer.invoke('latch:service-delete', payload),
getServiceCatalog: () => ipcRenderer.invoke('latch:service-catalog'),

// Attestation
getAttestation: (payload: { sessionId: string }) => ipcRenderer.invoke('latch:attestation-get', payload),
listProxyAudit: (payload: { sessionId: string; limit?: number }) => ipcRenderer.invoke('latch:attestation-audit-log', payload),
```

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/main/index.ts src/preload/index.ts
git commit -m "feat(ipc): add service and attestation IPC handlers"
```

---

## Task 12: Zustand Store Integration

**Files:**
- Modify: `src/renderer/store/useAppStore.ts`

**Step 1: Add service state and actions to the store**

Add to the state interface:
```typescript
services: ServiceRecord[]
serviceCatalog: ServiceDefinition[]
servicesLoaded: boolean
```

Add initial values in create():
```typescript
services: [],
serviceCatalog: [],
servicesLoaded: false,
```

Add actions:
```typescript
loadServices: async () => {
  const [listResult, catalogResult] = await Promise.all([
    window.latch.listServices(),
    window.latch.getServiceCatalog(),
  ])
  set({
    services: listResult.ok ? listResult.services : [],
    serviceCatalog: catalogResult.ok ? catalogResult.catalog : [],
    servicesLoaded: true,
  })
},

saveService: async (definition: ServiceDefinition, credentialValue?: string) => {
  const result = await window.latch.saveService({ definition, credentialValue })
  if (result.ok) get().loadServices()
  return result
},

deleteService: async (id: string) => {
  const result = await window.latch.deleteService({ id })
  if (result.ok) get().loadServices()
  return result
},
```

**Step 2: Call `loadServices` in the app initialization**

In `App.tsx`, add `loadServices()` to the initial data load (alongside existing `loadPolicies`, `loadSkills`, etc.):

```typescript
store.loadServices()
```

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/store/useAppStore.ts src/renderer/App.tsx
git commit -m "feat(renderer): add services state and actions to Zustand store"
```

---

## Task 13: Services Rail Panel (Minimal)

**Files:**
- Create: `src/renderer/components/panels/ServicesPanel.tsx`
- Modify: `src/renderer/components/Rail.tsx`
- Modify: `src/renderer/styles.css`

**Step 1: Create ServicesPanel component**

```tsx
// src/renderer/components/panels/ServicesPanel.tsx
import { useAppStore } from '../../store/useAppStore'

export default function ServicesPanel() {
  const services = useAppStore(s => s.services)
  const serviceCatalog = useAppStore(s => s.serviceCatalog)
  const servicesLoaded = useAppStore(s => s.servicesLoaded)

  if (!servicesLoaded) return <div className="panel-empty">Loading services...</div>

  return (
    <div className="services-panel">
      <div className="panel-header">
        <h3>Services</h3>
      </div>

      {services.length === 0 ? (
        <div className="panel-empty">
          <p>No services configured.</p>
          <p className="text-muted">Services provide authenticated access to external tools (GitHub, AWS, npm, etc.) without exposing credentials to agents.</p>
        </div>
      ) : (
        <div className="services-list">
          {services.map(svc => (
            <div key={svc.id} className="service-item">
              <div className="service-item-header">
                <span className="service-name">{svc.name}</span>
                <span className={`service-badge ${svc.hasCredential ? 'badge-ok' : 'badge-warn'}`}>
                  {svc.hasCredential ? 'configured' : 'no credential'}
                </span>
              </div>
              <div className="service-item-meta">
                <span className="text-muted">{svc.category} · {svc.definition.dataTier.defaultTier}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {serviceCatalog.length > 0 && (
        <div className="panel-section">
          <h4>Available Services</h4>
          <div className="catalog-list">
            {serviceCatalog
              .filter(cat => !services.some(s => s.definitionId === cat.id))
              .map(cat => (
                <div key={cat.id} className="catalog-item">
                  <span className="service-name">{cat.name}</span>
                  <span className="text-muted">{cat.category}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
```

**Step 2: Register in Rail.tsx**

Import the panel and add a conditional render for `'services'` panel ID. Add the rail tab button with a shield or lock icon.

**Step 3: Add styles to `src/renderer/styles.css`**

```css
/* ── Services Panel ────────────────────────────────── */
.services-panel { padding: 12px; }
.services-list { display: flex; flex-direction: column; gap: 8px; }
.service-item {
  background: var(--bg-elevated);
  border-radius: 6px;
  padding: 10px 12px;
}
.service-item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.service-name { font-weight: 500; }
.service-badge {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
}
.badge-ok { background: var(--green-dim); color: var(--green); }
.badge-warn { background: var(--yellow-dim); color: var(--yellow); }
.service-item-meta { margin-top: 4px; font-size: 12px; }
.catalog-list { display: flex; flex-direction: column; gap: 4px; }
.catalog-item {
  display: flex;
  justify-content: space-between;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.catalog-item:hover { background: var(--bg-elevated); }
```

**Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/components/panels/ServicesPanel.tsx src/renderer/components/Rail.tsx src/renderer/styles.css
git commit -m "feat(ui): add Services rail panel with catalog listing"
```

---

## Task 14: Run Full Test Suite

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All new tests pass alongside existing tests

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix: resolve any test/typecheck issues from Phase 1"
```

---

## Implementation Order & Dependencies

```
Task 1: Types ──────────────────────────┐
                                         │
Task 2: ServiceStore ◄──────────────────┤
Task 3: ServiceCatalog ◄───────────────┤
Task 7: AttestationStore ◄─────────────┤
                                         │
Task 4: EgressFilter ◄─────────────────┤
Task 5: TokenMap ◄──────────────────────┤
                                         │
Task 6: LatchProxy ◄── (4, 5) ─────────┤
Task 8: AttestationEngine ◄── (7) ─────┤
Task 9: SkillGenerator ◄───────────────┤
Task 10: EnclaveManager ◄──────────────┤
                                         │
Task 11: IPC Handlers ◄── (2, 3, 7) ───┤
Task 12: Zustand Store ◄── (11) ────────┤
Task 13: ServicesPanel ◄── (12) ────────┤
                                         │
Task 14: Full Test Suite ◄── (all) ─────┘
```

Tasks 2, 3, 4, 5, 7, 8, 9, 10 can be parallelized (they only depend on Task 1).
Tasks 11-13 are sequential (IPC → store → UI).

---

## Files Created (14 new)

```
src/main/stores/service-store.ts
src/main/stores/service-store.test.ts
src/main/stores/attestation-store.ts
src/main/stores/attestation-store.test.ts
src/main/lib/service-catalog.ts
src/main/lib/service-catalog.test.ts
src/main/lib/enclave-manager.ts
src/main/lib/enclave-manager.test.ts
src/main/services/proxy/egress-filter.ts
src/main/services/proxy/egress-filter.test.ts
src/main/services/proxy/token-map.ts
src/main/services/proxy/token-map.test.ts
src/main/services/latch-proxy.ts
src/main/services/latch-proxy.test.ts
src/main/services/attestation.ts
src/main/services/attestation.test.ts
src/main/services/skill-generator.ts
src/main/services/skill-generator.test.ts
src/renderer/components/panels/ServicesPanel.tsx
```

## Files Modified (5)

```
src/types/index.ts
src/main/index.ts
src/preload/index.ts
src/renderer/store/useAppStore.ts
src/renderer/components/Rail.tsx
src/renderer/styles.css
```
