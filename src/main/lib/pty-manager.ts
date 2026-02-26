import * as os from 'node:os'
import * as pty from 'node-pty'

interface PtyRecord {
  sessionId:          string
  ptyProcess:         pty.IPty
  cwd:                string
  shell:              string
  dockerContainerId?: string
}

type SendFn = (channel: string, payload: unknown) => void
type ExitCallback = (sessionId: string) => void

class PtyManager {
  private send: SendFn
  private sessions: Map<string, PtyRecord>
  private exitCallbacks: ExitCallback[] = []

  constructor(send: SendFn) {
    this.send     = send
    this.sessions = new Map()
  }

  /** Register a callback invoked when any PTY exits. */
  onExit(cb: ExitCallback): void {
    this.exitCallbacks.push(cb)
  }

  private getShell(): string {
    if (process.platform === 'win32') return 'powershell.exe'
    return process.env.SHELL || '/bin/zsh'
  }

  create(sessionId: string, options: { cwd?: string; cols?: number; rows?: number; env?: Record<string, string>; dockerContainerId?: string } = {}): PtyRecord {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const cwd   = options.cwd || os.homedir()
    const cols  = options.cols || 100
    const rows  = options.rows || 32

    let command: string
    let args: string[]
    if (options.dockerContainerId) {
      command = 'docker'
      args = ['exec', '-it', options.dockerContainerId, '/bin/sh']
    } else {
      command = this.getShell()
      args = []
    }

    const safeKeys = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_RUNTIME_DIR', 'DISPLAY', 'COLORTERM', 'TERM_PROGRAM', 'LATCH_COMMS_URL', 'LATCH_AUTHZ_SECRET', 'LATCH_HARNESS_ID', 'LATCH_SESSION_ID', 'LATCH_FEED_URL']
    const baseEnv: Record<string, string> = {}
    for (const key of safeKeys) {
      if (process.env[key]) baseEnv[key] = process.env[key]!
    }

    const ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...baseEnv, TERM: 'xterm-256color', ...options.env }
    })

    ptyProcess.onData((data: string) => {
      this.send('latch:pty-data', { sessionId, data })
    })

    ptyProcess.onExit(() => {
      this.sessions.delete(sessionId)
      this.send('latch:pty-exit', { sessionId })
      for (const cb of this.exitCallbacks) {
        try { cb(sessionId) } catch {}
      }
    })

    const record: PtyRecord = { sessionId, ptyProcess, cwd, shell: command, dockerContainerId: options.dockerContainerId }
    this.sessions.set(sessionId, record)
    return record
  }

  write(sessionId: string, data: string): void {
    const record = this.sessions.get(sessionId)
    if (!record) return
    record.ptyProcess.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const record = this.sessions.get(sessionId)
    if (!record) return
    record.ptyProcess.resize(cols, rows)
  }

  kill(sessionId: string): void {
    const record = this.sessions.get(sessionId)
    if (!record) return
    record.ptyProcess.kill()
    this.sessions.delete(sessionId)
  }

  disposeAll(): void {
    this.sessions.forEach((record) => {
      record.ptyProcess.kill()
    })
    this.sessions.clear()
  }
}

export default PtyManager
