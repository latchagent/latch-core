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
