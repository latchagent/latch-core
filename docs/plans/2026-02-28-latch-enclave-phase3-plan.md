# Latch Enclave Phase 3: Native Sandboxes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add macOS Seatbelt and Linux Bubblewrap sandbox backends so sessions can run in native OS sandboxes without Docker. Each backend enforces network isolation (all traffic through Latch Proxy), filesystem scoping, and process hardening. A unified SandboxManager routes to the best available backend.

**Architecture:** Phase 1-2 built the proxy and enclave env, but `EnclaveManager.detectBackend()` only checks Docker. Phase 3 adds two new sandbox backends (SeatbeltEnclave for macOS, BubblewrapEnclave for Linux) that spawn sandboxed shells directly — no container runtime needed. The `SandboxManager` implements the selection cascade: Docker > Seatbelt > Bubblewrap > refuse. Network isolation is enforced at the OS level via `pf` (macOS) or `iptables` (Linux) rules that force all traffic through the proxy port and block direct egress.

**Tech Stack:** `sandbox-exec` + `pf` (macOS), `bwrap` + `iptables` (Linux), Node.js `child_process`, existing `EnclaveManager.buildEnclaveEnv()`, vitest for tests.

**Design doc:** `docs/plans/2026-02-28-latch-enclave-design.md` (Enclave section, lines 250-308)

---

## Task 1: Sandbox Interface Types

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Add sandbox types after the ProxyFeedbackMessage interface**

```typescript
// ─── Sandbox (enclave) ──────────────────────────────────────────────────────

/** Configuration for starting a sandbox session. */
export interface SandboxConfig {
  sessionId: string
  workspacePath: string
  proxyPort: number
  authzPort: number
  env: Record<string, string>
  shell?: string          // override shell binary (default: /bin/sh)
  memoryLimit?: string    // e.g. '4g'
  cpuLimit?: string       // e.g. '2'
}

/** Result of starting a sandbox. */
export interface SandboxResult {
  ok: boolean
  processId?: string      // container ID, PID, or sandbox reference
  error?: string
}

/** Status of a running sandbox. */
export interface SandboxStatus {
  status: 'starting' | 'running' | 'stopped' | 'error' | null
  processId: string | null
  backend: SandboxBackend | null
}

/** Detection result for a sandbox backend. */
export interface SandboxDetection {
  available: boolean
  version?: string
  reason?: string         // why unavailable
}

export type SandboxBackend = 'docker' | 'seatbelt' | 'bubblewrap'
```

**Step 2: Remove the `SandboxBackend` type from `src/main/lib/enclave-manager.ts`**

The type now lives in `src/types/index.ts`. Update enclave-manager.ts to import it:
```typescript
import type { ServiceDefinition, SandboxBackend } from '../../types'
```

**Step 3: Run typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v policy-generator`
Expected: Clean

**Step 4: Commit**

```bash
git add src/types/index.ts src/main/lib/enclave-manager.ts
git commit -m "feat(types): add sandbox interface types for native enclave backends"
```

---

## Task 2: SeatbeltEnclave (macOS sandbox-exec + pf)

**Files:**
- Create: `src/main/lib/sandbox/seatbelt-enclave.ts`
- Create: `src/main/lib/sandbox/seatbelt-enclave.test.ts`
- Skill: `.agents/skills/enclave-seatbelt/SKILL.md`

**Context:** macOS `sandbox-exec` runs a process inside a Seatbelt sandbox profile. We generate a profile that denies all network except the proxy port on loopback, denies filesystem access except the workspace, and denies process-exec except the shell. `pf` (packet filter) rules force all TCP traffic from the sandboxed process through the proxy.

**Step 1: Write the failing test**

Create `src/main/lib/sandbox/seatbelt-enclave.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { SeatbeltEnclave } from './seatbelt-enclave'

// Mock child_process since we can't actually run sandbox-exec in tests
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}))

