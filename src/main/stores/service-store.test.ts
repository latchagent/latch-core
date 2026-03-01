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
