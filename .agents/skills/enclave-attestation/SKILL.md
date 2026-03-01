---
name: enclave-attestation
description: Audit logging and session attestation for the Latch Enclave. Covers hash-chained proxy audit events, Merkle tree proofs, session receipts, PR annotations, and tamper-evident logging. Use when working on audit trails, session receipts, compliance proofs, inclusion proofs, PR annotation, or the attestation engine.
---

# Attestation System

The attestation system consists of the following modules:

- **AttestationStore** (`src/main/stores/attestation-store.ts`) — SQLite persistence for audit events and receipts, with Merkle tree queries
- **AttestationEngine** (`src/main/services/attestation.ts`) — Ed25519 signing, receipt generation, and inclusion proof orchestration
- **Merkle Tree** (`src/main/lib/merkle.ts`) — Binary Merkle tree with domain-separated hashing
- **PR Annotator** (`src/main/services/pr-annotator.ts`) — Posts attestation receipts as GitHub PR comments
- **EnclavePanel** (`src/renderer/components/panels/EnclavePanel.tsx`) — UI for viewing receipts, audit logs, and annotating PRs

---

## Merkle Tree (`src/main/lib/merkle.ts`)

Binary Merkle tree utility used to produce tamper-evident roots and inclusion proofs over audit event logs.

### Domain separation

All hashes use domain-separation prefixes to prevent second-preimage attacks:

- **Leaf hashes** are prefixed with `leaf:` — `SHA-256("leaf:" + eventJson)`
- **Inner node hashes** are prefixed with `node:` — `SHA-256("node:" + left + right)`

This ensures an inner node hash can never collide with a valid leaf hash.

### Padding

When the number of leaves is not a power of 2, the array is padded to the next power of 2 using `computeLeafHash('')` (the hash of an empty-string leaf).

### Key functions

- `computeLeafHash(eventJson)` — Returns a 64-char hex SHA-256 digest with `leaf:` prefix.
- `buildMerkleRoot(leafHashes)` — Builds the Merkle root from an array of leaf hashes. Returns `null` for empty input. For a single leaf, returns the leaf hash itself.
- `buildInclusionProof(leafHashes, index)` — Builds an inclusion proof (sibling hashes from leaf to root) for the leaf at the given index. Returns a `MerkleProof` or `null` for out-of-bounds.
- `verifyInclusionProof(proof)` — Recomputes the root from the leaf hash + sibling hashes and checks it matches `proof.root`. Returns `boolean`.
- `buildConsistencyProof(oldLeaves, newLeaves)` — Builds a consistency proof showing the old log is a prefix of the new log. Returns a `ConsistencyProof` or `null`.

---

## AttestationStore (`src/main/stores/attestation-store.ts`)

SQLite store following the `static open()` + `_init()` pattern. Two tables:

### proxy_audit_log

Stores every proxy request decision with hash chaining for tamper evidence.

- Each event's hash = SHA-256(prevHash + eventJSON)
- Hash chain is per-session
- **Schema migration**: `leaf_index INTEGER` column added via `ALTER TABLE ... ADD COLUMN` with try/catch for idempotent migration. Tracks the sequential position of each event within its session for Merkle tree indexing.

### session_receipts

Stores signed session receipts (JSON blobs) keyed by session_id.

### Key API

- `recordEvent(event)` — Insert an audit event with automatic hash chaining. Computes `leaf_index` as the next sequential index for the session.
- `listEvents(sessionId, limit?)` — Return audit events in chronological order
- `getHashChain(sessionId)` — Return the latest hash in the chain (for receipt proof)
- `getEventCount(sessionId)` — Count of audit events for a session
- `getLeafHashes(sessionId)` — Returns ordered leaf hashes (via `computeLeafHash`) for all audit events in the session, ordered by `leaf_index ASC`. Used as input to Merkle tree construction.
- `getMerkleRoot(sessionId)` — Computes the Merkle root over all audit events for a session. Delegates to `getLeafHashes` then `buildMerkleRoot`. Returns `null` for sessions with no events.
- `getInclusionProof(sessionId, eventId)` — Looks up the event's `leaf_index`, fetches all leaf hashes, and calls `buildInclusionProof`. Returns `MerkleProof | null`.
- `saveReceipt(receipt)` — Save a signed SessionReceipt
- `getReceipt(sessionId)` — Retrieve a session receipt

