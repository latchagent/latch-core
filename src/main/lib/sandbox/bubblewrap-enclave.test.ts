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
