import { describe, it, expect } from 'vitest'
import { computeLeafHash, buildMerkleRoot, buildInclusionProof, verifyInclusionProof, buildConsistencyProof } from './merkle'

describe('Merkle tree', () => {
  const leaves = ['event-a', 'event-b', 'event-c', 'event-d']
  const leafHashes = leaves.map(computeLeafHash)

  it('computeLeafHash produces 64-char hex', () => {
    const h = computeLeafHash('test')
    expect(h).toHaveLength(64)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('computeLeafHash uses domain separation', () => {
    // "leaf:" prefix means leaf hash ≠ raw SHA-256
    const { createHash } = require('node:crypto')
    const raw = createHash('sha256').update('test').digest('hex')
    const leaf = computeLeafHash('test')
    expect(leaf).not.toBe(raw)
  })

  it('buildMerkleRoot returns null for empty leaves', () => {
    expect(buildMerkleRoot([])).toBeNull()
  })

  it('buildMerkleRoot returns leaf hash for single leaf', () => {
    const root = buildMerkleRoot([leafHashes[0]])
    expect(root).toBe(leafHashes[0])
  })

  it('buildMerkleRoot returns 64-char hex for multiple leaves', () => {
    const root = buildMerkleRoot(leafHashes)
    expect(root).toHaveLength(64)
  })

  it('buildMerkleRoot is deterministic', () => {
    const r1 = buildMerkleRoot(leafHashes)
    const r2 = buildMerkleRoot(leafHashes)
    expect(r1).toBe(r2)
  })

  it('buildMerkleRoot changes when a leaf changes', () => {
    const altered = [...leafHashes]
    altered[2] = computeLeafHash('event-x')
    expect(buildMerkleRoot(altered)).not.toBe(buildMerkleRoot(leafHashes))
  })

  it('buildInclusionProof returns null for out-of-bounds index', () => {
    expect(buildInclusionProof(leafHashes, -1)).toBeNull()
    expect(buildInclusionProof(leafHashes, leafHashes.length)).toBeNull()
  })

  it('buildInclusionProof returns valid proof for each leaf', () => {
    const root = buildMerkleRoot(leafHashes)!
    for (let i = 0; i < leafHashes.length; i++) {
      const proof = buildInclusionProof(leafHashes, i)
      expect(proof).not.toBeNull()
      expect(proof!.root).toBe(root)
      expect(proof!.leafIndex).toBe(i)
      expect(proof!.leafHash).toBe(leafHashes[i])
    }
  })

  it('verifyInclusionProof returns true for valid proof', () => {
    const proof = buildInclusionProof(leafHashes, 1)!
    expect(verifyInclusionProof(proof)).toBe(true)
  })

  it('verifyInclusionProof returns false for tampered proof', () => {
    const proof = buildInclusionProof(leafHashes, 1)!
    proof.leafHash = computeLeafHash('tampered')
    expect(verifyInclusionProof(proof)).toBe(false)
  })

  it('handles non-power-of-2 leaf counts', () => {
    const odd = leafHashes.slice(0, 3) // 3 leaves
    const root = buildMerkleRoot(odd)
    expect(root).toHaveLength(64)
    const proof = buildInclusionProof(odd, 2)!
    expect(verifyInclusionProof(proof)).toBe(true)
  })

  it('buildConsistencyProof returns proof between two sizes', () => {
    const first3 = leafHashes.slice(0, 3)
    const all4 = leafHashes
    const proof = buildConsistencyProof(first3, all4)
    expect(proof).not.toBeNull()
    expect(proof!.fromSize).toBe(3)
    expect(proof!.toSize).toBe(4)
    expect(proof!.fromRoot).toBe(buildMerkleRoot(first3))
    expect(proof!.toRoot).toBe(buildMerkleRoot(all4))
  })
})
