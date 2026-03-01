import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildClassificationPrompt, parseClassificationResponse, DataClassifier } from './data-classifier'

describe('DataClassifier', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

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

  it('classify returns null when no API key is set', async () => {
    const classifier = new DataClassifier(null)
    const result = await classifier.classify('body', 'svc', 'application/json')
    expect(result).toBeNull()
  })

  it('classify returns classification on successful API response', async () => {
    const apiResponse = {
      choices: [{
        message: {
          content: JSON.stringify({
            suggestedTier: 'confidential',
            confidence: 0.9,
            patterns: ['email'],
            reasoning: 'Contains PII',
          }),
        },
      }],
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(apiResponse),
    }))

    const classifier = new DataClassifier('test-key')
    const result = await classifier.classify('{"email":"alice@example.com"}', 'github', 'application/json')

    expect(result).not.toBeNull()
    expect(result!.suggestedTier).toBe('confidential')
    expect(result!.confidence).toBe(0.9)
    expect(result!.patterns).toContain('email')
  })

  it('classify returns null when API returns non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    }))

    const classifier = new DataClassifier('test-key')
    const result = await classifier.classify('body', 'svc', 'text/plain')
    expect(result).toBeNull()
  })

  it('classify returns null when fetch rejects (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')))

    const classifier = new DataClassifier('test-key')
    const result = await classifier.classify('body', 'svc', 'text/plain')
    expect(result).toBeNull()
  })

  it('classify returns null when API returns non-JSON content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: 'not valid json' } }] }),
    }))

    const classifier = new DataClassifier('test-key')
    const result = await classifier.classify('body', 'svc', 'text/plain')
    expect(result).toBeNull()
  })
})
