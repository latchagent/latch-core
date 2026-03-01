import { describe, it, expect } from 'vitest'
import { formatReceiptComment, parsePrUrl } from './pr-annotator'
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
  enclave: {
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
})
