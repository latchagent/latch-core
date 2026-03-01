# Enclave Bubblewrap (Linux)

## What This Module Does

The Bubblewrap Enclave (`src/main/lib/sandbox/bubblewrap-enclave.ts`) provides a native Linux sandbox backend using `bwrap` (bubblewrap) and `iptables`. It uses unprivileged user namespaces for filesystem and PID isolation.

## bwrap Configuration

Per-session with minimal root:
- **Filesystem:** Read-only /usr, /lib, /bin, /sbin, /etc. Read-write workspace at /workspace. Isolated /tmp via tmpfs.
- **PID Namespace:** --unshare-pid for process isolation
- **Proc:** /proc/self/environ bound to /dev/null (blocks credential extraction)
- **Home:** tmpfs (minimal, no host home access)
- **Lifecycle:** --die-with-parent ensures sandbox dies if Latch exits

## iptables Rules

Network forcing rules (require root/sudo):
- Redirect outbound TCP from sandbox UID to proxy port
- Block UDP/53 (DNS exfiltration prevention)
- Allow loopback to proxy and authz ports
- Drop all other outbound

## Key API

- `buildBwrapArgs(opts)` — Generate bwrap CLI arguments
- `generateIptablesRules(opts)` — Create iptables rule set
- `generateIptablesCleanup(opts)` — Create iptables cleanup commands
- `detect()` — Check if bwrap is available (Linux only)

## Testing

Run: `npx vitest run src/main/lib/sandbox/bubblewrap-enclave.test.ts`
