/**
 * @module latch-proxy
 * @description Per-session HTTP proxy with domain-based service gating,
 * credential injection, TLS interception, ingress scanning, and audit logging.
 *
 * Phase 1: Domain-level allow/deny, credential injection, audit logging.
 * Phase 2: TLS MITM via ephemeral CA, content-type-aware ingress scanning,
 *          tokenization, de-tokenization, tlsExceptions fallback.
 */

import http from 'node:http'
import net from 'node:net'
import * as tls from 'node:tls'
import * as https from 'node:https'
import type { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { EgressFilter } from './proxy/egress-filter'
import { TokenMap } from './proxy/token-map'
import { TlsInterceptor } from './proxy/tls-interceptor'
import { IngressFilter } from './proxy/ingress-filter'
import type { ServiceDefinition, DataTier, ProxyAuditEvent, ProxyFeedbackMessage } from '../../types'
import type { AttestationStore } from '../stores/attestation-store'

/** Maximum number of audit events retained in the in-memory ring buffer. */
const AUDIT_LOG_CAP = 1000

/** Ports allowed for CONNECT tunnels. */
const ALLOWED_CONNECT_PORTS = new Set([443])

export interface LatchProxyConfig {
  sessionId: string
  services: ServiceDefinition[]
  credentials: Map<string, Record<string, string>>
  maxDataTier: DataTier
  onBlock?: (message: string) => void
  onFeedback?: (message: ProxyFeedbackMessage) => void
  enableTls?: boolean  // default false for backward compat
  attestationStore?: AttestationStore
}

export interface RequestEvaluation {
  decision: 'allow' | 'deny'
  service: ServiceDefinition | null
  reason: string | null
}

export class LatchProxy {
  private server: http.Server | null = null
  private port = 0
  private config: LatchProxyConfig
  private egressFilter: EgressFilter
  private tokenMap: TokenMap
  private tlsInterceptor: TlsInterceptor | null = null
  private ingressFilter: IngressFilter
  private auditLog: ProxyAuditEvent[] = []

  constructor(config: LatchProxyConfig) {
    this.config = config
    this.egressFilter = new EgressFilter(config.services)
    this.tokenMap = new TokenMap()
    this.ingressFilter = new IngressFilter(this.tokenMap)
    if (config.enableTls) {
      this.tlsInterceptor = new TlsInterceptor()
    }
  }

  /** Start the proxy server. Returns the port number. */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handleRequest(req, res))
      this.server.on('connect', (req, socket, head) => this._handleConnect(req, socket, head))
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
          console.log(`[LatchProxy] Session ${this.config.sessionId} listening on 127.0.0.1:${this.port}`)
          resolve(this.port)
        } else {
          reject(new Error('Failed to bind proxy'))
        }
      })
      this.server.on('error', reject)
    })
  }

  /** Evaluate a request against policy (public for testing). */
  evaluateRequest(domain: string, method: string, path: string): RequestEvaluation {
    const service = this.egressFilter.matchService(domain)

    if (!service) {
      const reason = `${domain} is not an authorized service. Add it via Services in the Latch sidebar.`
      this._recordAudit(domain, method, path, null, 'deny', reason)
      return { decision: 'deny', service: null, reason }
    }

    if (!this.egressFilter.checkTierAccess(service.dataTier.defaultTier, this.config.maxDataTier)) {
      const reason = `Service "${service.name}" tier (${service.dataTier.defaultTier}) exceeds session max tier (${this.config.maxDataTier})`
      this._recordAudit(domain, method, path, service.id, 'deny', reason)
      return { decision: 'deny', service, reason }
    }

    // Path/method scope check
    const scopeCheck = this.egressFilter.checkPathScope(service, method, path)
    if (!scopeCheck.allowed) {
      const reason = scopeCheck.reason ?? `${method} ${path} not allowed for service "${service.name}"`
      this._recordAudit(domain, method, path, service.id, 'deny', reason)
      return { decision: 'deny', service, reason }
    }

    this._recordAudit(domain, method, path, service.id, 'allow', null)
    return { decision: 'allow', service, reason: null }
  }

  /** Get audit events. Delegates to attestation store when available, falls back to in-memory ring buffer. */
  getAuditLog(): ProxyAuditEvent[] {
    if (this.config.attestationStore) {
      return this.config.attestationStore.listEvents(this.config.sessionId)
    }
    return [...this.auditLog]
  }

  /** Get the token map (for attestation). */
  getTokenMap(): TokenMap {
    return this.tokenMap
  }

  /** Get the CA cert path for env injection (null if TLS not enabled). */
  getCaCertPath(): string | null {
    return this.tlsInterceptor?.getCaCertPath() ?? null
  }

  /** Set the feedback callback after construction (for post-PTY wiring). */
  setOnFeedback(cb: (msg: ProxyFeedbackMessage) => void): void {
    this.config.onFeedback = cb
  }

  /** Add services to a running proxy (hot-reload for mid-session addition). */
  addServices(newServices: ServiceDefinition[], newCredentials: Map<string, Record<string, string>>): void {
    // Merge new services into config (avoid duplicates by id)
    const existingIds = new Set(this.config.services.map(s => s.id))
    for (const svc of newServices) {
      if (!existingIds.has(svc.id)) {
        this.config.services.push(svc)
      }
    }
    // Merge new credentials
    for (const [id, creds] of newCredentials) {
      this.config.credentials.set(id, creds)
    }
    // Rebuild egress filter with updated service list
    this.egressFilter.rebuildRules(this.config.services)
  }

  /** Stop the proxy and clean up. */
  stop(): void {
    this.tokenMap.clear()
    this.tlsInterceptor?.destroy()
    this.tlsInterceptor = null
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  /** Get the port number. */
  getPort(): number {
    return this.port
  }

  // -- Private ──────────────────────────────────────────────────────────────

  /**
   * H5: Shared helper — inject credentials into headers and de-tokenize body.
   * Returns the processed body buffer and the de-tokenized string, or null
   * if the request should be blocked (credential leak detected).
   */
  private _injectAndDetokenize(
    req: http.IncomingMessage,
    rawBody: Buffer,
    service: ServiceDefinition,
    domain: string,
    method: string,
    path: string,
    res: http.ServerResponse,
    isSecure: boolean,
  ): { body: Buffer; detokenized: string } | null {
    const creds = this.config.credentials.get(service.id)

    // M2: Refuse credential injection over plaintext HTTP
    if (creds && !isSecure) {
      this.config.onFeedback?.({
        type: 'block',
        domain,
        service: service.id,
        detail: 'Credential injection refused over plaintext HTTP',
      })
      this._recordAudit(domain, method, path, service.id, 'deny', 'Credential injection refused over plaintext HTTP')
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Credential injection requires HTTPS' }))
      return null
    }

    if (creds) {
      const injected = this.egressFilter.injectHeaders(service, creds)
      for (const [k, v] of Object.entries(injected)) {
        req.headers[k.toLowerCase()] = v
      }
    }

    const bodyStr = rawBody.toString('utf-8')
    const detokenized = this.tokenMap.detokenizeString(bodyStr, service.id)
    let body = rawBody
    if (detokenized !== bodyStr) {
      body = Buffer.from(detokenized, 'utf-8')
    }

    // Scan outbound body for credential leaks
    if (creds) {
      const leakCheck = this.egressFilter.scanForLeaks(service, detokenized)
      if (!leakCheck.safe) {
        this.config.onFeedback?.({
          type: 'leak-detected',
          domain,
          service: service.id,
          detail: `Credential leak detected in request body: ${leakCheck.leaked.join(', ')}`,
        })
        this._recordAudit(domain, method, path, service.id, 'deny', `Credential leak: ${leakCheck.leaked.join(', ')}`)
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Request blocked: credential leak detected' }))
        return null
      }
    }

    return { body, detokenized }
  }

  /**
   * H5: Shared helper — scan response, apply tokenization, record audit, and
   * send the response to the client.
   */
  private _scanAndRecord(
    proxyRes: http.IncomingMessage,
    clientRes: http.ServerResponse,
    domain: string,
    method: string,
    path: string,
    service: ServiceDefinition,
    tlsInspected: boolean,
  ): void {
    const contentType = proxyRes.headers['content-type'] ?? null

    if (!this.ingressFilter.isScannable(contentType)) {
      this._recordAudit(domain, method, path, service.id, 'allow', null, {
        contentType,
        tlsInspected,
      })
      clientRes.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers)
      proxyRes.pipe(clientRes)
      return
    }

    const resChunks: Buffer[] = []
    proxyRes.on('data', (chunk: Buffer) => resChunks.push(chunk))

    // ARCH-2: Handle upstream response stream errors
    proxyRes.on('error', (err) => {
      console.error(`[LatchProxy] Upstream response error for ${domain}${path}:`, err)
      if (!clientRes.headersSent) {
        clientRes.writeHead(502)
        clientRes.end('Bad Gateway')
      } else {
        clientRes.destroy()
      }
    })

    proxyRes.on('end', () => {
      const resBody = Buffer.concat(resChunks).toString('utf-8')
      const scanResult = this.ingressFilter.scanResponse(contentType, resBody, service, path)

      if (scanResult.tokenizationsApplied > 0) {
        this.config.onFeedback?.({
          type: 'tokenization',
          domain,
          service: service.id,
          detail: `${scanResult.tokenizationsApplied} value(s) tokenized in response`,
        })
      }

      this._recordAudit(domain, method, path, service.id, 'allow', null, {
        contentType,
        tlsInspected,
        redactionsApplied: scanResult.redactionsApplied,
        tokenizationsApplied: scanResult.tokenizationsApplied,
      })

      const responseBody = scanResult.processedBody ?? resBody
      const headers = { ...proxyRes.headers }
      headers['content-length'] = String(Buffer.byteLength(responseBody))
      delete headers['transfer-encoding']
      clientRes.writeHead(proxyRes.statusCode ?? 200, headers)
      clientRes.end(responseBody)
    })
  }

  /** Handle regular HTTP requests (non-CONNECT) with response scanning. */
  private _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const domain = url.hostname
    const evaluation = this.evaluateRequest(domain, req.method ?? 'GET', url.pathname)

    if (evaluation.decision === 'deny') {
      this.config.onBlock?.(`Request to ${domain} blocked — ${evaluation.reason}`)
      this.config.onFeedback?.({ type: 'block', domain, service: null, detail: evaluation.reason ?? '' })
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: evaluation.reason }))
      return
    }

    const service = evaluation.service!

    // ARCH-1: Handle client request stream errors
    req.on('error', (err) => {
      console.error(`[LatchProxy] Client request error for ${domain}${url.pathname}:`, err)
      if (!res.headersSent) {
        res.writeHead(502)
        res.end('Bad Gateway')
      }
    })

    const reqChunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => reqChunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(reqChunks)

      // H5 + M2: Shared credential injection and de-tokenization (isSecure=false for HTTP)
      const prepared = this._injectAndDetokenize(req, rawBody, service, domain, req.method ?? 'GET', url.pathname, res, false)
      if (!prepared) return

      const proxyReq = http.request(
        {
          hostname: domain,
          port: url.port || 80,
          path: url.pathname + url.search,
          method: req.method,
          headers: { ...req.headers, 'content-length': String(prepared.body.length) },
        },
        (proxyRes) => {
          // H5: Shared response scanning and recording
          this._scanAndRecord(proxyRes, res, domain, req.method ?? 'GET', url.pathname, service, false)
        },
      )
      // M5: Generic error message — log details internally
      proxyReq.on('error', (err) => {
        console.error(`[LatchProxy] Upstream request error for ${domain}${url.pathname}:`, err)
        if (!res.headersSent) {
          res.writeHead(502)
          res.end('Bad Gateway')
        }
      })
      proxyReq.end(prepared.body)
    })
  }

  /** Handle HTTPS CONNECT requests. TLS MITM when enabled, tunnel otherwise. */
  private _handleConnect(
    req: http.IncomingMessage,
    socket: Duplex,
    _head: Buffer,
  ): void {
    const [host, portStr] = (req.url ?? '').split(':')
    const port = parseInt(portStr, 10) || 443

    // M4: Restrict CONNECT to allowed ports (default: 443 only)
    if (!ALLOWED_CONNECT_PORTS.has(port)) {
      this.config.onBlock?.(`CONNECT to ${host}:${port} blocked — port not allowed`)
      this.config.onFeedback?.({ type: 'block', domain: host, service: null, detail: `CONNECT port ${port} not allowed` })
      this._recordAudit(host, 'CONNECT', '/', null, 'deny', `CONNECT port ${port} not allowed`)
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.end()
      return
    }

    const evaluation = this.evaluateRequest(host, 'CONNECT', '/')

    if (evaluation.decision === 'deny') {
      this.config.onBlock?.(`CONNECT to ${host} blocked — ${evaluation.reason}`)
      this.config.onFeedback?.({ type: 'block', domain: host, service: null, detail: evaluation.reason ?? '' })
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.end()
      return
    }

    const service = evaluation.service!

    // Check if domain is in tlsExceptions — fall back to tunnel
    const isTlsException = service.injection.proxy.tlsExceptions?.some(
      exc => host.toLowerCase() === exc.toLowerCase() ||
             new RegExp(`^${exc.replace(/\./g, '\\.').replace(/\*/g, '[^.]+')}$`, 'i').test(host),
    ) ?? false

    if (!this.tlsInterceptor || isTlsException) {
      // Phase 1 tunnel: domain-level gating only, no body inspection
      if (isTlsException) {
        this.config.onFeedback?.({
          type: 'tls-exception',
          domain: host,
          service: service.id,
          detail: `TLS exception — tunneling without inspection`,
        })
      }
      this._recordAudit(host, 'CONNECT', '/', service.id, 'allow', null, { tlsInspected: false })
      const upstream = net.connect(port, host, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      upstream.on('error', () => {
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        socket.end()
      })
      socket.on('error', () => upstream.destroy())
      return
    }

    // TLS MITM: intercept, inspect, forward
    this._handleMitm(socket, host, port, service)
  }

  /** Perform TLS man-in-the-middle on a CONNECT tunnel. */
  private _handleMitm(
    clientSocket: Duplex,
    host: string,
    port: number,
    service: ServiceDefinition,
  ): void {
    // Tell client tunnel is established
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

    // Wrap client socket in TLS (we are the server)
    const secureContext = this.tlsInterceptor!.getSecureContext(host)
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      secureContext,
    })

    // Create a temporary HTTP server to parse requests from the decrypted stream
    const mitmServer = http.createServer((req, res) => {
      this._handleInterceptedRequest(req, res, host, port, service)
    })

    // Emit the TLS socket as a connection on the MITM server
    mitmServer.emit('connection', tlsSocket)

    tlsSocket.on('error', () => {
      tlsSocket.destroy()
      mitmServer.close()
    })
    clientSocket.on('error', () => {
      tlsSocket.destroy()
      mitmServer.close()
    })

    // ARCH-3: Clean up MITM server when the TLS socket closes
    tlsSocket.on('close', () => {
      mitmServer.close()
    })
  }

  /** Handle an intercepted (decrypted) HTTP request from the MITM tunnel. */
  private _handleInterceptedRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    host: string,
    port: number,
    service: ServiceDefinition,
  ): void {
    const path = req.url ?? '/'
    const method = req.method ?? 'GET'

    // ARCH-1: Handle client request stream errors (MITM path)
    req.on('error', (err) => {
      console.error(`[LatchProxy] MITM client request error for ${host}${path}:`, err)
      if (!res.headersSent) {
        res.writeHead(502)
        res.end('Bad Gateway')
      }
    })

    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks)

      // H5: Shared credential injection and de-tokenization (isSecure=true for MITM/HTTPS)
      const prepared = this._injectAndDetokenize(req, rawBody, service, host, method, path, res, true)
      if (!prepared) return

      // Forward to real upstream with TLS
      const upstreamReq = https.request(
        {
          hostname: host,
          port,
          path,
          method,
          headers: { ...req.headers, host, 'content-length': String(prepared.body.length) },
          rejectUnauthorized: true,
        },
        (upstreamRes) => {
          // H5: Shared response scanning and recording
          this._scanAndRecord(upstreamRes, res, host, method, path, service, true)
        },
      )

      // M5: Generic error message — log details internally
      upstreamReq.on('error', (err) => {
        console.error(`[LatchProxy] MITM upstream request error for ${host}${path}:`, err)
        if (!res.headersSent) {
          res.writeHead(502)
          res.end('Bad Gateway')
        }
      })

      upstreamReq.end(prepared.body)
    })
  }

  /** H9: Record audit event with ring buffer cap. */
  private _recordAudit(
    domain: string,
    method: string,
    path: string,
    service: string | null,
    decision: 'allow' | 'deny',
    reason: string | null,
    extras?: { contentType?: string; tlsInspected?: boolean; redactionsApplied?: number; tokenizationsApplied?: number },
  ): void {
    const event: ProxyAuditEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      service,
      domain,
      method,
      path,
      tier: null,
      decision,
      reason,
      contentType: extras?.contentType ?? null,
      tlsInspected: extras?.tlsInspected ?? false,
      redactionsApplied: extras?.redactionsApplied ?? 0,
      tokenizationsApplied: extras?.tokenizationsApplied ?? 0,
    }

    // Ring buffer: drop oldest when at capacity
    if (this.auditLog.length >= AUDIT_LOG_CAP) {
      this.auditLog.shift()
    }
    this.auditLog.push(event)

    this.config.attestationStore?.recordEvent(event)
  }
}
