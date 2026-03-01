---
name: enclave-attestation
description: Audit logging and session attestation for the Latch Enclave. Covers hash-chained proxy audit events, session receipts, and tamper-evident logging. Use when working on audit trails, session receipts, compliance proofs, or the attestation engine.
---

# Attestation System

The attestation system consists of two modules:
- **AttestationStore** (`src/main/stores/attestation-store.ts`) — SQLite persistence for audit events and receipts
- **AttestationEngine** (`src/main/services/attestation.ts`) — Ed25519 signing and receipt generation

## AttestationStore

SQLite store following the `static open()` + `_init()` pattern. Two tables:

### proxy_audit_log
Stores every proxy request decision with hash chaining for tamper evidence.
- Each event's hash = SHA-256(prevHash + eventJSON)
- Hash chain is per-session

### session_receipts
Stores signed session receipts (JSON blobs) keyed by session_id.

### Key API

- `recordEvent(event)` — Insert an audit event with automatic hash chaining
- `listEvents(sessionId, limit?)` — Return audit events in chronological order
- `getHashChain(sessionId)` — Return the latest hash in the chain (for receipt proof)
- `getEventCount(sessionId)` — Count of audit events for a session
- `saveReceipt(receipt)` — Save a signed SessionReceipt
- `getReceipt(sessionId)` — Retrieve a session receipt

## Testing

Tests: `src/main/stores/attestation-store.test.ts`
Run: `npx vitest run src/main/stores/attestation-store.test.ts`
