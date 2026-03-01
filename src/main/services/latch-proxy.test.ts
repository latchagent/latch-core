import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import { LatchProxy } from './latch-proxy'
import { TlsInterceptor } from './proxy/tls-interceptor'
import type { ServiceDefinition, DataTier, ProxyAuditEvent } from '../../types'

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

  it('calls onFeedback when a request is blocked via HTTP', async () => {
    const feedback: any[] = []
    const proxy2 = new LatchProxy({
      sessionId: 'test-feedback',
      services: [MOCK_SERVICE],
      credentials: new Map(),
      maxDataTier: 'internal',
      onFeedback: (msg) => feedback.push(msg),
    })
    const port = await proxy2.start()

    // Send an HTTP request to an unauthorized domain through the proxy
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: 'http://evil.com/exfil' },
        resolve,
      )
      req.on('error', reject)
    })
    // Drain the response body
    await new Promise<void>((resolve) => { res.resume(); res.on('end', resolve) })

    expect(feedback).toHaveLength(1)
    expect(feedback[0].type).toBe('block')
    expect(feedback[0].domain).toBe('evil.com')
    proxy2.stop()
  })

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

  it('detects credential leaks in outbound request bodies', () => {
    const leakService: ServiceDefinition = {
      ...MOCK_SERVICE,
      dataTier: {
        defaultTier: 'public',
        redaction: {
          patterns: ['secret-api-key-\\w+'],
          fields: [],
        },
      },
    }
    const creds = new Map([['httpbin', { token: 'secret-api-key-12345' }]])
    const proxy2 = new LatchProxy({
      sessionId: 'test-session',
      services: [leakService],
      credentials: creds,
      maxDataTier: 'internal' as DataTier,
    })

    // The proxy's egress filter should detect 'secret-api-key-12345' in an outbound body
    const result = proxy2['egressFilter'].scanForLeaks(leakService, 'sending secret-api-key-12345 in body')
    expect(result.safe).toBe(false)
    expect(result.leaked).toContain('secret-api-key-12345')
    proxy2.stop()
  })

  it('blocks request when path scope is violated', async () => {
    const scopedService = {
      ...MOCK_SERVICE,
      injection: {
        ...MOCK_SERVICE.injection,
        proxy: {
          ...MOCK_SERVICE.injection.proxy,
          pathRules: [
            { methods: ['DELETE'], paths: ['/repos/**'], decision: 'deny' as const },
          ],
        },
      },
    }

    const proxy2 = new LatchProxy({
      sessionId: 'test-session',
      services: [scopedService],
      credentials: new Map(),
      maxDataTier: 'internal' as const,
    })
    await proxy2.start()

    // GET should still be allowed
    const allow = proxy2.evaluateRequest(MOCK_SERVICE.injection.proxy.domains[0], 'GET', '/repos/foo')
    expect(allow.decision).toBe('allow')

    // DELETE should be blocked
    const deny = proxy2.evaluateRequest(MOCK_SERVICE.injection.proxy.domains[0], 'DELETE', '/repos/foo')
    expect(deny.decision).toBe('deny')
    expect(deny.reason).toContain('denied by path rule')

    proxy2.stop()
  })

  it('persists audit events to AttestationStore when provided', () => {
    const recorded: ProxyAuditEvent[] = []
    const mockStore = { recordEvent: vi.fn((e: ProxyAuditEvent) => recorded.push(e)) }

    const proxy2 = new LatchProxy({
      sessionId: 'test-persist',
      services: [MOCK_SERVICE],
      credentials: new Map(),
      maxDataTier: 'internal' as DataTier,
      attestationStore: mockStore as any,
    })

    proxy2.evaluateRequest('httpbin.org', 'GET', '/get')
    proxy2.evaluateRequest('evil.com', 'POST', '/exfil')

    expect(mockStore.recordEvent).toHaveBeenCalledTimes(2)
    expect(recorded[0].decision).toBe('allow')
    expect(recorded[0].domain).toBe('httpbin.org')
    expect(recorded[1].decision).toBe('deny')
    expect(recorded[1].domain).toBe('evil.com')
    proxy2.stop()
  })

  // -- H9: Ring buffer cap ──────────────────────────────────────────────────

  it('caps in-memory audit log at 1000 entries', () => {
    const proxy2 = new LatchProxy({
      sessionId: 'test-cap',
      services: [MOCK_SERVICE],
      credentials: new Map(),
      maxDataTier: 'internal' as DataTier,
    })

    // Generate 1050 audit events
    for (let i = 0; i < 1050; i++) {
      proxy2.evaluateRequest('httpbin.org', 'GET', `/path-${i}`)
    }

    const events = proxy2.getAuditLog()
    expect(events.length).toBe(1000)
    // Oldest entries should have been dropped — first event should be path-50
    expect(events[0].path).toBe('/path-50')
    expect(events[999].path).toBe('/path-1049')
    proxy2.stop()
  })

  it('delegates getAuditLog to attestation store when provided', () => {
    const storeEvents: ProxyAuditEvent[] = [
      { id: 'e1', timestamp: '', sessionId: 'test', service: null, domain: 'a.com', method: 'GET', path: '/', tier: null, decision: 'allow', reason: null, contentType: null, tlsInspected: false, redactionsApplied: 0, tokenizationsApplied: 0 },
    ]
    const mockStore = {
      recordEvent: vi.fn(),
      listEvents: vi.fn(() => storeEvents),
    }

    const proxy2 = new LatchProxy({
      sessionId: 'test-delegate',
      services: [MOCK_SERVICE],
      credentials: new Map(),
      maxDataTier: 'internal' as DataTier,
      attestationStore: mockStore as any,
    })

    const events = proxy2.getAuditLog()
    expect(mockStore.listEvents).toHaveBeenCalledWith('test-delegate')
    expect(events).toEqual(storeEvents)
    proxy2.stop()
  })

  // -- M4: CONNECT port restriction ────────────────────────────────────────

  it('blocks CONNECT to non-443 ports', async () => {
    const feedback: any[] = []
    const proxy2 = new LatchProxy({
      sessionId: 'test-port',
      services: [MOCK_SERVICE],
      credentials: new Map(),
      maxDataTier: 'internal' as DataTier,
      onFeedback: (msg) => feedback.push(msg),
    })
    const port = await proxy2.start()

    // Attempt a CONNECT to port 8080
    await new Promise<void>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        method: 'CONNECT',
        path: 'httpbin.org:8080',
      })
      req.on('connect', (res) => {
        expect(res.statusCode).toBe(403)
        res.socket?.destroy()
        resolve()
      })
      req.on('error', () => resolve())
      req.end()
    })

    expect(feedback.some(f => f.detail.includes('port 8080 not allowed'))).toBe(true)
    proxy2.stop()
  })

  // -- M2: Block credential injection over HTTP ───────────────────────────

  it('blocks credential injection over plaintext HTTP', async () => {
    const feedback: any[] = []
    const proxy2 = new LatchProxy({
      sessionId: 'test-http-creds',
      services: [MOCK_SERVICE],
      credentials: new Map([['httpbin', { token: 'secret' }]]),
      maxDataTier: 'internal' as DataTier,
      onFeedback: (msg) => feedback.push(msg),
    })
    const port = await proxy2.start()

    const res = await new Promise<http.IncomingMessage>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        method: 'GET',
        path: 'http://httpbin.org/get',
        headers: { Host: 'httpbin.org' },
      }, resolve)
      req.end()
    })

    expect(res.statusCode).toBe(403)
    const body = await new Promise<string>((resolve) => {
      let data = ''
      res.on('data', (chunk: Buffer) => { data += chunk.toString() })
      res.on('end', () => resolve(data))
    })
    expect(body).toContain('Credential injection requires HTTPS')
    expect(feedback.some(f => f.detail.includes('plaintext HTTP'))).toBe(true)
    proxy2.stop()
  })

  // -- M5: Generic error messages ─────────────────────────────────────────

  it('returns generic error messages without internal details', async () => {
    const proxy2 = new LatchProxy({
      sessionId: 'test-generic-error',
      services: [{
        ...MOCK_SERVICE,
        injection: {
          ...MOCK_SERVICE.injection,
          proxy: { ...MOCK_SERVICE.injection.proxy, domains: ['nonexistent.invalid'] },
        },
      }],
      credentials: new Map(),
      maxDataTier: 'internal' as DataTier,
    })
    const port = await proxy2.start()

    const res = await new Promise<http.IncomingMessage>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        method: 'GET',
        path: 'http://nonexistent.invalid/test',
        headers: { Host: 'nonexistent.invalid' },
      }, resolve)
      req.end()
    })

    // Should get 502 with generic message
    expect(res.statusCode).toBe(502)
    const body = await new Promise<string>((resolve) => {
      let data = ''
      res.on('data', (chunk: Buffer) => { data += chunk.toString() })
      res.on('end', () => resolve(data))
    })
    expect(body).toBe('Bad Gateway')
    expect(body).not.toContain('ENOTFOUND')
    expect(body).not.toContain('getaddrinfo')
    proxy2.stop()
  })
})
