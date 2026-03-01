# Enclave Seatbelt (macOS)

## What This Module Does

The Seatbelt Enclave (`src/main/lib/sandbox/seatbelt-enclave.ts`) provides a native macOS sandbox backend using `sandbox-exec` and `pf` (packet filter). It runs agent shells inside a Seatbelt profile that denies all access except explicitly allowed operations.

## Seatbelt Profile

Generated per-session with deny-by-default:
- **Filesystem:** Only workspace directory, /tmp, and system libraries
- **Network:** Only loopback to proxy and authz ports — all other network denied
- **Process:** Only shell binary and /usr/bin, /bin utilities
- **Blocked:** ~/.ssh, ~/.gnupg, ~/.aws, shell history files

## pf Rules

Network forcing rules redirect all outbound TCP from the sandbox to the proxy port and block UDP/53 (DNS exfiltration prevention). Applied via `pfctl`.

## Key API

- `generateProfile(opts)` — Create Seatbelt .sb profile
- `generatePfRules(opts)` — Create pf rule set
- `buildSpawnArgs(opts)` — Get command + args for `sandbox-exec -f profile.sb /bin/sh`
- `writeProfile(profile)` — Write to temp file, returns path
- `detect()` — Check if sandbox-exec is available (macOS only)
- `destroy()` — Clean up temp files

## Testing

Run: `npx vitest run src/main/lib/sandbox/seatbelt-enclave.test.ts`
