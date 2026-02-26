/**
 * @module DockerManager
 * @description Backend manager for Docker container lifecycle.
 *
 * Provides detect/pull/start/stop for ephemeral containers that sessions
 * can shell into via `docker exec -it <id> /bin/sh`.
 */

import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

type DockerStatus = 'pulling' | 'starting' | 'running' | 'stopped' | 'error'

interface DockerPortMapping {
  host: number
  container: number
}

interface DockerVolumeMount {
  hostPath: string
  containerPath: string
  readOnly: boolean
}

interface ContainerRecord {
  sessionId: string
  containerId: string
  image: string
  status: DockerStatus
}

type SendFn = (channel: string, payload: unknown) => void

/**
 * Manages Docker containers — one per session.
 * Lifecycle: detect → pull → start → (pty exec) → stop.
 */
class DockerManager {
  private send: SendFn
  private containers: Map<string, ContainerRecord> = new Map()
  private dockerPath: string | null = null
  private detected = false
  private dockerVersion: string | null = null

  constructor(send: SendFn) {
    this.send = send
  }

  /** Check if Docker CLI is available on PATH and daemon is running. */
  async detect(): Promise<{ available: boolean; version?: string; daemonRunning?: boolean }> {
    if (this.detected) {
      return { available: this.dockerPath !== null, version: this.dockerVersion ?? undefined, daemonRunning: this.dockerPath !== null }
    }

    return new Promise((resolve) => {
      execFile('which', ['docker'], (err, stdout) => {
        if (err || !stdout.trim()) {
          this.detected = true
          this.dockerPath = null
          resolve({ available: false, daemonRunning: false })
          return
        }
        this.dockerPath = stdout.trim()

        // Verify daemon is actually running via `docker info`
        execFile(this.dockerPath, ['info', '--format', '{{.ServerVersion}}'], { timeout: 5000 }, (infoErr, infoOut) => {
          if (infoErr) {
            // CLI exists but daemon is not running — mark as unavailable
            this.detected = true
            this.dockerPath = null
            resolve({ available: false, daemonRunning: false })
            return
          }

          this.dockerVersion = infoOut.trim() || null
          this.detected = true
          resolve({ available: true, version: this.dockerVersion ?? undefined, daemonRunning: true })
        })
      })
    })
  }

  /** Pull a Docker image. Broadcasts status updates to the renderer. */
  async pull(image: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.dockerPath) return { ok: false, error: 'Docker not installed' }

