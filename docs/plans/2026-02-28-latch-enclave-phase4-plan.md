# Latch Enclave Phase 4: Attestation Hardening — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the linear hash chain with a Merkle tree for tamper-evident audit logging with O(log n) inclusion proofs, add GitHub PR attestation annotations, and build an Enclave viewer panel in the renderer.

**Architecture:** Phase 1 built `AttestationStore` (linear SHA-256 hash chain) and `AttestationEngine` (Ed25519 signing). Phase 4 upgrades the store to compute Merkle roots over audit events with domain-separated hashing, adds inclusion/consistency proof generation, wires the proxy's in-memory audit log to the persistent store (fixing a Phase 1 wiring gap), and exposes it all through new IPC channels, a PR annotation service, and an Enclave rail panel.

**Tech Stack:** Node.js `crypto` (SHA-256, Ed25519), `better-sqlite3`, React + Zustand, vitest for tests.

**Design doc:** `docs/plans/2026-02-28-latch-enclave-design.md` (Phase 4 section, lines 524-527)

**Pre-existing issues (not our bugs):**
- `radar.test.ts` has 4 failing tests — ignore these.
- `policy-generator.ts` has a type error — filter with `grep -v policy-generator`.

---

## Task 1: Add Merkle and Attestation Types

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Add MerkleProof and ConsistencyProof types after SessionReceipt (line 321)**

After the closing `}` of `SessionReceipt`, add:

```typescript
/** Merkle inclusion proof for a single audit event. */
export interface MerkleProof {
  leafIndex: number
  leafHash: string
  siblings: string[]    // sibling hashes, bottom-to-root order
  root: string
}

/** Consistency proof that the log grew without mutation. */
export interface ConsistencyProof {
  fromSize: number
  toSize: number
  fromRoot: string
  toRoot: string
  proof: string[]
}
```

**Step 2: Add `merkleRoot` to SessionReceipt.proof**

In `SessionReceipt.proof` (line 315-320), add `merkleRoot` after `auditHashChain`:

```typescript
  proof: {
    auditEventCount: number
    auditHashChain: string
    merkleRoot: string       // NEW — root of the Merkle tree over all events
    signature: string
    publicKey: string
  }
```

**Step 3: Add `'enclave'` to RailPanel (line 504)**

```typescript
export type RailPanel = 'activity' | 'policy' | 'services' | 'enclave';
```

**Step 4: Add new IPC methods to LatchAPI (after line 641)**

After `listProxyAudit`, add:

```typescript
  getInclusionProof(payload: { sessionId: string; eventId: string }): Promise<{ ok: boolean; proof?: MerkleProof; error?: string }>;
  annotateGitHubPR(payload: { sessionId: string; prUrl: string }): Promise<{ ok: boolean; commentUrl?: string; error?: string }>;
```

**Step 5: Run typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v policy-generator`

Expected: Errors in `attestation-store.test.ts` and `attestation.ts` because `SessionReceipt.proof` now requires `merkleRoot`. These will be fixed in subsequent tasks.

**Step 6: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): add Merkle proof types, merkleRoot to SessionReceipt, enclave rail panel"
```

---

## Task 2: Build Merkle Tree Utility

**Files:**
- Create: `src/main/lib/merkle.ts`
- Create: `src/main/lib/merkle.test.ts`

**Step 1: Write the failing tests**

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/lib/merkle.test.ts`
Expected: FAIL — module not found.

**Step 3: Write the implementation**

```typescript
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
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/lib/merkle.test.ts`
Expected: All 13 tests PASS.

**Step 5: Commit**

```bash
git add src/main/lib/merkle.ts src/main/lib/merkle.test.ts
git commit -m "feat(merkle): add binary Merkle tree with domain-separated hashing"
```

---

## Task 3: Upgrade AttestationStore with Merkle Methods

**Files:**
- Modify: `src/main/stores/attestation-store.ts`
- Modify: `src/main/stores/attestation-store.test.ts`

**Step 1: Write the failing tests**

Add these tests to `attestation-store.test.ts`, inside the existing `describe('AttestationStore', ...)`:

```typescript
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
```

Also add import for `MerkleProof` if used in test assertions.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/stores/attestation-store.test.ts`
Expected: FAIL — `getLeafHashes`, `getMerkleRoot`, `getInclusionProof` not found.