---

## AttestationEngine (`src/main/services/attestation.ts`)

Ed25519 signing engine that generates and verifies session receipts. Keys are ephemeral per `AttestationEngine` instance (typically per app lifecycle).

### Receipt generation

`generateReceipt(input)` produces a `SessionReceipt` containing:

- Policy metadata (id, SHA-256 hash of policy document, data tier, services)
- Activity counters (requests, blocks, redactions, tokenizations, tool calls, denials)
- Enclave metadata (sandbox type, timestamps, exit reason)
- **Proof section**: `auditEventCount`, `auditHashChain`, `merkleRoot`, Ed25519 `signature`, `publicKey`

The `merkleRoot` is computed at receipt generation time via `store.getMerkleRoot(sessionId)`.

### Inclusion proofs

- `generateInclusionProof(sessionId, eventId)` — Delegates to `store.getInclusionProof()`. Returns a `MerkleProof` that proves a specific audit event is included in the session's Merkle tree.
- `verifyInclusionProof(proof)` — Delegates to the Merkle module's `verifyInclusionProof()`. Returns `boolean`.

### Receipt verification

`verifyReceipt(receipt)` reconstructs the signed payload (with signature field blanked) and verifies the Ed25519 signature using the embedded public key.

---

## PR Annotator (`src/main/services/pr-annotator.ts`)

Posts Latch attestation receipts as GitHub PR comments via the GitHub REST API (no SDK dependency).

### Key functions

- `parsePrUrl(url)` — Parses a GitHub PR URL (`https://github.com/owner/repo/pull/123`) into `{ owner, repo, prNumber }`. Returns `null` for non-GitHub or malformed URLs.
- `formatReceiptComment(receipt)` — Formats a `SessionReceipt` as a Markdown comment body with:
  - Header: `## Latch Attestation` with policy ID and data tier
  - **Metrics table**: network requests, blocked requests, redactions, tokenizations, tool calls, tool denials, sandbox type, duration, exit reason
  - **Collapsible proof section** (`<details>`): Merkle root, audit event count, truncated signature and public key
  - Footer linking to Latch Desktop
- `annotatePR(receipt, prUrl, githubToken)` — Posts the formatted comment to the GitHub PR. Returns `{ ok, commentUrl?, error? }`. Uses the Issues API endpoint (`/repos/:owner/:repo/issues/:prNumber/comments`) with Bearer token auth.

---

## LatchProxy wiring

The `LatchProxy` class (`src/main/services/latch-proxy.ts`) accepts an optional `attestationStore` in its config:

```ts
interface LatchProxyConfig {
  // ... other options
  attestationStore?: AttestationStore
}
```

When `attestationStore` is provided, every audit event recorded by the private `_recordAudit()` method is also persisted to SQLite:

```ts
this.config.attestationStore?.recordEvent(this.auditLog[this.auditLog.length - 1])
```

This bridges the in-memory proxy audit log to the persistent attestation store, enabling Merkle proofs and receipts to cover all proxy decisions.

---

## IPC handlers

Two new IPC handlers registered in `src/main/index.ts`:

### `latch:attestation-inclusion-proof`

- **Payload**: `{ sessionId: string, eventId: string }`
- **Response**: `{ ok: boolean, proof?: MerkleProof, error?: string }`
- Delegates to `attestationEngine.generateInclusionProof()`

### `latch:attestation-annotate-pr`

- **Payload**: `{ sessionId: string, prUrl: string }`
- **Response**: `{ ok: boolean, commentUrl?: string, error?: string }`
- Retrieves the receipt from `attestationStore`, the GitHub token from `secretStore.resolve('service:github')`, then calls `annotatePR()`

