/**
 * @module merkle
 * @description Binary Merkle tree with domain-separated hashing.
 *
 * Uses "leaf:" and "node:" prefixes for domain separation to prevent
 * second-preimage attacks where an inner node hash could be mistaken
 * for a valid leaf.
 */

import { createHash } from 'node:crypto'
import type { MerkleProof, ConsistencyProof } from '../../types'

/** Compute the leaf hash with domain separation. */
export function computeLeafHash(eventJson: string): string {
  return createHash('sha256').update('leaf:' + eventJson).digest('hex')
}

/** Compute the inner node hash with domain separation. */
function nodeHash(left: string, right: string): string {
  return createHash('sha256').update('node:' + left + right).digest('hex')
}

/**
 * Build the Merkle root from an array of leaf hashes.
 * Pads to next power of 2 with empty-string hashes.
 * Returns null for empty input.
 */
export function buildMerkleRoot(leafHashes: string[]): string | null {
  if (leafHashes.length === 0) return null
  if (leafHashes.length === 1) return leafHashes[0]

  // Pad to next power of 2
  const size = nextPow2(leafHashes.length)
  const padded = [...leafHashes]
  const emptyHash = computeLeafHash('')
  while (padded.length < size) padded.push(emptyHash)

  let level = padded
  while (level.length > 1) {
    const next: string[] = []
    for (let i = 0; i < level.length; i += 2) {
      next.push(nodeHash(level[i], level[i + 1]))
    }
    level = next
  }
  return level[0]
}

/**
 * Build an inclusion proof for the leaf at the given index.
 * Returns the sibling hashes from bottom to root.
 */
export function buildInclusionProof(leafHashes: string[], index: number): MerkleProof | null {
  if (index < 0 || index >= leafHashes.length) return null
  if (leafHashes.length === 0) return null

  const root = buildMerkleRoot(leafHashes)
  if (!root) return null

  if (leafHashes.length === 1) {
    return { leafIndex: 0, leafHash: leafHashes[0], siblings: [], root }
  }

  // Pad to next power of 2
  const size = nextPow2(leafHashes.length)
  const padded = [...leafHashes]
  const emptyHash = computeLeafHash('')
  while (padded.length < size) padded.push(emptyHash)

  const siblings: string[] = []
  let level = padded
  let idx = index

  while (level.length > 1) {
    // Sibling is the other node in the pair
    const sibIdx = idx % 2 === 0 ? idx + 1 : idx - 1
    siblings.push(level[sibIdx])

    // Move up
    const next: string[] = []
    for (let i = 0; i < level.length; i += 2) {
      next.push(nodeHash(level[i], level[i + 1]))
    }
    level = next
    idx = Math.floor(idx / 2)
  }

  return { leafIndex: index, leafHash: leafHashes[index], siblings, root }
}

/** Verify an inclusion proof by recomputing the root. */
export function verifyInclusionProof(proof: MerkleProof): boolean {
  let hash = proof.leafHash
  let idx = proof.leafIndex

  for (const sibling of proof.siblings) {
    if (idx % 2 === 0) {
      hash = nodeHash(hash, sibling)
    } else {
      hash = nodeHash(sibling, hash)
    }
    idx = Math.floor(idx / 2)
  }

  return hash === proof.root
}

/**
 * Build a consistency proof between two log sizes.
 * Stores the roots and the hashes needed to verify the old root
 * is a prefix of the new tree.
 */
export function buildConsistencyProof(
  oldLeaves: string[],
  newLeaves: string[],
): ConsistencyProof | null {
  if (oldLeaves.length === 0 || oldLeaves.length > newLeaves.length) return null

  const fromRoot = buildMerkleRoot(oldLeaves)
  const toRoot = buildMerkleRoot(newLeaves)
  if (!fromRoot || !toRoot) return null

  // Collect the sibling hashes needed to reconstruct the old root
  // within the new, larger tree
  const size = nextPow2(newLeaves.length)
  const padded = [...newLeaves]
  const emptyHash = computeLeafHash('')
  while (padded.length < size) padded.push(emptyHash)

  // Walk the tree, collecting nodes that cover ranges beyond oldLeaves.length
  const proof: string[] = []
  collectConsistencyNodes(padded, 0, size, oldLeaves.length, proof)

  return {
    fromSize: oldLeaves.length,
    toSize: newLeaves.length,
    fromRoot,
    toRoot,
    proof,
  }
}

/** Recursively collect hashes for consistency proof. */
function collectConsistencyNodes(
  level: string[],
  start: number,
  end: number,
  splitPoint: number,
  proof: string[],
): void {
  if (start >= end || start >= splitPoint) return
  const mid = start + (end - start) / 2

  if (splitPoint <= mid) {
    // Old tree is entirely in left subtree — include right subtree hash
    proof.push(subtreeHash(level, mid, end))
    collectConsistencyNodes(level, start, mid, splitPoint, proof)
  } else if (splitPoint >= end) {
    // Old tree covers entire range — nothing to add
  } else {
    // Split point is in right half
    collectConsistencyNodes(level, start, mid, splitPoint, proof)
    collectConsistencyNodes(level, mid, end, splitPoint, proof)
  }
}

/** Compute the hash of a subtree over a contiguous range. */
function subtreeHash(leaves: string[], start: number, end: number): string {
  if (end - start === 1) return leaves[start]
  const mid = start + (end - start) / 2
  return nodeHash(subtreeHash(leaves, start, mid), subtreeHash(leaves, mid, end))
}

function nextPow2(n: number): number {
  let p = 1
  while (p < n) p *= 2
  return p
}