**Step 3: Update attestation-store.ts**

Add import at top:
```typescript
import { computeLeafHash, buildMerkleRoot, buildInclusionProof } from '../lib/merkle'
import type { MerkleProof } from '../../types'
```

In `_init()`, add leaf_index migration after the existing table creations (idempotent):
```typescript
    try {
      this.db.exec('ALTER TABLE proxy_audit_log ADD COLUMN leaf_index INTEGER')
    } catch {
      // Column already exists
    }
```

Update `recordEvent` to track leaf_index:
```typescript
  recordEvent(event: ProxyAuditEvent): void {
    const prevRow = this.db.prepare(
      'SELECT hash FROM proxy_audit_log WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(event.sessionId) as { hash: string } | undefined
    const prevHash = prevRow?.hash ?? ''

    const eventJson = JSON.stringify(event)
    const hash = createHash('sha256').update(prevHash + eventJson).digest('hex')

    // Compute leaf_index as next sequential index for this session
    const countRow = this.db.prepare(
      'SELECT COUNT(*) as count FROM proxy_audit_log WHERE session_id = ?'
    ).get(event.sessionId) as { count: number }
    const leafIndex = countRow.count

    this.db.prepare(`
      INSERT INTO proxy_audit_log (id, session_id, event_json, prev_hash, hash, leaf_index, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(event.id, event.sessionId, eventJson, prevHash || null, hash, leafIndex, event.timestamp)
  }
```

Add new methods before `saveReceipt`:

```typescript
  /** Get ordered leaf hashes for Merkle tree computation. */
  getLeafHashes(sessionId: string): string[] {
    const rows = this.db.prepare(
      'SELECT event_json FROM proxy_audit_log WHERE session_id = ? ORDER BY leaf_index ASC'
    ).all(sessionId) as { event_json: string }[]
    return rows.map(r => computeLeafHash(r.event_json))
  }

  /** Compute the Merkle root over all audit events for a session. */
  getMerkleRoot(sessionId: string): string | null {
    const leaves = this.getLeafHashes(sessionId)
    return buildMerkleRoot(leaves)
  }

  /** Build an inclusion proof for a specific event. */
  getInclusionProof(sessionId: string, eventId: string): MerkleProof | null {
    const indexRow = this.db.prepare(
      'SELECT leaf_index FROM proxy_audit_log WHERE session_id = ? AND id = ?'
    ).get(sessionId, eventId) as { leaf_index: number } | undefined
    if (!indexRow) return null

    const leaves = this.getLeafHashes(sessionId)
    return buildInclusionProof(leaves, indexRow.leaf_index)
  }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/stores/attestation-store.test.ts`
Expected: All tests PASS (original 4 + new 6 = 10).

**Step 5: Commit**

```bash
git add src/main/stores/attestation-store.ts src/main/stores/attestation-store.test.ts
git commit -m "feat(attestation-store): add Merkle root and inclusion proof methods"
```

---

## Task 4: Wire LatchProxy Audit Events to AttestationStore

**Files:**
- Modify: `src/main/services/latch-proxy.ts`
- Modify: `src/main/services/latch-proxy.test.ts`

This fixes a Phase 1 wiring gap: `_recordAudit` only pushes to an in-memory array, never to the persistent `AttestationStore`. The Merkle tree is meaningless without persistent events.

**Step 1: Write the failing test**

Add a new test to `latch-proxy.test.ts`:

```typescript
  it('persists audit events to attestation store when provided', async () => {
    const Database = (await import('better-sqlite3')).default
    const { AttestationStore } = await import('../stores/attestation-store')
    const db = new Database(':memory:')
    const attStore = AttestationStore.open(db)

    const proxy = new LatchProxy({
      sessionId: 'test-session',
      services: [testService],
      credentials: new Map(),
      maxDataTier: 'internal',
      attestationStore: attStore,
    })
    await proxy.start()

    // Make a request that will be evaluated (allowed)
    proxy.evaluateRequest('api.github.com', 'GET', '/repos')

    const events = attStore.listEvents('test-session')
    expect(events.length).toBeGreaterThanOrEqual(1)

    proxy.stop()
  })