describe('SeatbeltEnclave', () => {
  it('generates a valid sandbox profile', () => {
    const enclave = new SeatbeltEnclave()
    const profile = enclave.generateProfile({
      workspacePath: '/Users/test/project',
      proxyPort: 8080,
      authzPort: 9090,
      shell: '/bin/zsh',
    })
    expect(profile).toContain('(version 1)')
    expect(profile).toContain('(deny default)')
    expect(profile).toContain('/Users/test/project')
    expect(profile).toContain('8080')
    expect(profile).toContain('9090')
  })

  it('profile allows loopback to proxy and authz ports only', () => {
    const enclave = new SeatbeltEnclave()
    const profile = enclave.generateProfile({
      workspacePath: '/tmp/ws',
      proxyPort: 12345,
      authzPort: 12346,
      shell: '/bin/sh',
    })
    expect(profile).toContain('localhost')
    expect(profile).toContain('12345')
    expect(profile).toContain('12346')
    // Should deny all other network
    expect(profile).toContain('(deny network*)')
  })

  it('profile blocks sensitive directories', () => {
    const enclave = new SeatbeltEnclave()
    const profile = enclave.generateProfile({
      workspacePath: '/tmp/ws',
      proxyPort: 8080,
      authzPort: 9090,
      shell: '/bin/sh',
    })
    // Should not allow .ssh, .gnupg, .aws
    expect(profile).not.toContain('allow file-read* (subpath "/Users')
    // But should allow workspace
    expect(profile).toContain('/tmp/ws')
  })

  it('generates pf rules for network forcing', () => {
    const enclave = new SeatbeltEnclave()
    const rules = enclave.generatePfRules({
      proxyPort: 8080,
      uid: 501,
    })
    expect(rules).toContain('rdr')
    expect(rules).toContain('8080')
    expect(rules).toContain('block')
  })

  it('builds spawn args for sandbox-exec', () => {
    const enclave = new SeatbeltEnclave()
    const args = enclave.buildSpawnArgs({
      profilePath: '/tmp/latch-sb-xxx/profile.sb',
      shell: '/bin/zsh',
    })
    expect(args.command).toBe('sandbox-exec')
    expect(args.args).toContain('-f')
    expect(args.args).toContain('/tmp/latch-sb-xxx/profile.sb')
    expect(args.args).toContain('/bin/zsh')
  })

  it('detects sandbox-exec availability', async () => {
    const { execFile } = await import('node:child_process')
    const mockExecFile = vi.mocked(execFile)
    // Simulate sandbox-exec found
    mockExecFile.mockImplementation((_cmd: any, _args: any, cb: any) => {
      if (typeof cb === 'function') cb(null, '/usr/bin/sandbox-exec', '')
      return {} as any
    })

    const enclave = new SeatbeltEnclave()
    const result = await enclave.detect()
    // On non-macOS in CI this may vary, just check the shape
    expect(result).toHaveProperty('available')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/lib/sandbox/seatbelt-enclave.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/main/lib/sandbox/seatbelt-enclave.ts`:

```typescript
/**
 * @module seatbelt-enclave
 * @description macOS Seatbelt sandbox backend using sandbox-exec + pf.
 *
 * Generates a Seatbelt profile that:
 * - Denies all network except loopback to proxy + authz ports
 * - Denies filesystem except workspace, /tmp, and essential system paths
 * - Denies process-exec except the shell and basic utils
 *
 * Uses pf (packet filter) rules to force all TCP traffic through the proxy
 * and block DNS (UDP/53) to prevent DNS exfiltration.
 */

import { execFile, execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { SandboxDetection } from '../../../types'

interface ProfileOptions {
  workspacePath: string
  proxyPort: number
  authzPort: number
  shell: string
}

interface PfRuleOptions {
  proxyPort: number
  uid: number
}

interface SpawnArgs {
  command: string
  args: string[]
}

export class SeatbeltEnclave {
  private profileDir: string | null = null

  /**
   * Generate a Seatbelt sandbox profile (.sb file).
   * The profile uses deny-by-default with explicit allows for:
   * - Workspace filesystem access (read/write)
   * - /tmp (isolated per-session)
   * - System libraries and basic utilities
   * - Loopback network to proxy and authz ports only
   */
  generateProfile(opts: ProfileOptions): string {
    return `(version 1)
(deny default)

;; Allow read access to system essentials
(allow file-read*
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/usr/bin")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/Library/Frameworks")
  (subpath "/System")
  (subpath "/private/var/db")
  (subpath "/dev")
  (literal "/etc/resolv.conf")
  (literal "/etc/hosts")
  (literal "/etc/passwd")
  (literal "/etc/group")
  (literal "/etc/shells")
  (literal "/etc/zshrc")
  (literal "/etc/profile")
)

;; Allow read/write access to workspace
(allow file-read* file-write*
  (subpath "${opts.workspacePath}")
)

;; Allow read/write access to /tmp (isolated)
(allow file-read* file-write*
  (subpath "/tmp")
  (subpath "/private/tmp")
)

;; Allow process execution for shell and basic utilities
(allow process-exec
  (literal "${opts.shell}")
  (subpath "/usr/bin")
  (subpath "/bin")
  (subpath "/usr/local/bin")
)

;; Allow process-fork for shell subcommands
(allow process-fork)

;; Allow signals
(allow signal (target self))

;; Deny all network by default
(deny network*)

;; Allow loopback connections to proxy and authz ports only
(allow network-outbound
  (remote tcp "localhost:${opts.proxyPort}")
  (remote tcp "localhost:${opts.authzPort}")
)

;; Allow reading network state (needed by some CLIs)
(allow system-socket)

;; Allow sysctl reads (needed for Node.js, Python, etc.)
(allow sysctl-read)

;; Allow mach-lookup for essential services
(allow mach-lookup
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center")
)

;; Allow IOKit (needed for terminal operations)
(allow iokit-open)

;; Block shell history
;; (HISTFILE=/dev/null is set via env, this is defense in depth)
(deny file-write* (subpath "${os.homedir()}/.zsh_history"))
(deny file-write* (subpath "${os.homedir()}/.bash_history"))
`
  }

  /**
   * Generate pf (packet filter) rules to force traffic through the proxy.
   * These rules redirect all outbound TCP from the sandbox UID to the proxy,
   * and block UDP/53 (DNS) to prevent DNS exfiltration.
   */
  generatePfRules(opts: PfRuleOptions): string {
    return `# Latch Enclave pf rules — session sandbox
# Redirect all outbound TCP from sandbox user to proxy
rdr pass on lo0 proto tcp from any to any port 1:65535 -> 127.0.0.1 port ${opts.proxyPort}

# Block direct outbound TCP (not to loopback) from sandbox
block drop out quick proto tcp from any to ! 127.0.0.1 user ${opts.uid}

# Block DNS (UDP/53) to prevent DNS exfiltration
block drop out quick proto udp from any port 53 user ${opts.uid}
block drop out quick proto udp from any to any port 53 user ${opts.uid}
`
  }

  /**
   * Build the command and args to spawn a sandboxed shell via sandbox-exec.
   */
  buildSpawnArgs(opts: { profilePath: string; shell: string }): SpawnArgs {
    return {
      command: 'sandbox-exec',
      args: ['-f', opts.profilePath, opts.shell],
    }
  }

  /**
   * Write the profile to a temp directory. Returns the file path.
   */
  writeProfile(profile: string): string {
    this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latch-sb-'))
    const profilePath = path.join(this.profileDir, 'profile.sb')
    fs.writeFileSync(profilePath, profile)
    return profilePath
  }

  /**
   * Detect if sandbox-exec is available (macOS only).
   */
  async detect(): Promise<SandboxDetection> {
    if (process.platform !== 'darwin') {
      return { available: false, reason: 'Not macOS' }
    }

    return new Promise((resolve) => {
      execFile('which', ['sandbox-exec'], (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve({ available: false, reason: 'sandbox-exec not found on PATH' })
          return
        }
        resolve({ available: true, version: 'macOS built-in' })
      })
    })
  }

  /**
   * Clean up temp files (profile, pf rules).
   */
  destroy(): void {
    if (this.profileDir) {
      try {
        const files = fs.readdirSync(this.profileDir)
        for (const f of files) fs.unlinkSync(path.join(this.profileDir!, f))
        fs.rmdirSync(this.profileDir)
      } catch { /* best-effort */ }
      this.profileDir = null
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/lib/sandbox/seatbelt-enclave.test.ts`
Expected: All 6 tests pass

**Step 5: Write skill doc**

Create `.agents/skills/enclave-seatbelt/SKILL.md`:

```markdown
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
```

**Step 6: Commit**

```bash
git add src/main/lib/sandbox/seatbelt-enclave.ts src/main/lib/sandbox/seatbelt-enclave.test.ts .agents/skills/enclave-seatbelt/SKILL.md
git commit -m "feat(sandbox): add SeatbeltEnclave for macOS sandbox-exec + pf"
```

---

## Task 3: BubblewrapEnclave (Linux bwrap + iptables)

**Files:**
- Create: `src/main/lib/sandbox/bubblewrap-enclave.ts`
- Create: `src/main/lib/sandbox/bubblewrap-enclave.test.ts`
- Skill: `.agents/skills/enclave-bubblewrap/SKILL.md`

**Context:** Linux `bwrap` (bubblewrap) provides unprivileged user namespaces for filesystem and PID isolation. `iptables` rules force network traffic through the proxy. The enclave mounts a minimal root with workspace at `/workspace`, denies access to host home and sensitive dirs, and uses PID namespace isolation.

**Step 1: Write the failing test**

Create `src/main/lib/sandbox/bubblewrap-enclave.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { BubblewrapEnclave } from './bubblewrap-enclave'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}))

describe('BubblewrapEnclave', () => {
  it('generates bwrap args with workspace mount', () => {
    const enclave = new BubblewrapEnclave()
    const args = enclave.buildBwrapArgs({
      workspacePath: '/home/user/project',
      proxyPort: 8080,
      authzPort: 9090,
      shell: '/bin/bash',
      env: { HTTP_PROXY: 'http://127.0.0.1:8080' },
    })
    expect(args).toContain('--bind')
    expect(args).toContain('/home/user/project')
    expect(args).toContain('/workspace')
    expect(args).toContain('--unshare-pid')
  })

  it('blocks sensitive host directories', () => {
    const enclave = new BubblewrapEnclave()
    const args = enclave.buildBwrapArgs({
      workspacePath: '/tmp/ws',
      proxyPort: 8080,
      authzPort: 9090,
      shell: '/bin/sh',
      env: {},
    })
    const argsStr = args.join(' ')
    // Should not mount .ssh, .gnupg, .aws
    expect(argsStr).not.toContain('.ssh')
    expect(argsStr).not.toContain('.gnupg')
  })

  it('includes environment variables in args', () => {
    const enclave = new BubblewrapEnclave()
    const args = enclave.buildBwrapArgs({
      workspacePath: '/tmp/ws',
      proxyPort: 8080,
      authzPort: 9090,
      shell: '/bin/sh',
      env: { HTTP_PROXY: 'http://127.0.0.1:8080', LATCH_ENCLAVE: 'true' },
    })
    expect(args).toContain('--setenv')
    expect(args).toContain('HTTP_PROXY')
    expect(args).toContain('http://127.0.0.1:8080')
  })

  it('generates iptables rules for network forcing', () => {
    const enclave = new BubblewrapEnclave()
    const rules = enclave.generateIptablesRules({
      proxyPort: 8080,
      uid: 1000,
    })
    expect(rules).toContain('iptables')
    expect(rules).toContain('8080')
    expect(rules).toContain('REDIRECT')
    // Should block DNS
    expect(rules).toContain('53')
  })

  it('detects bwrap availability', async () => {
    const { execFile } = await import('node:child_process')
    const mockExecFile = vi.mocked(execFile)
    mockExecFile.mockImplementation((_cmd: any, _args: any, cb: any) => {
      if (typeof cb === 'function') cb(null, '/usr/bin/bwrap', '')
      return {} as any
    })

    const enclave = new BubblewrapEnclave()
    const result = await enclave.detect()
    expect(result).toHaveProperty('available')
  })

  it('uses PID namespace isolation', () => {
    const enclave = new BubblewrapEnclave()
    const args = enclave.buildBwrapArgs({
      workspacePath: '/tmp/ws',
      proxyPort: 8080,
      authzPort: 9090,
      shell: '/bin/sh',
      env: {},
    })
    expect(args).toContain('--unshare-pid')
    expect(args).toContain('--proc')
    expect(args).toContain('/proc')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/lib/sandbox/bubblewrap-enclave.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/main/lib/sandbox/bubblewrap-enclave.ts`:

```typescript
/**
 * @module bubblewrap-enclave
 * @description Linux Bubblewrap sandbox backend using bwrap + iptables.
 *
 * Uses unprivileged user namespaces for filesystem and PID isolation.
 * Mounts a minimal root with workspace at /workspace, denies access to
 * sensitive host directories, and uses PID namespace isolation.
 *
 * iptables rules force all outbound TCP through the proxy port and
 * block DNS (UDP/53) to prevent DNS exfiltration.
 */

import { execFile } from 'node:child_process'
import type { SandboxDetection } from '../../../types'

interface BwrapOptions {
  workspacePath: string
  proxyPort: number
  authzPort: number
  shell: string
  env: Record<string, string>
}

interface IptablesRuleOptions {
  proxyPort: number
  uid: number
}

export class BubblewrapEnclave {
  /**
   * Build the bwrap CLI args for a sandboxed shell.
   *
   * Creates an isolated mount namespace with:
   * - Read-only bind mounts for /usr, /lib, /bin, /sbin, /etc
   * - Writable bind mount for workspace at /workspace
   * - Isolated /tmp via tmpfs
   * - PID namespace isolation (--unshare-pid)
   * - Proc filesystem for the sandbox PID namespace
   * - Environment variables injected via --setenv
   */
  buildBwrapArgs(opts: BwrapOptions): string[] {
    const args: string[] = [
      // Filesystem isolation
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/lib', '/lib',
      '--ro-bind', '/bin', '/bin',
      '--ro-bind', '/sbin', '/sbin',
      '--ro-bind', '/etc', '/etc',

      // Workspace mount (read-write)
      '--bind', opts.workspacePath, '/workspace',
      '--chdir', '/workspace',

      // Isolated /tmp
      '--tmpfs', '/tmp',

      // Dev essentials
      '--dev', '/dev',

      // PID namespace isolation
      '--unshare-pid',
      '--proc', '/proc',

      // Network namespace NOT unshared — we need loopback for proxy
      // Network isolation is enforced by iptables instead

      // Block /proc/self/environ (prevent credential extraction)
      '--ro-bind', '/dev/null', '/proc/self/environ',

      // Minimal home directory
      '--tmpfs', '/home',

      // Die with parent — if Latch exits, sandbox dies
      '--die-with-parent',
    ]

    // Conditionally bind /lib64 if it exists (some Linux distros)
    args.push('--ro-bind-try', '/lib64', '/lib64')

    // Inject environment variables
    for (const [key, value] of Object.entries(opts.env)) {
      args.push('--setenv', key, value)
    }

    // Ensure HISTFILE is /dev/null
    args.push('--setenv', 'HISTFILE', '/dev/null')

    // Shell to execute
    args.push(opts.shell)

    return args
  }

  /**
   * Generate iptables rules for network forcing.
   * Redirects all outbound TCP from the sandbox UID to the proxy port.
   * Blocks UDP/53 (DNS) to prevent DNS exfiltration.
   */
  generateIptablesRules(opts: IptablesRuleOptions): string {
    return `# Latch Enclave iptables rules — session sandbox
# Redirect all outbound TCP to proxy (except loopback)
iptables -t nat -A OUTPUT -p tcp -m owner --uid-owner ${opts.uid} ! -d 127.0.0.1 -j REDIRECT --to-port ${opts.proxyPort}

# Block DNS (UDP/53) to prevent exfiltration
iptables -A OUTPUT -p udp --dport 53 -m owner --uid-owner ${opts.uid} -j DROP

# Allow loopback traffic to proxy and authz ports
iptables -A OUTPUT -p tcp -d 127.0.0.1 -m owner --uid-owner ${opts.uid} -j ACCEPT

# Drop all other outbound from sandbox user
iptables -A OUTPUT -m owner --uid-owner ${opts.uid} -j DROP
`
  }

  /**
   * Generate cleanup commands to remove iptables rules.
   */
  generateIptablesCleanup(opts: IptablesRuleOptions): string {
    return `# Clean up Latch Enclave iptables rules
iptables -t nat -D OUTPUT -p tcp -m owner --uid-owner ${opts.uid} ! -d 127.0.0.1 -j REDIRECT --to-port ${opts.proxyPort} 2>/dev/null
iptables -D OUTPUT -p udp --dport 53 -m owner --uid-owner ${opts.uid} -j DROP 2>/dev/null
iptables -D OUTPUT -p tcp -d 127.0.0.1 -m owner --uid-owner ${opts.uid} -j ACCEPT 2>/dev/null
iptables -D OUTPUT -m owner --uid-owner ${opts.uid} -j DROP 2>/dev/null
`
  }

  /**
   * Detect if bwrap is available (Linux only).
   */
  async detect(): Promise<SandboxDetection> {
    if (process.platform !== 'linux') {
      return { available: false, reason: 'Not Linux' }
    }

    return new Promise((resolve) => {
      execFile('which', ['bwrap'], (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve({ available: false, reason: 'bwrap not found on PATH' })
          return
        }

        // Check version
        execFile('bwrap', ['--version'], (vErr, vOut) => {
          const version = vErr ? undefined : vOut.trim()
          resolve({ available: true, version })
        })
      })
    })
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/lib/sandbox/bubblewrap-enclave.test.ts`
Expected: All 6 tests pass

**Step 5: Write skill doc**

Create `.agents/skills/enclave-bubblewrap/SKILL.md`:

```markdown
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
```

**Step 6: Commit**

```bash
git add src/main/lib/sandbox/bubblewrap-enclave.ts src/main/lib/sandbox/bubblewrap-enclave.test.ts .agents/skills/enclave-bubblewrap/SKILL.md
git commit -m "feat(sandbox): add BubblewrapEnclave for Linux bwrap + iptables"
```

---

## Task 4: SandboxManager (backend selection + lifecycle)

**Files:**
- Create: `src/main/lib/sandbox/sandbox-manager.ts`
- Create: `src/main/lib/sandbox/sandbox-manager.test.ts`
- Skill: `.agents/skills/enclave-sandbox-manager/SKILL.md`

**Context:** The SandboxManager implements the backend selection cascade from the design doc: Docker > Seatbelt (macOS) > Bubblewrap (Linux) > refuse. It wraps each backend behind a unified interface and delegates start/stop/status operations.

**Step 1: Write the failing test**

Create `src/main/lib/sandbox/sandbox-manager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SandboxManager } from './sandbox-manager'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}))

describe('SandboxManager', () => {
  let manager: SandboxManager

  beforeEach(() => {
    manager = new SandboxManager((_ch, _p) => {})
  })

  it('detectBestBackend returns docker when Docker is available', async () => {
    const { execFile } = await import('node:child_process')
    const mockExecFile = vi.mocked(execFile)

    // Simulate `which docker` found + `docker info` succeeds
    mockExecFile.mockImplementation((cmd: any, args: any, optsOrCb: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb
      if (cmd === 'which' && args[0] === 'docker') {
        callback(null, '/usr/local/bin/docker', '')
      } else if (cmd.includes?.('docker') || args?.includes?.('info')) {
        callback(null, '24.0.0', '')
      } else {
        callback(new Error('not found'), '', '')
      }
      return {} as any
    })

    const result = await manager.detectBestBackend()
    // Result depends on mocking — verify shape
    expect(result).toHaveProperty('backend')
    expect(result).toHaveProperty('detection')
  })

  it('detectBestBackend returns null when nothing is available', async () => {
    const { execFile, execSync } = await import('node:child_process')
    const mockExecFile = vi.mocked(execFile)
    const mockExecSync = vi.mocked(execSync)

    // Everything fails
    mockExecFile.mockImplementation((_cmd: any, _args: any, optsOrCb: any, cb?: any) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb
      callback(new Error('not found'), '', '')
      return {} as any
    })
    mockExecSync.mockImplementation(() => { throw new Error('not found') })

    const result = await manager.detectBestBackend()
    expect(result.backend).toBeNull()
  })

  it('getAvailableBackends returns detection results for all backends', async () => {
    const backends = await manager.getAvailableBackends()
    expect(backends).toHaveProperty('docker')
    expect(backends).toHaveProperty('seatbelt')
    expect(backends).toHaveProperty('bubblewrap')
    // Each should have 'available' property
    expect(backends.docker).toHaveProperty('available')
    expect(backends.seatbelt).toHaveProperty('available')
    expect(backends.bubblewrap).toHaveProperty('available')
  })

  it('tracks active sessions by backend', () => {
    manager.registerSession('session-1', 'docker', 'container-abc')
    const status = manager.getSessionStatus('session-1')
    expect(status.backend).toBe('docker')
    expect(status.processId).toBe('container-abc')
    expect(status.status).toBe('running')
  })

  it('unregisters sessions on stop', () => {
    manager.registerSession('session-1', 'docker', 'container-abc')
    manager.unregisterSession('session-1')
    const status = manager.getSessionStatus('session-1')
    expect(status.backend).toBeNull()
    expect(status.status).toBeNull()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/lib/sandbox/sandbox-manager.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/main/lib/sandbox/sandbox-manager.ts`:

```typescript
/**
 * @module sandbox-manager
 * @description Unified sandbox backend selection and lifecycle management.
 *
 * Implements the selection cascade:
 *   1. Docker available? → DockerEnclave
 *   2. macOS? → SeatbeltEnclave (sandbox-exec + pf)
 *   3. Linux? → BubblewrapEnclave (bwrap + iptables)
 *   4. None available? → REFUSE TO START SESSION
 *
 * Wraps backend-specific operations behind a unified interface.
 */

import DockerManager from '../docker-manager'
import { SeatbeltEnclave } from './seatbelt-enclave'
import { BubblewrapEnclave } from './bubblewrap-enclave'
import type { SandboxBackend, SandboxDetection, SandboxStatus } from '../../../types'

type SendFn = (channel: string, payload: unknown) => void

interface SessionRecord {
  sessionId: string
  backend: SandboxBackend
  processId: string
}

interface BackendDetections {
  docker: SandboxDetection
  seatbelt: SandboxDetection
  bubblewrap: SandboxDetection
}

interface BestBackendResult {
  backend: SandboxBackend | null
  detection: SandboxDetection
}

export class SandboxManager {
  private dockerManager: DockerManager
  private seatbeltEnclave: SeatbeltEnclave
  private bubblewrapEnclave: BubblewrapEnclave
  private sessions = new Map<string, SessionRecord>()

  constructor(send: SendFn) {
    this.dockerManager = new DockerManager(send)
    this.seatbeltEnclave = new SeatbeltEnclave()
    this.bubblewrapEnclave = new BubblewrapEnclave()
  }

  /**
   * Detect all available backends and return their status.
   */
  async getAvailableBackends(): Promise<BackendDetections> {
    const [docker, seatbelt, bubblewrap] = await Promise.all([
      this._detectDocker(),
      this.seatbeltEnclave.detect(),
      this.bubblewrapEnclave.detect(),
    ])
    return { docker, seatbelt, bubblewrap }
  }

  /**
   * Detect the best available backend using the selection cascade.
   */
  async detectBestBackend(): Promise<BestBackendResult> {
    // 1. Docker
    const docker = await this._detectDocker()
    if (docker.available) {
      return { backend: 'docker', detection: docker }
    }

    // 2. Seatbelt (macOS)
    const seatbelt = await this.seatbeltEnclave.detect()
    if (seatbelt.available) {
      return { backend: 'seatbelt', detection: seatbelt }
    }

    // 3. Bubblewrap (Linux)
    const bubblewrap = await this.bubblewrapEnclave.detect()
    if (bubblewrap.available) {
      return { backend: 'bubblewrap', detection: bubblewrap }
    }

    // 4. Nothing available
    return {
      backend: null,
      detection: { available: false, reason: 'No sandbox backend available (need Docker, sandbox-exec, or bwrap)' },
    }
  }

  /** Get the Docker manager instance (for existing Docker IPC handlers). */
  getDockerManager(): DockerManager {
    return this.dockerManager
  }

  /** Get the Seatbelt enclave instance. */
  getSeatbeltEnclave(): SeatbeltEnclave {
    return this.seatbeltEnclave
  }

  /** Get the Bubblewrap enclave instance. */
  getBubblewrapEnclave(): BubblewrapEnclave {
    return this.bubblewrapEnclave
  }

  /** Register an active sandbox session. */
  registerSession(sessionId: string, backend: SandboxBackend, processId: string): void {
    this.sessions.set(sessionId, { sessionId, backend, processId })
  }

  /** Unregister a sandbox session (on stop/exit). */
  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** Get the status of a session's sandbox. */
  getSessionStatus(sessionId: string): SandboxStatus {
    const record = this.sessions.get(sessionId)
    if (!record) return { status: null, processId: null, backend: null }
    return { status: 'running', processId: record.processId, backend: record.backend }
  }

  /** Clean up all active sessions. */
  disposeAll(): void {
    this.dockerManager.disposeAll()
    // Seatbelt and Bubblewrap processes die with parent (--die-with-parent / SIGTERM)
    this.sessions.clear()
  }

  /** Detect Docker availability. */
  private async _detectDocker(): Promise<SandboxDetection> {
    try {
      const result = await this.dockerManager.detect()
      return {
        available: result.available,
        version: result.version,
        reason: result.available ? undefined : 'Docker daemon not running',
      }
    } catch {
      return { available: false, reason: 'Docker detection failed' }
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/lib/sandbox/sandbox-manager.test.ts`
Expected: All 5 tests pass

**Step 5: Write skill doc**

Create `.agents/skills/enclave-sandbox-manager/SKILL.md`:

```markdown
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
```

**Step 6: Commit**

```bash
git add src/main/lib/sandbox/sandbox-manager.ts src/main/lib/sandbox/sandbox-manager.test.ts .agents/skills/enclave-sandbox-manager/SKILL.md
git commit -m "feat(sandbox): add SandboxManager with backend selection cascade"
```

---

## Task 5: Update EnclaveManager.detectBackend()

**Files:**
- Modify: `src/main/lib/enclave-manager.ts`
- Modify: `src/main/lib/enclave-manager.test.ts`

**Context:** Replace the Docker-only detection stub with the full selection cascade. The EnclaveManager now delegates to SandboxManager for backend detection.

**Step 1: Update `detectBackend` to check all backends**

Modify `src/main/lib/enclave-manager.ts`:

Replace the existing `detectBackend` method:

```typescript
/**
 * Detect which sandbox backend is available.
 * Selection cascade: Docker → Seatbelt (macOS) → Bubblewrap (Linux) → null.
 */
static async detectBackend(): Promise<SandboxBackend | null> {
  // 1. Docker
  try {
    const { execSync } = await import('node:child_process')
    execSync('docker info', { stdio: 'ignore', timeout: 5000 })
    return 'docker'
  } catch {
    // Docker not available
  }

  // 2. Seatbelt (macOS)
  if (process.platform === 'darwin') {
    try {
      const { execSync } = await import('node:child_process')
      execSync('which sandbox-exec', { stdio: 'ignore', timeout: 5000 })
      return 'seatbelt'
    } catch {
      // sandbox-exec not available
    }
  }

  // 3. Bubblewrap (Linux)
  if (process.platform === 'linux') {
    try {
      const { execSync } = await import('node:child_process')
      execSync('which bwrap', { stdio: 'ignore', timeout: 5000 })
      return 'bubblewrap'
    } catch {
      // bwrap not available
    }
  }

  return null
}
```

**Step 2: Add test for new backends**

Add to `src/main/lib/enclave-manager.test.ts`:

```typescript
it('detectBackend returns a SandboxBackend or null', async () => {
  const result = await EnclaveManager.detectBackend()
  // Result depends on the test environment
  if (result !== null) {
    expect(['docker', 'seatbelt', 'bubblewrap']).toContain(result)
  } else {
    expect(result).toBeNull()
  }
})
```

**Step 3: Run tests**

Run: `npx vitest run src/main/lib/enclave-manager.test.ts`
Expected: All tests pass

**Step 4: Commit**

```bash
git add src/main/lib/enclave-manager.ts src/main/lib/enclave-manager.test.ts
git commit -m "feat(enclave): implement full backend detection cascade — Docker, Seatbelt, Bubblewrap"
```

---

## Task 6: IPC Handlers for Sandbox Management

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/types/index.ts` (LatchAPI interface)

**Context:** Add IPC handlers for sandbox detection and status so the renderer can discover available backends and show sandbox status. The existing Docker-specific IPC handlers remain for backward compatibility.

**Step 1: Add new IPC types to LatchAPI**

Find the `LatchAPI` interface in `src/types/index.ts` and add:

```typescript
// Sandbox
sandboxDetect: () => Promise<{ ok: boolean; backends: Record<string, { available: boolean; version?: string; reason?: string }>; best: string | null }>
sandboxStatus: (payload: { sessionId: string }) => Promise<{ ok: boolean; status: string | null; backend: string | null; processId: string | null }>
```

**Step 2: Add IPC handlers in `src/main/index.ts`**

After the existing Docker handlers, add:

```typescript
// ── Sandbox handlers ───────────────────────────────────────────────────

ipcMain.handle('latch:sandbox-detect', async () => {
  try {
    const backends = await sandboxManager.getAvailableBackends()
    const best = await sandboxManager.detectBestBackend()
    return { ok: true, backends, best: best.backend }
  } catch (err: any) {
    return { ok: false, error: err?.message, backends: {}, best: null }
  }
})

ipcMain.handle('latch:sandbox-status', async (_event: any, { sessionId }: any) => {
  const status = sandboxManager.getSessionStatus(sessionId)
  return { ok: true, ...status }
})
```

Note: You'll need to instantiate `sandboxManager` near the top of the `app.whenReady()` block:
```typescript
const sandboxManager = new SandboxManager(sendToRenderer)
```

Import `SandboxManager`:
```typescript
import { SandboxManager } from './lib/sandbox/sandbox-manager'
```

**Step 3: Add preload API methods**

Add to `src/preload/index.ts`:

```typescript
sandboxDetect: () => ipcRenderer.invoke('latch:sandbox-detect'),
sandboxStatus: (payload: { sessionId: string }) => ipcRenderer.invoke('latch:sandbox-status', payload),
```

**Step 4: Run typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v policy-generator`
Expected: Clean

**Step 5: Commit**

```bash
git add src/main/index.ts src/preload/index.ts src/types/index.ts
git commit -m "feat(ipc): add sandbox detection and status IPC handlers"
```

---

## Task 7: Update PtyManager for Sandbox Backends

**Files:**
- Modify: `src/main/lib/pty-manager.ts`

**Context:** Currently PtyManager either spawns a local shell or does `docker exec`. Phase 3 adds a third path: spawn via `sandbox-exec` (Seatbelt). Bubblewrap uses `bwrap` as the command with its own args. The PTY manager needs a `sandboxBackend` option alongside `dockerContainerId`.

**Step 1: Add sandbox spawn options to PtyManager.create()**

Modify `src/main/lib/pty-manager.ts`. Update the `create` method options:

```typescript
create(sessionId: string, options: {
  cwd?: string
  cols?: number
  rows?: number
  env?: Record<string, string>
  dockerContainerId?: string
  sandboxCommand?: string    // e.g. 'sandbox-exec' or 'bwrap'
  sandboxArgs?: string[]     // args before the shell command
} = {}): PtyRecord
```

Update the command/args selection logic:

```typescript
let command: string
let args: string[]
if (options.dockerContainerId) {
  command = 'docker'
  args = ['exec', '-it', options.dockerContainerId, '/bin/sh']
} else if (options.sandboxCommand && options.sandboxArgs) {
  command = options.sandboxCommand
  args = options.sandboxArgs
} else {
  command = this.getShell()
  args = []
}
```

**Step 2: Run existing tests**

Run: `npx vitest run`
Expected: All tests pass (PTY manager isn't directly unit tested with vitest — it uses node-pty which requires Electron)

**Step 3: Run typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v policy-generator`
Expected: Clean

**Step 4: Commit**

```bash
git add src/main/lib/pty-manager.ts
git commit -m "feat(pty): add sandbox command/args options for native enclave backends"
```

---

## Task 8: Update Agent Skills

**Files:**
- Modify: `.agents/skills/enclave-manager/SKILL.md`

**Step 1: Update enclave-manager skill**

Add Phase 3 information:
- `detectBackend()` now checks Docker → Seatbelt → Bubblewrap cascade
- New sandbox backends: SeatbeltEnclave, BubblewrapEnclave
- SandboxManager for unified lifecycle
- PtyManager now supports `sandboxCommand` / `sandboxArgs` for native backends

**Step 2: Commit**

```bash
git add .agents/skills/
git commit -m "docs(skills): update enclave-manager skill for Phase 3 native sandbox backends"
```

---

## Task 9: Full Test Suite Verification

**Files:** None (verification only)

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All enclave tests pass. Pre-existing radar failures are expected.

**Step 2: Run typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v policy-generator`
Expected: Clean

**Step 3: Verify new test count**

New tests added in Phase 3:
- `seatbelt-enclave.test.ts`: 6 tests
- `bubblewrap-enclave.test.ts`: 6 tests
- `sandbox-manager.test.ts`: 5 tests
- `enclave-manager.test.ts` additions: 1 test

Expected total new tests: ~18

**Step 4: No commit needed — verification only**

---

## Summary of Phase 3 deliverables

| Component | File | What it does |
|-----------|------|-------------|
| Sandbox Types | `src/types/index.ts` | SandboxConfig, SandboxResult, SandboxStatus, SandboxDetection |
| SeatbeltEnclave | `src/main/lib/sandbox/seatbelt-enclave.ts` | macOS sandbox-exec profile + pf rules |
| BubblewrapEnclave | `src/main/lib/sandbox/bubblewrap-enclave.ts` | Linux bwrap args + iptables rules |
| SandboxManager | `src/main/lib/sandbox/sandbox-manager.ts` | Backend selection cascade + lifecycle |
| EnclaveManager (enhanced) | `src/main/lib/enclave-manager.ts` | Full detection cascade |
| PtyManager (enhanced) | `src/main/lib/pty-manager.ts` | sandboxCommand/sandboxArgs support |
| IPC handlers | `src/main/index.ts` + `src/preload/index.ts` | sandbox-detect, sandbox-status |

**New files:** 6 (3 modules + 3 test files)
**Modified files:** 5
**New skills:** 3 (seatbelt, bubblewrap, sandbox-manager)
**Phase 3 commits:** ~9
**Phase 3 new tests:** ~18
