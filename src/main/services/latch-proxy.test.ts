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
