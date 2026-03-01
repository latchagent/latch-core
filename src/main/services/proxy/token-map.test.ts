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
    expect(entry.id).toMatch(/^tok_[a-f0-9]{32}$/)
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
    expect(result).toMatch(/tok_[a-f0-9]{32}/)
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
