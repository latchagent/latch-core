---
name: enclave-manager
description: Manages enclave sandbox lifecycle and environment configuration for Latch sessions. Builds proxy-routed environments with credential injection, detects sandbox backends (Docker/Seatbelt/bubblewrap). Use when working on session sandbox setup, environment configuration, or enclave security hardening.
---

# Enclave Manager

The EnclaveManager class lives at `src/main/lib/enclave-manager.ts` and handles sandbox lifecycle for enclave sessions.

## Core Responsibilities

### 1. Environment Building (`buildEnclaveEnv`)
Constructs the full environment variable set for an enclave session:

- **Proxy routing**: Sets `HTTP_PROXY`, `HTTPS_PROXY` (and lowercase variants) to route all traffic through the Latch Proxy
- **NO_PROXY**: Explicitly set to empty string to prevent bypass
- **Latch metadata**: `LATCH_ENCLAVE=true`, `LATCH_SESSION_ID`
- **Security hardening**: `HISTFILE=/dev/null` to prevent shell history leaks
- **Service env vars**: Resolves `${credential.fieldName}` placeholders with actual credential values from the credentials map
- Only sets env vars where ALL credential placeholders were resolved

### 2. Backend Detection (`detectBackend`)
Detects available sandbox backends:
- Phase 1: Docker only (checks `docker info`)
- Phase 3: Seatbelt (macOS), bubblewrap (Linux)
- Returns null if no backend available (session should be rejected)

## Design Principle

**No sandbox = no session.** The enclave is mandatory — if no sandbox backend is detected, the session must not start.

## Architecture Notes

- Static methods (no instance state) — used as utilities during session setup
- Credential substitution handles multi-field credentials (e.g., AWS with accessKeyId + secretAccessKey)
- Proxy port is dynamic (assigned at runtime by LatchProxy)
- EnclaveManager does NOT start the sandbox — that's handled by docker-manager.ts

## Testing

Tests: `src/main/lib/enclave-manager.test.ts`
Run: `npx vitest run src/main/lib/enclave-manager.test.ts`
