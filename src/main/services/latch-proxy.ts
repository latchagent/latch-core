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

export interface LatchProxyConfig {
  sessionId: string
  services: ServiceDefinition[]
  credentials: Map<string, Record<string, string>>
  maxDataTier: DataTier
  onBlock?: (message: string) => void
  onFeedback?: (message: ProxyFeedbackMessage) => void
  enableTls?: boolean  // default false for backward compat
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
      this._recordAudit(domain, method, path, null, 'deny', `${domain} is not an authorized service`)
      return { decision: 'deny', service: null, reason: `${domain} is not an authorized service` }
    }

    if (!this.egressFilter.checkTierAccess(service.dataTier.defaultTier, this.config.maxDataTier)) {
      const reason = `Service "${service.name}" tier (${service.dataTier.defaultTier}) exceeds session max tier (${this.config.maxDataTier})`
      this._recordAudit(domain, method, path, service.id, 'deny', reason)
      return { decision: 'deny', service, reason }
    }

    this._recordAudit(domain, method, path, service.id, 'allow', null)
    return { decision: 'allow', service, reason: null }
  }

  /** Get all audit events for this session. */
  getAuditLog(): ProxyAuditEvent[] {
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
    const creds = this.config.credentials.get(service.id)
    if (creds) {
      const injected = this.egressFilter.injectHeaders(service, creds)
      for (const [k, v] of Object.entries(injected)) {
        req.headers[k.toLowerCase()] = v
      }
    }

    // Buffer request body for de-tokenization
    const reqChunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => reqChunks.push(chunk))
    req.on('end', () => {
      let reqBody = Buffer.concat(reqChunks)
      const bodyStr = reqBody.toString('utf-8')
      const detokenized = this.tokenMap.detokenizeString(bodyStr, service.id)
      if (detokenized !== bodyStr) {
        reqBody = Buffer.from(detokenized, 'utf-8')
      }

      const proxyReq = http.request(
        {
          hostname: domain,
          port: url.port || 80,
          path: url.pathname + url.search,
          method: req.method,
          headers: { ...req.headers, 'content-length': String(reqBody.length) },
        },
        (proxyRes) => {
          const contentType = proxyRes.headers['content-type'] ?? null

          if (!this.ingressFilter.isScannable(contentType)) {
            // Binary — pass through without body scanning
            this._recordAudit(domain, req.method ?? 'GET', url.pathname, service.id, 'allow', null, {
              contentType,
              tlsInspected: false,
            })
            res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers)
            proxyRes.pipe(res)
            return
          }

          // Buffer and scan scannable responses
          const resChunks: Buffer[] = []
          proxyRes.on('data', (chunk: Buffer) => resChunks.push(chunk))
          proxyRes.on('end', () => {
            const resBody = Buffer.concat(resChunks).toString('utf-8')
            const scanResult = this.ingressFilter.scanResponse(contentType, resBody, service, url.pathname)

            if (scanResult.tokenizationsApplied > 0) {
              this.config.onFeedback?.({
                type: 'tokenization',
                domain,
                service: service.id,
                detail: `${scanResult.tokenizationsApplied} value(s) tokenized in response`,
              })
            }

            this._recordAudit(domain, req.method ?? 'GET', url.pathname, service.id, 'allow', null, {
              contentType,
              tlsInspected: false,
              redactionsApplied: scanResult.redactionsApplied,
              tokenizationsApplied: scanResult.tokenizationsApplied,
            })

            const responseBody = scanResult.processedBody ?? resBody
            const headers = { ...proxyRes.headers }
            headers['content-length'] = String(Buffer.byteLength(responseBody))
            delete headers['transfer-encoding']
            res.writeHead(proxyRes.statusCode ?? 200, headers)
            res.end(responseBody)
          })
        },
      )
      proxyReq.on('error', (err) => {
        res.writeHead(502)
        res.end(`Proxy error: ${err.message}`)
      })
      proxyReq.end(reqBody)
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

    // Egress: inject credentials
    const creds = this.config.credentials.get(service.id)
    if (creds) {
      const injected = this.egressFilter.injectHeaders(service, creds)
      for (const [k, v] of Object.entries(injected)) {
        req.headers[k.toLowerCase()] = v
      }
    }

    // Egress: de-tokenize request body (resolve tokens being sent to this service)
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      let body = Buffer.concat(chunks)

      // De-tokenize if body contains tokens
      const bodyStr = body.toString('utf-8')
      const detokenized = this.tokenMap.detokenizeString(bodyStr, service.id)
      if (detokenized !== bodyStr) {
        body = Buffer.from(detokenized, 'utf-8')
      }

      // Forward to real upstream with TLS
      const upstreamReq = https.request(
        {
          hostname: host,
          port,
          path,
          method,
          headers: { ...req.headers, host, 'content-length': String(body.length) },
          rejectUnauthorized: true,
        },
        (upstreamRes) => {
          this._handleInterceptedResponse(upstreamRes, res, host, method, path, service)
        },
      )

      upstreamReq.on('error', (err) => {
        res.writeHead(502)
        res.end(`Proxy error: ${err.message}`)
      })

      upstreamReq.end(body)
    })
  }

  /** Handle an intercepted upstream response — scan body if content is scannable. */
  private _handleInterceptedResponse(
    upstreamRes: http.IncomingMessage,
    clientRes: http.ServerResponse,
    host: string,
    method: string,
    path: string,
    service: ServiceDefinition,
  ): void {
    const contentType = upstreamRes.headers['content-type'] ?? null

    if (!this.ingressFilter.isScannable(contentType)) {
      // Binary or unknown — pass through without body scanning
      this._recordAudit(host, method, path, service.id, 'allow', null, {
        contentType,
        tlsInspected: true,
        redactionsApplied: 0,
        tokenizationsApplied: 0,
      })
      clientRes.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers)
      upstreamRes.pipe(clientRes)
      return
    }

    // Scannable content — buffer the entire response body
    const chunks: Buffer[] = []
    upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk))
    upstreamRes.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8')
      const scanResult = this.ingressFilter.scanResponse(contentType, body, service, path)

      // Send feedback if tokenizations were applied
      if (scanResult.tokenizationsApplied > 0) {
        this.config.onFeedback?.({
          type: 'tokenization',
          domain: host,
          service: service.id,
          detail: `${scanResult.tokenizationsApplied} value(s) tokenized in response`,
        })
      }

      this._recordAudit(host, method, path, service.id, 'allow', null, {
        contentType,
        tlsInspected: true,
        redactionsApplied: scanResult.redactionsApplied,
        tokenizationsApplied: scanResult.tokenizationsApplied,
      })

      const responseBody = scanResult.processedBody ?? body
      const headers = { ...upstreamRes.headers }
      headers['content-length'] = String(Buffer.byteLength(responseBody))
      // Remove transfer-encoding since we're sending a known-length body
      delete headers['transfer-encoding']
      clientRes.writeHead(upstreamRes.statusCode ?? 200, headers)
      clientRes.end(responseBody)
    })
  }

  private _recordAudit(
    domain: string,
    method: string,
    path: string,
    service: string | null,
    decision: 'allow' | 'deny',
    reason: string | null,
    extras?: { contentType?: string; tlsInspected?: boolean; redactionsApplied?: number; tokenizationsApplied?: number },
  ): void {
    this.auditLog.push({
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
    })
  }
}