```

**Step 2: Run tests to verify it fails**

Run: `npx vitest run src/main/services/latch-proxy.test.ts`
Expected: FAIL — `attestationStore` not in `LatchProxyConfig`.

**Step 3: Update LatchProxyConfig and _recordAudit**

In `latch-proxy.ts`, add import:
```typescript
import type { AttestationStore } from '../stores/attestation-store'
```

Add to `LatchProxyConfig` interface (after `enableTls`):
```typescript
  attestationStore?: AttestationStore
```

At the end of `_recordAudit`, after `this.auditLog.push(...)`, add:
```typescript
    // Persist to attestation store for Merkle tree computation
    this.config.attestationStore?.recordEvent(this.auditLog[this.auditLog.length - 1])
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/services/latch-proxy.test.ts`
Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/main/services/latch-proxy.ts src/main/services/latch-proxy.test.ts
git commit -m "fix(latch-proxy): persist audit events to AttestationStore"
```

---

## Task 5: Upgrade AttestationEngine with Merkle Receipt

**Files:**
- Modify: `src/main/services/attestation.ts`
- Modify: `src/main/services/attestation.test.ts`

**Step 1: Write the failing tests**

Add to `attestation.test.ts`:

```typescript
  it('receipt includes merkleRoot in proof', () => {
    store.recordEvent(makeEvent({ sessionId: 'session-1' }))
    store.recordEvent(makeEvent({ sessionId: 'session-1' }))

    const receipt = engine.generateReceipt(makeInput())
    expect(receipt.proof.merkleRoot).toBeDefined()
    expect(receipt.proof.merkleRoot).toHaveLength(64)
  })

  it('merkleRoot matches store computation', () => {
    store.recordEvent(makeEvent({ sessionId: 'session-1' }))
    store.recordEvent(makeEvent({ sessionId: 'session-1' }))

    const receipt = engine.generateReceipt(makeInput())
    expect(receipt.proof.merkleRoot).toBe(store.getMerkleRoot('session-1'))
  })

  it('generates valid inclusion proof for an event', () => {
    const evt = makeEvent({ sessionId: 'session-1', id: 'target-evt' })
    store.recordEvent(evt)
    store.recordEvent(makeEvent({ sessionId: 'session-1' }))

    const proof = engine.generateInclusionProof('session-1', 'target-evt')
    expect(proof).not.toBeNull()
    expect(proof!.root).toBe(store.getMerkleRoot('session-1'))
    expect(engine.verifyInclusionProof(proof!)).toBe(true)
  })
```

You'll need a `makeEvent` helper and a `makeInput` helper in the test file. The `makeEvent` is already imported from the store test or should be created locally. `makeInput` returns a valid `ReceiptInput`:

```typescript
function makeInput(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    sessionId: 'session-1',
    policy: { id: 'test', name: 'Test', description: '', permissions: { allowBash: true, allowNetwork: false, allowFileWrite: true, confirmDestructive: false, blockedGlobs: [] }, harnesses: {} },
    maxDataTier: 'internal',
    servicesGranted: ['github'],
    servicesUsed: ['github'],
    activity: { requests: 5, blocked: 1, redactions: 0, tokenizations: 0 },
    sandboxType: 'docker',
    exitReason: 'normal',
    startTime: Date.now() - 60000,
    endTime: Date.now(),
    ...overrides,
  }
}
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/services/attestation.test.ts`
Expected: FAIL — `merkleRoot` not in receipt, `generateInclusionProof` not found.

**Step 3: Update attestation.ts**

Add imports:
```typescript
import { verifyInclusionProof as verifyProof } from '../lib/merkle'
import type { MerkleProof } from '../../types'
```

In `generateReceipt`, after `const auditHashChain = ...` (line 49), add:
```typescript
    const merkleRoot = this.store.getMerkleRoot(input.sessionId) ?? ''
```

In the `proof` object (line 78-83), add `merkleRoot`:
```typescript
      proof: {
        auditEventCount,
        auditHashChain,
        merkleRoot,
        signature: '',
        publicKey: this.publicKeyPem,
      },
```

