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
