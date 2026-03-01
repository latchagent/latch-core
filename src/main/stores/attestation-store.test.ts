import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { AttestationStore } from './attestation-store'
import type { ProxyAuditEvent, SessionReceipt } from '../../types'

function makeEvent(overrides: Partial<ProxyAuditEvent> = {}): ProxyAuditEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    sessionId: 'session-1',
    service: 'github',
    domain: 'api.github.com',
    method: 'GET',
    path: '/repos/foo/bar',
    tier: 'internal',
    decision: 'allow',
    reason: null,
    contentType: 'application/json',
    tlsInspected: false,
    redactionsApplied: 0,
    tokenizationsApplied: 0,
    ...overrides,
  }
}

describe('AttestationStore', () => {
  let store: AttestationStore

  beforeEach(() => {
    const db = new Database(':memory:')
    store = AttestationStore.open(db)
  })

  it('records and lists proxy audit events', () => {
    store.recordEvent(makeEvent())
    store.recordEvent(makeEvent({ decision: 'deny' }))
    const events = store.listEvents('session-1')
    expect(events).toHaveLength(2)
  })

  it('computes hash chain across events', () => {
    store.recordEvent(makeEvent())
    store.recordEvent(makeEvent())
    const chain = store.getHashChain('session-1')
    expect(chain).toBeTruthy()
    expect(chain!.length).toBe(64) // SHA-256 hex
  })

  it('hash chain changes when events differ', () => {
    store.recordEvent(makeEvent({ domain: 'a.com' }))
    const chain1 = store.getHashChain('session-1')

    const db2 = new Database(':memory:')
    const store2 = AttestationStore.open(db2)
    store2.recordEvent(makeEvent({ domain: 'b.com' }))
    const chain2 = store2.getHashChain('session-1')

    expect(chain1).not.toBe(chain2)
  })

  it('tracks leaf_index per event', () => {
    store.recordEvent(makeEvent({ id: 'e1' }))
    store.recordEvent(makeEvent({ id: 'e2' }))
    store.recordEvent(makeEvent({ id: 'e3' }))
    const hashes = store.getLeafHashes('session-1')
    expect(hashes).toHaveLength(3)
    expect(hashes[0]).toHaveLength(64) // SHA-256 hex
  })

  it('getMerkleRoot returns null for empty session', () => {
    expect(store.getMerkleRoot('no-such-session')).toBeNull()
  })

  it('getMerkleRoot returns 64-char hex for non-empty session', () => {
    store.recordEvent(makeEvent())
    store.recordEvent(makeEvent())
    const root = store.getMerkleRoot('session-1')
    expect(root).toHaveLength(64)
  })

  it('getMerkleRoot changes when events differ', () => {
    store.recordEvent(makeEvent({ domain: 'a.com' }))
    const root1 = store.getMerkleRoot('session-1')

    const db2 = new Database(':memory:')
    const store2 = AttestationStore.open(db2)
    store2.recordEvent(makeEvent({ domain: 'b.com' }))
    const root2 = store2.getMerkleRoot('session-1')

    expect(root1).not.toBe(root2)
  })

  it('getInclusionProof returns valid proof', () => {
    const e1 = makeEvent({ id: 'evt-1' })
    const e2 = makeEvent({ id: 'evt-2' })
    const e3 = makeEvent({ id: 'evt-3' })
    store.recordEvent(e1)
    store.recordEvent(e2)
    store.recordEvent(e3)

    const proof = store.getInclusionProof('session-1', 'evt-2')
    expect(proof).not.toBeNull()
    expect(proof!.leafIndex).toBe(1)
    expect(proof!.root).toBe(store.getMerkleRoot('session-1'))
  })

  it('getInclusionProof returns null for missing event', () => {
    store.recordEvent(makeEvent())
    expect(store.getInclusionProof('session-1', 'no-such-event')).toBeNull()
  })

  it('saves and retrieves a session receipt', () => {
    const receipt: SessionReceipt = {
      version: 1,
      sessionId: 'session-1',
      policy: { id: 'strict', hash: 'abc123', maxDataTier: 'internal', servicesGranted: ['github'] },
      activity: {
        servicesUsed: ['github'], networkRequests: 10, blockedRequests: 1,
        redactionsApplied: 0, tokenizationsApplied: 0,
        toolCalls: 5, toolDenials: 0, approvalEscalations: 0,
      },
      enclave: {
        sandboxType: 'docker', networkForced: true,
        startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
        exitReason: 'normal',
      },
      proof: { auditEventCount: 10, auditHashChain: 'abc', merkleRoot: 'def456', signature: 'sig', publicKey: 'pub' },
    }
    store.saveReceipt(receipt)
    const retrieved = store.getReceipt('session-1')
    expect(retrieved).toBeDefined()
    expect(retrieved!.policy.id).toBe('strict')
    expect(retrieved!.activity.networkRequests).toBe(10)
  })
})
