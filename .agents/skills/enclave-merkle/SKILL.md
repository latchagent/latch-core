---
name: enclave-merkle
description: Binary Merkle tree utility with domain-separated hashing for the Latch Enclave attestation system. Provides O(log n) inclusion proofs and consistency proofs for tamper-evident audit logging. Use when working on Merkle roots, audit event proofs, log consistency verification, or attestation store Merkle integration.
---

# Merkle Tree Utility

**File:** `src/main/lib/merkle.ts`

A pure-function Merkle tree library used by the attestation system to produce
tamper-evident roots and O(log n) proofs over audit events. Built on Node.js
`crypto` (SHA-256) with no external dependencies.

## Domain Separation

All hashing uses domain-separated prefixes to prevent second-preimage attacks
where an inner node hash could be mistaken for a valid leaf:

- **Leaf hashes:** `SHA-256("leaf:" + data)` via `computeLeafHash()`
- **Node hashes:** `SHA-256("node:" + leftHash + rightHash)` via internal `nodeHash()`

This ensures that no inner tree node can collide with a leaf hash.

## Padding (Non-Power-of-2 Leaf Counts)

When the number of leaves is not a power of 2, the tree pads to the next
power of 2 using empty leaf hashes (`computeLeafHash('')`). This ensures a
balanced binary tree at every level. The padding is transparent to callers
-- inclusion proofs and consistency proofs handle it automatically.

## API

### `computeLeafHash(eventJson: string): string`

Computes a domain-separated SHA-256 hash of the input string. Returns a
64-character lowercase hex string. Used to convert raw event JSON into leaf
hashes before passing to the tree functions.

### `buildMerkleRoot(leafHashes: string[]): string | null`

Builds the Merkle root from an array of pre-computed leaf hashes.
- Returns `null` for empty input.
- Returns the leaf hash itself for a single-element array.
- Pads to next power of 2 and computes the full tree for 2+ leaves.

### `buildInclusionProof(leafHashes: string[], index: number): MerkleProof | null`

Generates an inclusion proof for the leaf at `index`. Returns a `MerkleProof`
containing the leaf hash, its index, the sibling hashes (bottom-to-root order),
and the Merkle root. Returns `null` for out-of-bounds indices.

### `verifyInclusionProof(proof: MerkleProof): boolean`

Verifies an inclusion proof by recomputing the root from the leaf hash and
sibling hashes. Returns `true` if the recomputed root matches `proof.root`.

### `buildConsistencyProof(oldLeaves: string[], newLeaves: string[]): ConsistencyProof | null`

Generates a consistency proof between two log sizes, proving the old log is a
prefix of the new log. Returns a `ConsistencyProof` with both roots, sizes,
and the sibling hashes needed for verification. Returns `null` if `oldLeaves`
is empty or larger than `newLeaves`.

## Types

The proof types are defined in `src/types/index.ts`:

```typescript
interface MerkleProof {
  leafIndex: number
  leafHash: string
  siblings: string[]    // sibling hashes, bottom-to-root order
  root: string
}

interface ConsistencyProof {
  fromSize: number
  toSize: number
  fromRoot: string
  toRoot: string
  proof: string[]
}
```

## Testing

**Test file:** `src/main/lib/merkle.test.ts` (13 tests)

Run: `npx vitest run src/main/lib/merkle.test.ts`

Tests cover:
- Leaf hash format and domain separation
- Root computation (empty, single, multiple, determinism, tamper detection)
- Inclusion proof generation, verification, and tamper detection
- Non-power-of-2 leaf count handling
- Consistency proof generation between log sizes
- Out-of-bounds index handling
