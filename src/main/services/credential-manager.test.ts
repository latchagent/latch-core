import { describe, it, expect, vi, afterEach } from 'vitest'
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
  afterEach(() => {
    vi.restoreAllMocks()
  })

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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))

    const result = await mgr.validateCredential(mockService, { token: 'test-token' })
    expect(result.valid).toBe(true)
  })

  it('detects invalid credential via 401', async () => {
    const mgr = new CredentialManager()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }))

    const result = await mgr.validateCredential(mockService, { token: 'bad-token' })
    expect(result.valid).toBe(false)
    expect(result.status).toBe(401)
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
