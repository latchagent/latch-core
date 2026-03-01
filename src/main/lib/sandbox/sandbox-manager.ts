/**
 * @module sandbox-manager
 * @description Unified sandbox backend selection and lifecycle management.
 *
 * Implements the selection cascade:
 *   1. Docker available? → Docker sandbox
 *   2. macOS? → SeatbeltGateway (sandbox-exec + pf)
 *   3. Linux? → BubblewrapGateway (bwrap + iptables)
 *   4. None available? → REFUSE TO START SESSION
 *
 * Wraps backend-specific operations behind a unified interface.
 */

import { execSync } from 'node:child_process'
import DockerManager from '../docker-manager'
import { SeatbeltGateway } from './seatbelt-gateway'
import { BubblewrapGateway } from './bubblewrap-gateway'
import type { SandboxBackend, SandboxDetection, SandboxStatus } from '../../../types'

type SendFn = (channel: string, payload: unknown) => void

interface SessionRecord {
  sessionId: string
  backend: SandboxBackend
  processId: string
  uid?: number
  proxyPort?: number
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
  private seatbeltGateway: SeatbeltGateway
  private bubblewrapGateway: BubblewrapGateway
  private sessions = new Map<string, SessionRecord>()

  constructor(send: SendFn) {
    this.dockerManager = new DockerManager(send)
    this.seatbeltGateway = new SeatbeltGateway()
    this.bubblewrapGateway = new BubblewrapGateway()
  }

  /**
   * Detect all available backends and return their status.
   */
  async getAvailableBackends(): Promise<BackendDetections> {
    const [docker, seatbelt, bubblewrap] = await Promise.all([
      this._detectDocker(),
      this.seatbeltGateway.detect(),
      this.bubblewrapGateway.detect(),
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
    const seatbelt = await this.seatbeltGateway.detect()
    if (seatbelt.available) {
      return { backend: 'seatbelt', detection: seatbelt }
    }

    // 3. Bubblewrap (Linux)
    const bubblewrap = await this.bubblewrapGateway.detect()
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

  /** Get the Seatbelt gateway instance. */
  getSeatbeltGateway(): SeatbeltGateway {
    return this.seatbeltGateway
  }

  /** Get the Bubblewrap gateway instance. */
  getBubblewrapGateway(): BubblewrapGateway {
    return this.bubblewrapGateway
  }

  /** Register an active sandbox session. For bubblewrap sessions, uid and proxyPort are needed for iptables cleanup. */
  registerSession(sessionId: string, backend: SandboxBackend, processId: string, opts?: { uid?: number; proxyPort?: number }): void {
    this.sessions.set(sessionId, { sessionId, backend, processId, uid: opts?.uid, proxyPort: opts?.proxyPort })
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

  /** Clean up all active sessions, including iptables rules for bubblewrap. */
  disposeAll(): void {
    this.dockerManager.disposeAll()
    // Clean up iptables rules for bubblewrap sessions
    for (const record of this.sessions.values()) {
      if (record.backend === 'bubblewrap' && record.uid != null && record.proxyPort != null) {
        const cleanup = this.bubblewrapGateway.generateIptablesCleanup({ uid: record.uid, proxyPort: record.proxyPort })
        try {
          execSync(cleanup, { stdio: 'ignore' })
        } catch {
          // Best-effort cleanup — rules may already be removed
        }
      }
    }
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
