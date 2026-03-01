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
      proof: { auditEventCount: 10, auditHashChain: 'abc', signature: 'sig', publicKey: 'pub' },
    }
    store.saveReceipt(receipt)
    const retrieved = store.getReceipt('session-1')
    expect(retrieved).toBeDefined()
    expect(retrieved!.policy.id).toBe('strict')
    expect(retrieved!.activity.networkRequests).toBe(10)
  })
})
