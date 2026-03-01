/**
 * @module attestation
 * @description Generates signed session receipts for audit and compliance.
 *
 * Uses Ed25519 for signing. Keys are ephemeral per AttestationEngine instance
 * (typically per app lifecycle). Receipts are self-contained and verifiable.
 */

import { createHash, generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto'
import { verifyInclusionProof as verifyProof } from '../lib/merkle'
import type { AttestationStore } from '../stores/attestation-store'
import type { PolicyDocument, SessionReceipt, DataTier, MerkleProof } from '../../types'

export interface ReceiptInput {
  sessionId: string
  policy: PolicyDocument
  maxDataTier: DataTier
  servicesGranted: string[]
  servicesUsed: string[]
  activity: {
    requests: number
    blocked: number
    redactions: number
    tokenizations: number
  }
  sandboxType: 'docker' | 'seatbelt' | 'bubblewrap'
  exitReason: 'normal' | 'timeout' | 'killed' | 'error'
  startTime: number
  endTime: number
}

export class AttestationEngine {
  private store: AttestationStore
  private privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
  private publicKeyPem: string

  constructor(store: AttestationStore) {
    this.store = store
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    this.privateKey = privateKey
    this.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
  }

  /** Generate a signed session receipt and save it to the store. */
  generateReceipt(input: ReceiptInput): SessionReceipt {
    const policyHash = createHash('sha256')
      .update(JSON.stringify(input.policy))
      .digest('hex')

    const auditHashChain = this.store.getHashChain(input.sessionId) ?? ''
    const merkleRoot = this.store.getMerkleRoot(input.sessionId) ?? ''
    const auditEventCount = this.store.getEventCount(input.sessionId)

    const receipt: SessionReceipt = {
      version: 1,
      sessionId: input.sessionId,
      policy: {
        id: input.policy.id,
        hash: policyHash,
        maxDataTier: input.maxDataTier,
        servicesGranted: input.servicesGranted,
      },
      activity: {
        servicesUsed: input.servicesUsed,
        networkRequests: input.activity.requests,
        blockedRequests: input.activity.blocked,
        redactionsApplied: input.activity.redactions,
        tokenizationsApplied: input.activity.tokenizations,
        toolCalls: 0,
        toolDenials: 0,
        approvalEscalations: 0,
      },
      enclave: {
        sandboxType: input.sandboxType,
        networkForced: true,
        startedAt: new Date(input.startTime).toISOString(),
        endedAt: new Date(input.endTime).toISOString(),
        exitReason: input.exitReason,
      },
      proof: {
        auditEventCount,
        auditHashChain,
        merkleRoot,
        signature: '',
        publicKey: this.publicKeyPem,
      },
    }

    // Sign the receipt (excluding the signature field itself)
    const payload = JSON.stringify({ ...receipt, proof: { ...receipt.proof, signature: '' } })
    receipt.proof.signature = sign(null, Buffer.from(payload), this.privateKey).toString('base64')

    this.store.saveReceipt(receipt)
    return receipt
  }

  /** Verify a receipt's signature. */
  verifyReceipt(receipt: SessionReceipt): boolean {
    try {
      const payload = JSON.stringify({ ...receipt, proof: { ...receipt.proof, signature: '' } })
      const pubKey = createPublicKey(receipt.proof.publicKey)
      return verify(null, Buffer.from(payload), pubKey, Buffer.from(receipt.proof.signature, 'base64'))
    } catch {
      return false
    }
  }

  /** Generate a Merkle inclusion proof for a specific audit event. */
  generateInclusionProof(sessionId: string, eventId: string): MerkleProof | null {
    return this.store.getInclusionProof(sessionId, eventId)
  }

  /** Verify a Merkle inclusion proof. */
  verifyInclusionProof(proof: MerkleProof): boolean {
    return verifyProof(proof)
  }
}