    return new Promise((resolve) => {
      execFile(this.dockerPath!, ['pull', image], { timeout: 300000 }, (err) => {
        if (err) {
          resolve({ ok: false, error: `docker pull failed: ${err.message}` })
        } else {
          resolve({ ok: true })
        }
      })
    })
  }

  /** Start an ephemeral container for a session. */
  async start(
    sessionId: string,
    opts: {
      image: string
      workspacePath?: string
      networkEnabled?: boolean
      ports?: DockerPortMapping[]
      extraVolumes?: DockerVolumeMount[]
    }
  ): Promise<{ ok: boolean; containerId?: string; error?: string }> {
    if (!this.dockerPath) return { ok: false, error: 'Docker not installed' }
    if (this.containers.has(sessionId)) return { ok: false, error: 'Container already running for this session' }

    this._setStatus(sessionId, 'starting', opts.image)

    const args = ['run', '-d', '--rm', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--name', `latch-${sessionId}`.replace(/[^a-zA-Z0-9_.-]/g, '-')]

    // Workspace mount
    if (opts.workspacePath) {
      args.push('-v', `${opts.workspacePath}:/workspace`, '-w', '/workspace')
    }

    // Network isolation from policy
    if (opts.networkEnabled === false) {
      args.push('--network', 'none')
    }

    // Port mappings — validate types and ranges
    if (opts.ports) {
      for (const p of opts.ports) {
        if (typeof p.host !== 'number' || typeof p.container !== 'number') continue
        if (p.host < 1024 || p.host > 65535 || p.container < 1 || p.container > 65535) continue
        args.push('-p', `${p.host}:${p.container}`)
      }
    }

    // Extra volume mounts — block sensitive host paths
    if (opts.extraVolumes) {
      for (const v of opts.extraVolumes) {
        if (this._isPathBlocked(v.hostPath)) continue
        const mount = v.readOnly ? `${v.hostPath}:${v.containerPath}:ro` : `${v.hostPath}:${v.containerPath}`
        args.push('-v', mount)
      }
    }

    args.push(opts.image, 'sleep', 'infinity')

    return new Promise((resolve) => {
      execFile(this.dockerPath!, args, { timeout: 60000 }, (err, stdout) => {
        if (err) {
          this._setStatus(sessionId, 'error', opts.image)
          resolve({ ok: false, error: `docker run failed: ${err.message}` })
          return
        }

        const containerId = stdout.trim().substring(0, 12)
        const record: ContainerRecord = {
          sessionId,
          containerId,
          image: opts.image,
          status: 'running',
        }
        this.containers.set(sessionId, record)
        this._broadcastStatus(sessionId, 'running')

        resolve({ ok: true, containerId })
      })
    })
  }

  /** Stop and remove a session's container. */
  async stop(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    const record = this.containers.get(sessionId)
    if (!record) return { ok: true }
    if (!this.dockerPath) return { ok: false, error: 'Docker not installed' }

    return new Promise((resolve) => {
      execFile(this.dockerPath!, ['stop', record.containerId], { timeout: 30000 }, (err) => {
        this.containers.delete(sessionId)
        this._broadcastStatus(sessionId, 'stopped')
        if (err) {
          resolve({ ok: false, error: `docker stop failed: ${err.message}` })
        } else {
          resolve({ ok: true })
        }
      })
    })
  }

  /** Return the container status for a session. */
  getStatus(sessionId: string): { status: DockerStatus | null; containerId: string | null } {
    const record = this.containers.get(sessionId)
    if (!record) return { status: null, containerId: null }
    return { status: record.status, containerId: record.containerId }
  }

  /** Return the container ID for a session (used by pty-create). */
  getContainerId(sessionId: string): string | null {
    return this.containers.get(sessionId)?.containerId ?? null
  }

  /** Stop all containers on app quit. Uses execFileSync to guarantee cleanup before exit. */
  disposeAll(): void {
    if (!this.dockerPath) return
    this.containers.forEach((record) => {
      try { execFileSync(this.dockerPath!, ['stop', '-t', '5', record.containerId], { timeout: 10000 }) } catch { /* best-effort */ }
    })
    this.containers.clear()
  }

  /** Check if a host path should be blocked from volume mounts. */
  private _isPathBlocked(hostPath: string): boolean {
    let resolved: string
    try {
      resolved = fs.realpathSync(hostPath)
    } catch {
      // File might not exist yet — fall back to path.resolve
      resolved = path.resolve(hostPath)
    }
    const blocked = [
      '/etc', '/var/run', '/root',
      path.join(os.homedir(), '.ssh'),
      path.join(os.homedir(), '.gnupg'),
      '/proc', '/sys'
    ]
    return blocked.some(b => resolved === b || resolved.startsWith(b + '/'))
  }

  /** Update internal status and broadcast to renderer. */
  private _setStatus(sessionId: string, status: DockerStatus, image: string): void {
    const existing = this.containers.get(sessionId)
    if (existing) {
      existing.status = status
    } else {
      this.containers.set(sessionId, { sessionId, containerId: '', image, status })
    }
    this._broadcastStatus(sessionId, status)
  }

  /** Send a status event to the renderer. */
  private _broadcastStatus(sessionId: string, status: DockerStatus): void {
    this.send('latch:docker-status', { sessionId, status })
  }
}

export default DockerManager