Preload bridge (`src/preload/index.ts`):

```ts
getInclusionProof: (payload) => ipcRenderer.invoke('latch:attestation-inclusion-proof', payload)
annotateGitHubPR: (payload) => ipcRenderer.invoke('latch:attestation-annotate-pr', payload)
```

---

## EnclavePanel (`src/renderer/components/panels/EnclavePanel.tsx`)

React panel wired into `Rail.tsx` as the `'enclave'` tab. Displays attestation data for the active session.

### Sections

1. **Policy** — Shows policy ID, data tier, sandbox type, exit reason from the receipt
2. **Activity** — Network requests, blocked, redactions, tokenizations, tool calls, tool denials
3. **Proof** — Audit event count, truncated Merkle root, truncated signature
4. **PR Annotation** — Text input for a GitHub PR URL + "Annotate" button. Posts the receipt as a PR comment via `window.latch.annotateGitHubPR()`. Shows result/error inline.
5. **Audit Log** — Scrollable list of `ProxyAuditEvent` entries, each showing method, domain+path, and a colored decision badge (`allow`/`deny`)

### Data fetching

On `activeSessionId` change, fetches:
- `window.latch.getAttestation({ sessionId })` for the receipt
- `window.latch.listProxyAudit({ sessionId, limit: 100 })` for the audit log

---

## Types (`src/types/index.ts`)

### MerkleProof

```ts
export interface MerkleProof {
  leafIndex: number
  leafHash: string
  siblings: string[]
  root: string
}
```

### ConsistencyProof

```ts
export interface ConsistencyProof {
  fromSize: number
  toSize: number
  fromRoot: string
  toRoot: string
  proof: string[]
}
```

### LatchAPI additions

```ts
getInclusionProof(payload: { sessionId: string; eventId: string }):
  Promise<{ ok: boolean; proof?: MerkleProof; error?: string }>

annotateGitHubPR(payload: { sessionId: string; prUrl: string }):
  Promise<{ ok: boolean; commentUrl?: string; error?: string }>
```

---

## Testing

### Merkle tree — `src/main/lib/merkle.test.ts` (13 tests)

Run: `npx vitest run src/main/lib/merkle.test.ts`

Covers: `computeLeafHash` hex format, domain separation vs raw SHA-256, `buildMerkleRoot` (empty, single, multiple, determinism, sensitivity to leaf changes), `buildInclusionProof` (out-of-bounds, valid proof for each leaf), `verifyInclusionProof` (valid proof, tampered proof), non-power-of-2 leaf counts, `buildConsistencyProof` between two sizes.

### PR Annotator — `src/main/services/pr-annotator.test.ts` (6 tests)

Run: `npx vitest run src/main/services/pr-annotator.test.ts`

Covers: `parsePrUrl` valid extraction, `parsePrUrl` invalid URLs, `formatReceiptComment` includes policy ID, activity metrics, Merkle root, sandbox type.

### AttestationStore — `src/main/stores/attestation-store.test.ts` (10 tests, +6 new)

Run: `npx vitest run src/main/stores/attestation-store.test.ts`

New tests cover: `leaf_index` tracking per event, `getMerkleRoot` returning null for empty session, `getMerkleRoot` returning 64-char hex, `getMerkleRoot` sensitivity to different events, `getInclusionProof` returning valid proof with correct `leafIndex` and root, `getInclusionProof` returning null for missing event.

### AttestationEngine — `src/main/services/attestation.test.ts` (6 tests, +3 new)

Run: `npx vitest run src/main/services/attestation.test.ts`

New tests cover: receipt includes `merkleRoot` in proof (64-char hex), `merkleRoot` matches store computation, `generateInclusionProof` + `verifyInclusionProof` round-trip for a specific event.

### Run all attestation tests

```bash
npx vitest run src/main/lib/merkle.test.ts src/main/stores/attestation-store.test.ts src/main/services/attestation.test.ts src/main/services/pr-annotator.test.ts
```
