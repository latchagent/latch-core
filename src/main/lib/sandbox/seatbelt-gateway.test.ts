import { describe, it, expect, vi } from 'vitest'
import { SeatbeltGateway } from './seatbelt-gateway'

// Mock child_process since we can't actually run sandbox-exec in tests
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}))

describe('SeatbeltGateway', () => {
  it('generates a valid sandbox profile', () => {
    const gw = new SeatbeltGateway()
    const profile = gw.generateProfile({
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
    const gw = new SeatbeltGateway()
    const profile = gw.generateProfile({
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
    const gw = new SeatbeltGateway()
    const profile = gw.generateProfile({
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
    const gw = new SeatbeltGateway()
    const rules = gw.generatePfRules({
      proxyPort: 8080,
      uid: 501,
    })
    expect(rules).toContain('rdr')
    expect(rules).toContain('8080')
    expect(rules).toContain('block')
  })

  it('builds spawn args for sandbox-exec', () => {
    const gw = new SeatbeltGateway()
    const args = gw.buildSpawnArgs({
      profilePath: '/tmp/latch-sb-xxx/profile.sb',
      shell: '/bin/zsh',
    })
    expect(args.command).toBe('sandbox-exec')
    expect(args.args).toContain('-f')
    expect(args.args).toContain('/tmp/latch-sb-xxx/profile.sb')
    expect(args.args).toContain('/bin/zsh')
  })

  it('rejects workspacePath containing parentheses', () => {
    const gw = new SeatbeltGateway()
    expect(() => gw.generateProfile({
      workspacePath: '/tmp/ws(evil)',
      proxyPort: 8080,
      authzPort: 9090,
      shell: '/bin/sh',
    })).toThrow('Invalid workspacePath')
  })

  it('rejects shell containing quotes', () => {
    const gw = new SeatbeltGateway()
    expect(() => gw.generateProfile({
      workspacePath: '/tmp/ws',
      proxyPort: 8080,
      authzPort: 9090,
      shell: '/bin/sh"',
    })).toThrow('Invalid shell')
  })

  it('detects sandbox-exec availability', async () => {
    const { execFile } = await import('node:child_process')
    const mockExecFile = vi.mocked(execFile)
    // Simulate sandbox-exec found
    mockExecFile.mockImplementation((_cmd: any, _args: any, cb: any) => {
      if (typeof cb === 'function') cb(null, '/usr/bin/sandbox-exec', '')
      return {} as any
    })

    const gw = new SeatbeltGateway()
    const result = await gw.detect()
    // On non-macOS in CI this may vary, just check the shape
    expect(result).toHaveProperty('available')
  })
})
