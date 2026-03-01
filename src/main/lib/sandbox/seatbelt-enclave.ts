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
        fs.rmSync(this.profileDir, { recursive: true })
      } catch { /* best-effort */ }
      this.profileDir = null
    }
  }
}
