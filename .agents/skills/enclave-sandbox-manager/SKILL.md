# Enclave Sandbox Manager

## What This Module Does

The Sandbox Manager (`src/main/lib/sandbox/sandbox-manager.ts`) implements unified backend selection and lifecycle for enclave sessions.

## Selection Cascade

```
1. Docker available?     → DockerEnclave
2. macOS sandbox-exec?   → SeatbeltEnclave
3. Linux bwrap?          → BubblewrapEnclave
4. None?                 → REFUSE (no sandbox = no session)
```

## Key API

- `detectBestBackend()` — Returns best available backend using cascade
- `getAvailableBackends()` — Returns detection results for all three backends
- `registerSession(sessionId, backend, processId)` — Track active session
- `unregisterSession(sessionId)` — Remove session tracking
- `getSessionStatus(sessionId)` — Get sandbox status for a session
- `getDockerManager()` — Access underlying Docker manager
- `getSeatbeltEnclave()` — Access Seatbelt backend
- `getBubblewrapEnclave()` — Access Bubblewrap backend
- `disposeAll()` — Clean up all sessions on app quit

## Testing

Run: `npx vitest run src/main/lib/sandbox/sandbox-manager.test.ts`
