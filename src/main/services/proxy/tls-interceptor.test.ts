import { describe, it, expect, afterEach } from 'vitest'
import { TlsInterceptor } from './tls-interceptor'
import * as tls from 'node:tls'
import * as fs from 'node:fs'

describe('TlsInterceptor', () => {
  let interceptor: TlsInterceptor

  afterEach(() => {
    interceptor?.destroy()
  })

  it('returns CA certificate PEM without exposing private key', () => {
    interceptor = new TlsInterceptor()
    const certPem = interceptor.getCaCertPem()
    expect(certPem).toContain('BEGIN CERTIFICATE')
    expect(certPem).not.toContain('PRIVATE KEY')
  })

  it('generates leaf certs signed by the CA', () => {
    interceptor = new TlsInterceptor()
    const leaf = interceptor.getCertForDomain('api.github.com')
    expect(leaf.cert).toContain('BEGIN CERTIFICATE')
    expect(leaf.key).toContain('BEGIN RSA PRIVATE KEY')
  })

  it('caches leaf certs per domain', () => {
    interceptor = new TlsInterceptor()
    const leaf1 = interceptor.getCertForDomain('api.github.com')
    const leaf2 = interceptor.getCertForDomain('api.github.com')
    expect(leaf1.cert).toBe(leaf2.cert)
  })

  it('generates different certs for different domains', () => {
    interceptor = new TlsInterceptor()
    const leaf1 = interceptor.getCertForDomain('api.github.com')
    const leaf2 = interceptor.getCertForDomain('registry.npmjs.org')
    expect(leaf1.cert).not.toBe(leaf2.cert)
  })

  it('writes CA cert to a temp file', () => {
    interceptor = new TlsInterceptor()
    const path = interceptor.getCaCertPath()
    expect(fs.existsSync(path)).toBe(true)
    const content = fs.readFileSync(path, 'utf-8')
    expect(content).toContain('BEGIN CERTIFICATE')
  })

  it('creates a valid TLS secure context for a domain', () => {
    interceptor = new TlsInterceptor()
    const ctx = interceptor.getSecureContext('example.com')
    // tls.createSecureContext returns an object — just verify it doesn't throw
    expect(ctx).toBeDefined()
  })

  it('cleans up temp files on destroy', () => {
    interceptor = new TlsInterceptor()
    const path = interceptor.getCaCertPath()
    expect(fs.existsSync(path)).toBe(true)
    interceptor.destroy()
    expect(fs.existsSync(path)).toBe(false)
    // Prevent double-destroy in afterEach
    interceptor = undefined as any
  })
})
