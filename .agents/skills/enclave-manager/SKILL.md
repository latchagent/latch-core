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
- **CA cert trust (Phase 2)**: When `caCertPath` is provided in `EnclaveEnvInput`, sets three environment variables so the sandbox trusts the session's ephemeral CA for TLS interception:
  - `NODE_EXTRA_CA_CERTS` — trusted by Node.js processes
  - `SSL_CERT_FILE` — trusted by OpenSSL-based tools (curl, Python requests, etc.)
  - `GIT_SSL_CAINFO` — trusted by git for HTTPS operations
- **Service env vars**: Resolves `${credential.fieldName}` placeholders with actual credential values from the credentials map
- Only sets env vars where ALL credential placeholders were resolved

### 2. Backend Detection (`detectBackend`)
Detects available sandbox backends using a selection cascade:
1. **Docker** — checks `docker info` (works on all platforms)
2. **Seatbelt** (macOS only) — checks `which sandbox-exec`
3. **Bubblewrap** (Linux only) — checks `which bwrap`
4. Returns `null` if no backend available (session must be rejected)

Returns a `SandboxBackend` value: `'docker' | 'seatbelt' | 'bubblewrap'`

## Design Principle

**No sandbox = no session.** The enclave is mandatory — if no sandbox backend is detected, the session must not start.

## Phase 3: Native Sandbox Backends

Phase 3 adds macOS Seatbelt and Linux Bubblewrap sandbox backends so sessions can run in native OS sandboxes without Docker. A unified `SandboxManager` routes to the best available backend.

### Sandbox Backends

| Backend | Platform | File | Binary | Network Isolation |
|---------|----------|------|--------|-------------------|
| SeatbeltEnclave | macOS | `src/main/lib/sandbox/seatbelt-enclave.ts` | `sandbox-exec` | `pf` (packet filter) rules |
| BubblewrapEnclave | Linux | `src/main/lib/sandbox/bubblewrap-enclave.ts` | `bwrap` | `iptables` rules |

- **SeatbeltEnclave** generates a Seatbelt sandbox profile that denies all network except the proxy port on loopback, denies filesystem access except the workspace, and denies process-exec except the shell. `pf` rules force all TCP traffic through the proxy.
- **BubblewrapEnclave** builds `bwrap` arguments that mount a minimal root with the workspace at `/workspace`, deny access to the host home and sensitive dirs, and use PID namespace isolation. `iptables` rules force network traffic through the proxy.

### SandboxManager (`src/main/lib/sandbox/sandbox-manager.ts`)

Unified lifecycle manager that wraps all backends behind a common interface:
- **`detectBestBackend()`** — runs the Docker > Seatbelt > Bubblewrap > refuse cascade and returns `{ backend, detection }` with availability details for each
- **`getAvailableBackends()`** — returns a map of all backends with `{ available, version?, reason? }` for each
- **`getSessionStatus(sessionId)`** — returns the sandbox status, backend, and process ID for a running session
- Delegates start/stop/status operations to the appropriate backend

### PtyManager Integration

`PtyManager.create()` (`src/main/lib/pty-manager.ts`) now accepts two new options for native sandbox backends:
- **`sandboxCommand`** — the sandbox binary to use (e.g., `'sandbox-exec'` or `'bwrap'`)
- **`sandboxArgs`** — arguments to pass before the shell command

Command selection logic in `create()`:
1. If `dockerContainerId` is set: `docker exec -it <id> /bin/sh`
2. If `sandboxCommand` + `sandboxArgs` are set: `<sandboxCommand> <sandboxArgs...>`
3. Otherwise: local shell (no sandbox)

### IPC Handlers

Two new IPC handlers expose sandbox state to the renderer:

| Handler | Purpose | Return shape |
|---------|---------|-------------|
| `latch:sandbox-detect` | Discover available backends | `{ ok, backends: Record<string, { available, version?, reason? }>, best: string \| null }` |
| `latch:sandbox-status` | Get sandbox status for a session | `{ ok, status: string \| null, backend: string \| null, processId: string \| null }` |

Exposed via preload as `window.latch.sandboxDetect()` and `window.latch.sandboxStatus({ sessionId })`.

## Architecture Notes

- Static methods (no instance state) — used as utilities during session setup
- Credential substitution handles multi-field credentials (e.g., AWS with accessKeyId + secretAccessKey)
- Proxy port is dynamic (assigned at runtime by LatchProxy)
- `EnclaveEnvInput` accepts an optional `caCertPath` parameter (from `LatchProxy.getCaCertPath()`) for TLS interception support
- EnclaveManager does NOT start the sandbox — that's handled by `docker-manager.ts` (Docker backend) or by the native sandbox backends (`SeatbeltEnclave`, `BubblewrapEnclave`) via `SandboxManager`
- `SandboxManager` is instantiated in the main process (`src/main/index.ts`) and receives a `sendToRenderer` callback for feed updates

## Testing

Tests: `src/main/lib/enclave-manager.test.ts`
Run: `npx vitest run src/main/lib/enclave-manager.test.ts`

Phase 3 backend tests:
- `src/main/lib/sandbox/seatbelt-enclave.test.ts` (6 tests)
- `src/main/lib/sandbox/bubblewrap-enclave.test.ts` (6 tests)
- `src/main/lib/sandbox/sandbox-manager.test.ts` (5 tests)