Add two new methods after `verifyReceipt`:

```typescript
  /** Generate a Merkle inclusion proof for a specific audit event. */
  generateInclusionProof(sessionId: string, eventId: string): MerkleProof | null {
    return this.store.getInclusionProof(sessionId, eventId)
  }

  /** Verify a Merkle inclusion proof. */
  verifyInclusionProof(proof: MerkleProof): boolean {
    return verifyProof(proof)
  }
```

**Step 4: Fix the existing test that creates a SessionReceipt literal**

In `attestation-store.test.ts`, the `saves and retrieves a session receipt` test creates a `SessionReceipt` literal — add `merkleRoot: 'def456'` to its `proof` object.

In `attestation.test.ts`, the existing test `generates a signed session receipt` may need updating — verify the `proof` field now includes `merkleRoot`.

**Step 5: Run all attestation tests**

Run: `npx vitest run src/main/stores/attestation-store.test.ts src/main/services/attestation.test.ts`
Expected: All tests PASS.

**Step 6: Commit**

```bash
git add src/main/services/attestation.ts src/main/services/attestation.test.ts src/main/stores/attestation-store.test.ts
git commit -m "feat(attestation): add Merkle root to receipt and inclusion proof generation"
```

---

## Task 6: Build PR Annotator Service

**Files:**
- Create: `src/main/services/pr-annotator.ts`
- Create: `src/main/services/pr-annotator.test.ts`

**Step 1: Write the failing tests**

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/services/pr-annotator.test.ts`
Expected: FAIL — module not found.

**Step 3: Write the implementation**

```typescript
/**
 * @module pr-annotator
 * @description Posts Latch attestation receipts as GitHub PR comments.
 *
 * Parses PR URLs, formats receipt data as a Markdown comment,
 * and posts via the GitHub REST API.
 */

import type { SessionReceipt } from '../../types'

export interface PrUrlParts {
  owner: string
  repo: string
  prNumber: number
}

/** Parse a GitHub PR URL into owner/repo/number. */
export function parsePrUrl(url: string): PrUrlParts | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'github.com') return null
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
    if (!match) return null
    return { owner: match[1], repo: match[2], prNumber: parseInt(match[3], 10) }
  } catch {
    return null
  }
}

/** Format a session receipt as a GitHub PR comment body (Markdown). */
export function formatReceiptComment(receipt: SessionReceipt): string {
  const duration = Math.round(
    (new Date(receipt.enclave.endedAt).getTime() - new Date(receipt.enclave.startedAt).getTime()) / 1000,
  )

  return `## Latch Attestation

This PR was created under Latch policy **\`${receipt.policy.id}\`**, tier **\`${receipt.policy.maxDataTier}\`**.

| Metric | Value |
|--------|-------|
| Network requests | ${receipt.activity.networkRequests} |
| Blocked requests | ${receipt.activity.blockedRequests} |
| Redactions applied | ${receipt.activity.redactionsApplied} |
| Tokenizations applied | ${receipt.activity.tokenizationsApplied} |
| Tool calls | ${receipt.activity.toolCalls} |
| Tool denials | ${receipt.activity.toolDenials} |
| Sandbox | ${receipt.enclave.sandboxType} |
| Duration | ${duration}s |
| Exit | ${receipt.enclave.exitReason} |

<details>
<summary>Cryptographic proof</summary>

- **Merkle root:** \`${receipt.proof.merkleRoot}\`
- **Audit events:** ${receipt.proof.auditEventCount}
- **Signature:** \`${receipt.proof.signature.slice(0, 24)}...\`
- **Public key:** \`${receipt.proof.publicKey.slice(0, 40)}...\`

</details>

---
*Generated by [Latch Desktop](https://github.com/anthropics/latch)*`
}

/**
 * Post an attestation comment on a GitHub PR.
 * Uses the GitHub REST API (no SDK dependency).
 */
