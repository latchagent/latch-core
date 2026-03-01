/**
 * @module tls-interceptor
 * @description Per-session TLS interception via ephemeral CA.
 *
 * Generates a self-signed CA cert on construction, then creates
 * per-domain leaf certs signed by that CA on demand. The CA cert
 * is written to a temp file for injection into sandbox environments
 * via NODE_EXTRA_CA_CERTS / SSL_CERT_FILE / GIT_SSL_CAINFO.
 *
 * All crypto material is in-memory and destroyed when the session ends.
 */

import * as forge from 'node-forge'
import { randomBytes } from 'node:crypto'
import * as tls from 'node:tls'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { TlsCertPair } from '../../../types'

export class TlsInterceptor {
  private caCert: forge.pki.Certificate
  private caKey: forge.pki.rsa.PrivateKey
  private caCertPem: string
  private caKeyPem: string
  private caCertPath: string
  private leafCache = new Map<string, TlsCertPair>()

  constructor() {
    // Generate CA key pair (RSA 2048)
    const caKeys = forge.pki.rsa.generateKeyPair(2048)
    this.caKey = caKeys.privateKey

    // Create self-signed CA certificate
    this.caCert = forge.pki.createCertificate()
    this.caCert.publicKey = caKeys.publicKey
    this.caCert.serialNumber = randomBytes(8).toString('hex')
    this.caCert.validity.notBefore = new Date()
    this.caCert.validity.notAfter = new Date()
    this.caCert.validity.notAfter.setFullYear(this.caCert.validity.notAfter.getFullYear() + 1)

    const caAttrs = [
      { name: 'commonName', value: 'Latch Gateway Session CA' },
      { name: 'organizationName', value: 'Latch' },
    ]
    this.caCert.setSubject(caAttrs)
    this.caCert.setIssuer(caAttrs)
    this.caCert.setExtensions([
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true },
    ])
    this.caCert.sign(this.caKey, forge.md.sha256.create())

    this.caCertPem = forge.pki.certificateToPem(this.caCert)
    this.caKeyPem = forge.pki.privateKeyToPem(this.caKey)

    // Write CA cert to temp file
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latch-ca-'))
    this.caCertPath = path.join(tmpDir, 'ca.crt')
    fs.writeFileSync(this.caCertPath, this.caCertPem)
  }

  /** Get the CA certificate PEM string. Private key is kept internal. */
  getCaCertPem(): string {
    return this.caCertPem
  }

  /** Get the path to the CA cert temp file (for NODE_EXTRA_CA_CERTS). */
  getCaCertPath(): string {
    return this.caCertPath
  }

  /**
   * Get (or generate) a leaf certificate for a domain, signed by the session CA.
   * Certs are cached per-domain for the session lifetime.
   */
  getCertForDomain(domain: string): TlsCertPair {
    const cached = this.leafCache.get(domain)
    if (cached) return cached

    const leafKeys = forge.pki.rsa.generateKeyPair(2048)
    const leafCert = forge.pki.createCertificate()
    leafCert.publicKey = leafKeys.publicKey
    leafCert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16))
    leafCert.validity.notBefore = new Date()
    leafCert.validity.notAfter = new Date()
    leafCert.validity.notAfter.setFullYear(leafCert.validity.notAfter.getFullYear() + 1)

    leafCert.setSubject([{ name: 'commonName', value: domain }])
    leafCert.setIssuer(this.caCert.subject.attributes)
    leafCert.setExtensions([
      { name: 'subjectAltName', altNames: [{ type: 2, value: domain }] },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
    ])
    leafCert.sign(this.caKey, forge.md.sha256.create())

    const pair: TlsCertPair = {
      cert: forge.pki.certificateToPem(leafCert),
      key: forge.pki.privateKeyToPem(leafKeys.privateKey),
    }
    this.leafCache.set(domain, pair)
    return pair
  }

  /** Create a Node.js TLS SecureContext for a domain (for TLS server socket). */
  getSecureContext(domain: string): tls.SecureContext {
    const { cert, key } = this.getCertForDomain(domain)
    return tls.createSecureContext({ cert, key })
  }

  /** Destroy all crypto material and clean up temp files. */
  destroy(): void {
    this.leafCache.clear()
    try {
      if (fs.existsSync(this.caCertPath)) {
        fs.rmSync(path.dirname(this.caCertPath), { recursive: true })
      }
    } catch {
      // Best-effort cleanup
    }
  }
}
