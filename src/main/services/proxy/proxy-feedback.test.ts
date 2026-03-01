import { describe, it, expect } from 'vitest'
import { formatFeedback, createFeedbackSender } from './proxy-feedback'
import type { ProxyFeedbackMessage } from '../../../types'

describe('ProxyFeedback', () => {
  it('formats block messages', () => {
    const msg: ProxyFeedbackMessage = {
      type: 'block',
      domain: 'evil.com',
      service: null,
      detail: 'evil.com is not an authorized service',
    }
    const formatted = formatFeedback(msg)
    expect(formatted).toContain('[LATCH]')
    expect(formatted).toContain('BLOCKED')
    expect(formatted).toContain('evil.com')
  })

  it('formats redaction messages', () => {
    const msg: ProxyFeedbackMessage = {
      type: 'redaction',
      domain: 'api.github.com',
      service: 'github',
      detail: '3 values redacted in response',
    }
    const formatted = formatFeedback(msg)
    expect(formatted).toContain('[LATCH]')
    expect(formatted).toContain('REDACTED')
    expect(formatted).toContain('github')
  })

  it('formats tokenization messages', () => {
    const msg: ProxyFeedbackMessage = {
      type: 'tokenization',
      domain: 'api.github.com',
      service: 'github',
      detail: '2 value(s) tokenized in response',
    }
    const formatted = formatFeedback(msg)
    expect(formatted).toContain('[LATCH]')
    expect(formatted).toContain('TOKENIZED')
  })

  it('formats tls-exception messages', () => {
    const msg: ProxyFeedbackMessage = {
      type: 'tls-exception',
      domain: 'pinned.example.com',
      service: 'pinned-svc',
      detail: 'TLS exception — tunneling without inspection',
    }
    const formatted = formatFeedback(msg)
    expect(formatted).toContain('[LATCH]')
    expect(formatted).toContain('TLS-EXCEPTION')
  })

  it('formats leak-detected messages', () => {
    const msg: ProxyFeedbackMessage = {
      type: 'leak-detected',
      domain: 'api.github.com',
      service: 'github',
      detail: 'Credential leak detected in request body: token',
    }
    const formatted = formatFeedback(msg)
    expect(formatted).toContain('[LATCH]')
    expect(formatted).toContain('LEAK-DETECTED')
    expect(formatted).toContain('api.github.com')
    expect(formatted).toContain('github')
    expect(formatted).toContain('Credential leak')
  })

  it('formats scope-violation messages', () => {
    const msg: ProxyFeedbackMessage = {
      type: 'scope-violation',
      domain: 'api.github.com',
      service: 'github',
      detail: 'DELETE /repos/foo denied by path rule',
    }
    const formatted = formatFeedback(msg)
    expect(formatted).toContain('[LATCH]')
    expect(formatted).toContain('SCOPE-DENIED')
  })

  it('formats credential-expired messages', () => {
    const msg: ProxyFeedbackMessage = {
      type: 'credential-expired',
      domain: 'api.github.com',
      service: 'github',
      detail: 'Token expired at 2026-01-01T00:00:00Z',
    }
    const formatted = formatFeedback(msg)
    expect(formatted).toContain('[LATCH]')
    expect(formatted).toContain('CRED-EXPIRED')
  })

  it('createFeedbackSender calls send function with formatted message', () => {
    const sent: string[] = []
    const sender = createFeedbackSender((data: string) => sent.push(data))
    sender({
      type: 'block',
      domain: 'evil.com',
      service: null,
      detail: 'blocked',
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('[LATCH]')
  })
})
