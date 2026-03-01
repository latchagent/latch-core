import { describe, it, expect } from 'vitest'
import { GatewayManager } from './gateway-manager'
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

describe('GatewayManager', () => {
  it('builds gateway environment with proxy vars', () => {
    const env = GatewayManager.buildGatewayEnv({
      proxyPort: 9801,
      authzPort: 9901,
      sessionId: 'session-1',
      services: [GITHUB],
      credentials: new Map([['github', { token: 'ghp_secret' }]]),
    })

    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:9801')
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:9801')
    expect(env.NO_PROXY).toBe('')
    expect(env.LATCH_GATEWAY).toBe('true')
    expect(env.LATCH_SESSION_ID).toBe('session-1')
    expect(env.GH_TOKEN).toBe('ghp_secret')
    expect(env.HISTFILE).toBe('/dev/null')
  })

  it('resolves credential placeholders in env vars', () => {
    const env = GatewayManager.buildGatewayEnv({
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
    const env = GatewayManager.buildGatewayEnv({
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

  it('injects CA cert env vars when caCertPath is provided', () => {
    const env = GatewayManager.buildGatewayEnv({
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
    const env = GatewayManager.buildGatewayEnv({
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

  it('detectBackend returns a SandboxBackend or null', async () => {
    const result = await GatewayManager.detectBackend()
    // Result depends on the test environment
    if (result !== null) {
      expect(['docker', 'seatbelt', 'bubblewrap']).toContain(result)
    } else {
      expect(result).toBeNull()
    }
  })
})
