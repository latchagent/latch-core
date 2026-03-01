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
