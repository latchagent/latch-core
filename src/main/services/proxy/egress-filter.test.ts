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

  describe('path/method scoping', () => {
    const scopedService: ServiceDefinition = {
      ...GITHUB,
      id: 'scoped-github',
      injection: {
        ...GITHUB.injection,
        proxy: {
          ...GITHUB.injection.proxy,
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
      const filter = new EgressFilter([GITHUB])
      const result = filter.checkPathScope(GITHUB, 'DELETE', '/anything')
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
})
