import { describe, it, expect } from 'vitest'
import { buildClassificationPrompt, parseClassificationResponse } from './data-classifier'

describe('DataClassifier', () => {
  it('buildClassificationPrompt includes body excerpt', () => {
    const prompt = buildClassificationPrompt('{"user":"alice"}', 'github', 'application/json')
    expect(prompt).toContain('alice')
    expect(prompt).toContain('github')
  })

  it('buildClassificationPrompt truncates long bodies', () => {
    const longBody = 'x'.repeat(10000)
    const prompt = buildClassificationPrompt(longBody, 'svc', 'text/plain')
    expect(prompt.length).toBeLessThan(6000)
  })

  it('parseClassificationResponse extracts tier and patterns', () => {
    const response = JSON.stringify({
      suggestedTier: 'confidential',
      confidence: 0.85,
      patterns: ['email address', 'API key'],
      reasoning: 'Contains PII and credentials',
    })
    const result = parseClassificationResponse(response)
    expect(result).not.toBeNull()
    expect(result!.suggestedTier).toBe('confidential')
    expect(result!.confidence).toBe(0.85)
    expect(result!.patterns).toContain('email address')
  })

  it('parseClassificationResponse returns null for invalid JSON', () => {
    expect(parseClassificationResponse('not json')).toBeNull()
  })

  it('parseClassificationResponse rejects invalid tiers', () => {
    const response = JSON.stringify({
      suggestedTier: 'ultra-secret',
      confidence: 0.5,
      patterns: [],
      reasoning: 'test',
    })
    expect(parseClassificationResponse(response)).toBeNull()
  })
})
