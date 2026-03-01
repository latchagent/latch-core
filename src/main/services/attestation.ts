/**
 * @module attestation
 * @description Generates signed session receipts for audit and compliance.
 *
 * Uses Ed25519 for signing. Keys are ephemeral per AttestationEngine instance
 * (typically per app lifecycle). Receipts are self-contained and verifiable.
 */

import { createHash, generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey, KeyObject } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { verifyInclusionProof } from '../lib/merkle'
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
    toolCalls: number
    toolDenials: number
    approvalEscalations: number
  }
  sandboxType: 'docker' | 'seatbelt' | 'bubblewrap'
  networkForced: boolean
  exitReason: 'normal' | 'timeout' | 'killed' | 'error'
  startTime: number
  endTime: number
}

export class AttestationEngine {
  private store: AttestationStore
  private privateKey: KeyObject
  private publicKeyPem: string

  constructor(store: AttestationStore, keyPath?: string) {
    this.store = store
    const { privateKey, publicKeyPem } = AttestationEngine._loadOrGenerateKeys(keyPath)
    this.privateKey = privateKey
    this.publicKeyPem = publicKeyPem
  }

  /** Load an existing keypair from disk, or generate and persist a new one. */
  private static _loadOrGenerateKeys(keyPath?: string): { privateKey: KeyObject; publicKeyPem: string } {
    if (keyPath) {
      try {
        const keyData = fs.readFileSync(keyPath, 'utf-8')
        const parsed = JSON.parse(keyData)
        const privateKey = createPrivateKey({ key: Buffer.from(parsed.privateKey, 'base64'), format: 'der', type: 'pkcs8' })
        return { privateKey, publicKeyPem: parsed.publicKey }
      } catch {
        // Key file missing or corrupt — generate new keys
      }
    }

    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string

    if (keyPath) {
      const dir = path.dirname(keyPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const keyData = JSON.stringify({
        privateKey: (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64'),
        publicKey: publicKeyPem,
      })
      fs.writeFileSync(keyPath, keyData, { mode: 0o600 })
    }

    return { privateKey, publicKeyPem }
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
        toolCalls: input.activity.toolCalls,
        toolDenials: input.activity.toolDenials,
        approvalEscalations: input.activity.approvalEscalations,
      },
      enclave: {
        sandboxType: input.sandboxType,
        networkForced: input.networkForced,
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

  /** Verify a receipt's signature. If trustedPublicKey PEM is provided, verify against it instead of the embedded key. */
  verifyReceipt(receipt: SessionReceipt, trustedPublicKey?: string): boolean {
    try {
      const payload = JSON.stringify({ ...receipt, proof: { ...receipt.proof, signature: '' } })
      const pubKey = createPublicKey(trustedPublicKey ?? receipt.proof.publicKey)
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
    return verifyInclusionProof(proof)
  }
}
