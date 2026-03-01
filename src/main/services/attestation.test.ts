import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { AttestationEngine } from './attestation'
import { AttestationStore } from '../stores/attestation-store'
import type { PolicyDocument } from '../../types'

const MOCK_POLICY: PolicyDocument = {
  id: 'strict',
  name: 'Strict',
  description: 'Test policy',
  permissions: { allowBash: true, allowNetwork: false, allowFileWrite: true, confirmDestructive: true, blockedGlobs: [] },
  harnesses: {},
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
})
