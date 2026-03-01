import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { AttestationEngine, ReceiptInput } from './attestation'
import { AttestationStore } from '../stores/attestation-store'
import type { PolicyDocument, ProxyAuditEvent } from '../../types'

const MOCK_POLICY: PolicyDocument = {
  id: 'strict',
  name: 'Strict',
  description: 'Test policy',
  permissions: { allowBash: true, allowNetwork: false, allowFileWrite: true, confirmDestructive: true, blockedGlobs: [] },
  harnesses: {},
}

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

function makeInput(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    sessionId: 'session-1',
    policy: MOCK_POLICY,
    maxDataTier: 'internal',
    servicesGranted: ['github'],
    servicesUsed: ['github'],
    activity: { requests: 10, blocked: 1, redactions: 0, tokenizations: 0 },
    sandboxType: 'docker',
    exitReason: 'normal',
    startTime: Date.now() - 60000,
    endTime: Date.now(),
    ...overrides,
  }
}

describe('AttestationEngine', () => {
  let engine: AttestationEngine
  let store: AttestationStore

  beforeEach(() => {
    const db = new Database(':memory:')
    store = AttestationStore.open(db)
    engine = new AttestationEngine(store)
  })

  it('generates a signed session receipt', () => {
    const receipt = engine.generateReceipt({
      sessionId: 'session-1',
      policy: MOCK_POLICY,
      maxDataTier: 'internal',
      servicesGranted: ['github'],
      servicesUsed: ['github'],
      activity: { requests: 10, blocked: 1, redactions: 0, tokenizations: 0 },
      sandboxType: 'docker',
      exitReason: 'normal',
      startTime: Date.now() - 60000,
      endTime: Date.now(),
    })

    expect(receipt.version).toBe(1)
    expect(receipt.sessionId).toBe('session-1')
    expect(receipt.policy.id).toBe('strict')
    expect(receipt.policy.hash).toBeTruthy()
    expect(receipt.proof.signature).toBeTruthy()
    expect(receipt.proof.publicKey).toBeTruthy()
  })

  it('saves receipt to store', () => {
    engine.generateReceipt({
      sessionId: 'session-1',
      policy: MOCK_POLICY,
      maxDataTier: 'internal',
      servicesGranted: [],
      servicesUsed: [],
      activity: { requests: 0, blocked: 0, redactions: 0, tokenizations: 0 },
      sandboxType: 'docker',
      exitReason: 'normal',
      startTime: Date.now(),
      endTime: Date.now(),
    })

    const retrieved = store.getReceipt('session-1')
    expect(retrieved).toBeDefined()
    expect(retrieved!.policy.id).toBe('strict')
  })

  it('signature is verifiable', () => {
    const receipt = engine.generateReceipt({
      sessionId: 'session-2',
      policy: MOCK_POLICY,
      maxDataTier: 'internal',
      servicesGranted: [],
      servicesUsed: [],
      activity: { requests: 0, blocked: 0, redactions: 0, tokenizations: 0 },
      sandboxType: 'docker',
      exitReason: 'normal',
      startTime: Date.now(),
      endTime: Date.now(),
    })

    const verified = engine.verifyReceipt(receipt)
    expect(verified).toBe(true)
  })

  it('receipt includes merkleRoot in proof', () => {
    store.recordEvent(makeEvent())
    store.recordEvent(makeEvent())

    const receipt = engine.generateReceipt(makeInput())

    expect(receipt.proof.merkleRoot).toBeTruthy()
    expect(receipt.proof.merkleRoot).toHaveLength(64)
  })

  it('merkleRoot matches store computation', () => {
    store.recordEvent(makeEvent())
    store.recordEvent(makeEvent())

    const receipt = engine.generateReceipt(makeInput())
    const storeRoot = store.getMerkleRoot('session-1')

    expect(receipt.proof.merkleRoot).toBe(storeRoot)
  })

  it('generates valid inclusion proof for an event', () => {
    const e1 = makeEvent({ id: 'evt-1' })
    const e2 = makeEvent({ id: 'evt-2' })
    const e3 = makeEvent({ id: 'evt-3' })
    store.recordEvent(e1)
    store.recordEvent(e2)
    store.recordEvent(e3)

    const proof = engine.generateInclusionProof('session-1', 'evt-2')
    expect(proof).not.toBeNull()
    expect(proof!.leafIndex).toBe(1)

    const valid = engine.verifyInclusionProof(proof!)
    expect(valid).toBe(true)
  })
})
