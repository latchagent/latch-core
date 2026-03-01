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
