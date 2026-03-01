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