export async function annotatePR(
  receipt: SessionReceipt,
  prUrl: string,
  githubToken: string,
): Promise<{ ok: boolean; commentUrl?: string; error?: string }> {
  const parts = parsePrUrl(prUrl)
  if (!parts) return { ok: false, error: `Invalid GitHub PR URL: ${prUrl}` }

  const body = formatReceiptComment(receipt)
  const apiUrl = `https://api.github.com/repos/${parts.owner}/${parts.repo}/issues/${parts.prNumber}/comments`

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ body }),
    })

    if (!response.ok) {
      const text = await response.text()
      return { ok: false, error: `GitHub API ${response.status}: ${text}` }
    }

    const data = await response.json() as { html_url?: string }
    return { ok: true, commentUrl: data.html_url }
  } catch (err: any) {
    return { ok: false, error: `GitHub API error: ${err.message}` }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/services/pr-annotator.test.ts`
Expected: All 6 tests PASS.

**Step 5: Commit**

```bash
git add src/main/services/pr-annotator.ts src/main/services/pr-annotator.test.ts
git commit -m "feat(pr-annotator): GitHub PR attestation comment service"
```

---

## Task 7: Wire AttestationEngine + New IPC Handlers

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

**Step 1: Add AttestationEngine singleton to index.ts**

At the top, add import:
```typescript
import { AttestationEngine } from './services/attestation'
import { annotatePR } from './services/pr-annotator'
```

In the singletons section (around line 84, after `let attestationStore`), add:
```typescript
let attestationEngine: AttestationEngine | null = null
```

In `app.whenReady()`, after `attestationStore = AttestationStore.open(db)`, add:
```typescript
    attestationEngine = new AttestationEngine(attestationStore)
```

**Step 2: Add new IPC handlers after existing attestation handlers (line 592)**

```typescript
  ipcMain.handle('latch:attestation-inclusion-proof', async (_event: any, { sessionId, eventId }: any) => {
    if (!attestationEngine) return { ok: false, error: 'AttestationEngine unavailable' }
    const proof = attestationEngine.generateInclusionProof(sessionId, eventId)
    if (!proof) return { ok: false, error: 'Event not found or no audit log' }
    return { ok: true, proof }
  })

  ipcMain.handle('latch:attestation-annotate-pr', async (_event: any, { sessionId, prUrl }: any) => {
    if (!attestationStore) return { ok: false, error: 'AttestationStore unavailable' }
    const receipt = attestationStore.getReceipt(sessionId)
    if (!receipt) return { ok: false, error: 'No receipt for this session' }

    // Get GitHub token from secrets store
    const tokenRecord = secretStore?.get('service:github')
    if (!tokenRecord) return { ok: false, error: 'No GitHub credential configured' }

    let token: string
    try {
      const parsed = JSON.parse(tokenRecord.value)
      token = parsed.token ?? parsed.apiKey ?? tokenRecord.value
    } catch {
      token = tokenRecord.value
    }

    return annotatePR(receipt, prUrl, token)
  })
```

**Step 3: Add preload methods after existing attestation entries (line 324)**

In `src/preload/index.ts`, after `listProxyAudit`:

```typescript
  getInclusionProof: (payload: { sessionId: string; eventId: string }) =>
    ipcRenderer.invoke('latch:attestation-inclusion-proof', payload),

  annotateGitHubPR: (payload: { sessionId: string; prUrl: string }) =>
    ipcRenderer.invoke('latch:attestation-annotate-pr', payload),
```

**Step 4: Run typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v policy-generator`
Expected: Clean (no errors).

**Step 5: Commit**

```bash
git add src/main/index.ts src/preload/index.ts
git commit -m "feat(ipc): add attestation engine singleton, inclusion proof and PR annotation handlers"
```

---

## Task 8: Build EnclavePanel UI

**Files:**
- Create: `src/renderer/components/panels/EnclavePanel.tsx`
- Modify: `src/renderer/styles.css`

**Step 1: Create EnclavePanel component**

```tsx
import React, { useEffect, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import type { SessionReceipt, ProxyAuditEvent } from '../../../types'

export default function EnclavePanel() {
  const { activeSessionId } = useAppStore()
  const [receipt, setReceipt] = useState<SessionReceipt | null>(null)
  const [events, setEvents] = useState<ProxyAuditEvent[]>([])
  const [prUrl, setPrUrl] = useState('')
  const [annotating, setAnnotating] = useState(false)
  const [annotationResult, setAnnotationResult] = useState<string | null>(null)

  useEffect(() => {
    if (!activeSessionId) return
    window.latch.getAttestation({ sessionId: activeSessionId }).then(res => {
      setReceipt(res.ok ? (res.receipt ?? null) : null)
    })
    window.latch.listProxyAudit({ sessionId: activeSessionId, limit: 100 }).then(res => {
      setEvents(res.ok ? res.events : [])
    })
  }, [activeSessionId])

  const handleAnnotatePR = async () => {
    if (!activeSessionId || !prUrl.trim()) return
    setAnnotating(true)
    setAnnotationResult(null)
    const res = await window.latch.annotateGitHubPR({ sessionId: activeSessionId, prUrl: prUrl.trim() })
    setAnnotationResult(res.ok ? `Posted: ${res.commentUrl}` : `Error: ${res.error}`)
    setAnnotating(false)
  }

  if (!activeSessionId) {
    return <div className="enclave-panel"><p className="text-muted">No active session</p></div>
  }

  return (
    <div className="enclave-panel">
      <h3>Enclave Attestation</h3>

      {receipt ? (
        <>
          <section className="enclave-section">
            <h4>Policy</h4>
            <div className="enclave-grid">
              <span className="text-muted">Policy</span><span>{receipt.policy.id}</span>
              <span className="text-muted">Tier</span><span>{receipt.policy.maxDataTier}</span>
              <span className="text-muted">Sandbox</span><span>{receipt.enclave.sandboxType}</span>
              <span className="text-muted">Exit</span><span>{receipt.enclave.exitReason}</span>
            </div>
          </section>

          <section className="enclave-section">
            <h4>Activity</h4>
            <div className="enclave-grid">
              <span className="text-muted">Requests</span><span>{receipt.activity.networkRequests}</span>
              <span className="text-muted">Blocked</span><span>{receipt.activity.blockedRequests}</span>
              <span className="text-muted">Redactions</span><span>{receipt.activity.redactionsApplied}</span>
              <span className="text-muted">Tokenizations</span><span>{receipt.activity.tokenizationsApplied}</span>
              <span className="text-muted">Tool calls</span><span>{receipt.activity.toolCalls}</span>
              <span className="text-muted">Tool denials</span><span>{receipt.activity.toolDenials}</span>
            </div>
          </section>

          <section className="enclave-section">
            <h4>Proof</h4>
            <div className="enclave-grid">
              <span className="text-muted">Events</span><span>{receipt.proof.auditEventCount}</span>
              <span className="text-muted">Merkle root</span>
              <span className="mono">{receipt.proof.merkleRoot.slice(0, 16)}...</span>
              <span className="text-muted">Signature</span>
              <span className="mono">{receipt.proof.signature.slice(0, 16)}...</span>
            </div>
          </section>

          <section className="enclave-section">
            <h4>PR Annotation</h4>
            <div className="enclave-pr-row">
              <input
                className="input"
                type="text"
                placeholder="https://github.com/owner/repo/pull/123"
                value={prUrl}
                onChange={e => setPrUrl(e.target.value)}
              />
              <button className="btn btn-sm" onClick={handleAnnotatePR} disabled={annotating || !prUrl.trim()}>
                {annotating ? 'Posting...' : 'Annotate'}
              </button>
            </div>
            {annotationResult && <p className="enclave-annotation-result">{annotationResult}</p>}
          </section>
        </>
      ) : (
        <p className="text-muted">No attestation receipt for this session.</p>
      )}

      {events.length > 0 && (
        <section className="enclave-section">
          <h4>Audit Log ({events.length})</h4>
          <div className="enclave-audit-list">
            {events.map(evt => (
              <div key={evt.id} className={`enclave-audit-row ${evt.decision === 'deny' ? 'is-denied' : ''}`}>
                <span className="mono">{evt.method}</span>
                <span>{evt.domain}{evt.path}</span>
                <span className={`badge badge-${evt.decision}`}>{evt.decision}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
```

**Step 2: Add styles to styles.css**

Add at the end of `src/renderer/styles.css`:

```css
/* ─── Enclave Panel ──────────────────────────────────────────────────────── */

.enclave-panel {
  padding: var(--space-3);
  overflow-y: auto;
  height: 100%;
}

.enclave-panel h3 {
  margin: 0 0 var(--space-3) 0;
  font-size: 14px;
  font-weight: 600;
}

.enclave-section {
  margin-bottom: var(--space-3);
}

.enclave-section h4 {
  margin: 0 0 var(--space-2) 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.enclave-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-1) var(--space-3);
  font-size: 12px;
}

.enclave-pr-row {
  display: flex;
  gap: var(--space-2);
}

.enclave-pr-row .input {
  flex: 1;
}

.enclave-annotation-result {
  margin-top: var(--space-1);
  font-size: 11px;
  color: var(--text-secondary);
}

.enclave-audit-list {
  max-height: 300px;
  overflow-y: auto;
  font-size: 11px;
}

.enclave-audit-row {
  display: flex;
  gap: var(--space-2);
  padding: 2px 0;
  border-bottom: 1px solid var(--border);
}

.enclave-audit-row.is-denied {
  color: var(--red);
}

.enclave-audit-row .mono {
  min-width: 60px;
}

.badge-allow { color: var(--green); }
.badge-deny  { color: var(--red); }
```

**Step 3: Run typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v policy-generator`
Expected: Clean.

**Step 4: Commit**

```bash
git add src/renderer/components/panels/EnclavePanel.tsx src/renderer/styles.css
git commit -m "feat(ui): add EnclavePanel with receipt viewer, audit log, and PR annotation"
```

---

## Task 9: Wire EnclavePanel into Rail

**Files:**
- Modify: `src/renderer/components/Rail.tsx`

**Step 1: Add import and tab**

Add import:
```typescript
import EnclavePanel from './panels/EnclavePanel'
```

Add to `TABS` array:
```typescript
  { id: 'enclave', label: 'Enclave' },
```

Add render condition:
```typescript
      {activeRailPanel === 'enclave' && <EnclavePanel />}
```

**Step 2: Run typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v policy-generator`
Expected: Clean.

**Step 3: Commit**

```bash
git add src/renderer/components/Rail.tsx
git commit -m "feat(ui): wire EnclavePanel into Rail tab bar"
```

---

## Task 10: Update Agent Skills

**Files:**
- Modify: `.agents/skills/enclave-attestation/SKILL.md`

**Step 1: Update skill doc with Phase 4 additions**

Add sections covering:
- **Merkle tree** (`src/main/lib/merkle.ts`) — `computeLeafHash`, `buildMerkleRoot`, `buildInclusionProof`, `verifyInclusionProof`, `buildConsistencyProof`. Domain separation with `leaf:` and `node:` prefixes.
- **AttestationStore** new methods — `getLeafHashes`, `getMerkleRoot`, `getInclusionProof`. Schema migration for `leaf_index`.
- **AttestationEngine** new methods — `generateInclusionProof`, `verifyInclusionProof`. Receipt now includes `merkleRoot`.
- **PR Annotator** (`src/main/services/pr-annotator.ts`) — `parsePrUrl`, `formatReceiptComment`, `annotatePR`.
- **LatchProxy wiring** — `attestationStore` config option, events now persisted to SQLite.
- **IPC handlers** — `latch:attestation-inclusion-proof`, `latch:attestation-annotate-pr`.
- **EnclavePanel** — receipt viewer, audit log, PR annotation UI.
- **Test files** — `merkle.test.ts`, `pr-annotator.test.ts`, updated `attestation-store.test.ts`, `attestation.test.ts`.

**Step 2: Commit**

```bash
git add .agents/skills/enclave-attestation/SKILL.md
git commit -m "docs(skills): update enclave-attestation skill for Phase 4 Merkle + PR annotation"
```

---

## Task 11: Full Test Suite Verification

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests pass except the 4 pre-existing `radar.test.ts` failures.

**Step 2: Run typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v policy-generator`
Expected: Clean (no errors).

**Step 3: Report results**

Report total test count, new tests added, commit count, and any issues.
