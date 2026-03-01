import { describe, it, expect, vi, afterEach } from 'vitest'
import { formatReceiptComment, parsePrUrl, annotatePR } from './pr-annotator'
import type { SessionReceipt } from '../../types'

const mockReceipt: SessionReceipt = {
  version: 1,
  sessionId: 'session-1',
  policy: { id: 'strict', hash: 'abc123', maxDataTier: 'internal', servicesGranted: ['github'] },
  activity: {
    servicesUsed: ['github'], networkRequests: 42, blockedRequests: 3,
    redactionsApplied: 1, tokenizationsApplied: 5,
    toolCalls: 10, toolDenials: 2, approvalEscalations: 0,
  },
  gateway: {
    sandboxType: 'docker', networkForced: true,
    startedAt: '2026-02-28T10:00:00Z', endedAt: '2026-02-28T10:30:00Z',
    exitReason: 'normal',
  },
  proof: {
    auditEventCount: 42, auditHashChain: 'chain123',
    merkleRoot: 'merkle456', signature: 'sig789', publicKey: 'pub000',
  },
}

describe('PR Annotator', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parsePrUrl extracts owner, repo, and PR number', () => {
    const result = parsePrUrl('https://github.com/acme/repo/pull/42')
    expect(result).toEqual({ owner: 'acme', repo: 'repo', prNumber: 42 })
  })

  it('parsePrUrl returns null for invalid URL', () => {
    expect(parsePrUrl('https://example.com/foo')).toBeNull()
    expect(parsePrUrl('not-a-url')).toBeNull()
  })

  it('formatReceiptComment includes policy ID', () => {
    const comment = formatReceiptComment(mockReceipt)
    expect(comment).toContain('strict')
  })

  it('formatReceiptComment includes activity metrics', () => {
    const comment = formatReceiptComment(mockReceipt)
    expect(comment).toContain('42')  // networkRequests
    expect(comment).toContain('3')   // blockedRequests
  })

  it('formatReceiptComment includes Merkle root', () => {
    const comment = formatReceiptComment(mockReceipt)
    expect(comment).toContain('merkle456')
  })

  it('formatReceiptComment includes sandbox type', () => {
    const comment = formatReceiptComment(mockReceipt)
    expect(comment).toContain('docker')
  })

  it('annotatePR returns ok:true on successful API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ html_url: 'https://github.com/acme/repo/pull/42#issuecomment-1' }),
    }))

    const result = await annotatePR(mockReceipt, 'https://github.com/acme/repo/pull/42', 'ghp_test')
    expect(result.ok).toBe(true)
    expect(result.commentUrl).toBe('https://github.com/acme/repo/pull/42#issuecomment-1')

    // Verify the correct GitHub API URL was called
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(fetchCall[0]).toBe('https://api.github.com/repos/acme/repo/issues/42/comments')
  })

  it('annotatePR returns ok:false on non-200 API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('Forbidden'),
    }))

    const result = await annotatePR(mockReceipt, 'https://github.com/acme/repo/pull/42', 'ghp_bad')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('403')
  })

  it('annotatePR returns ok:false on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('DNS resolution failed')))

    const result = await annotatePR(mockReceipt, 'https://github.com/acme/repo/pull/42', 'ghp_test')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('DNS resolution failed')
  })

  it('annotatePR returns ok:false for invalid PR URL', async () => {
    const result = await annotatePR(mockReceipt, 'https://example.com/not-a-pr', 'ghp_test')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid GitHub PR URL')
  })
})
