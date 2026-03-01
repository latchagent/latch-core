/**
 * @module latch-proxy
 * @description Per-session HTTP proxy with domain-based service gating,
 * credential injection, and audit logging.
 *
 * Phase 1 scope:
 * - Domain-level allow/deny based on registered services
 * - Credential injection via headers
 * - Audit logging of all requests
 * - No TLS interception (Phase 2)
 * - No response body scanning (Phase 2)
 */

import http from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { EgressFilter } from './proxy/egress-filter'
import { TokenMap } from './proxy/token-map'
import type { ServiceDefinition, DataTier, ProxyAuditEvent } from '../../types'

export interface LatchProxyConfig {
  sessionId: string
  services: ServiceDefinition[]
  credentials: Map<string, Record<string, string>>
  maxDataTier: DataTier
  onBlock?: (message: string) => void
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
  private auditLog: ProxyAuditEvent[] = []

  constructor(config: LatchProxyConfig) {
    this.config = config
    this.egressFilter = new EgressFilter(config.services)
    this.tokenMap = new TokenMap()
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

  /** Stop the proxy and clean up. */
  stop(): void {
    this.tokenMap.clear()
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

  /** Handle regular HTTP requests (non-CONNECT). */
  private _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const domain = url.hostname
    const evaluation = this.evaluateRequest(domain, req.method ?? 'GET', url.pathname)

    if (evaluation.decision === 'deny') {
      this.config.onBlock?.(`Request to ${domain} blocked — ${evaluation.reason}`)
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: evaluation.reason }))
      return
    }

    // Inject credentials
    const service = evaluation.service!
    const creds = this.config.credentials.get(service.id)
    if (creds) {
      const injected = this.egressFilter.injectHeaders(service, creds)
      for (const [k, v] of Object.entries(injected)) {
        req.headers[k.toLowerCase()] = v
      }
    }

    // Forward request
    const proxyReq = http.request(
      {
        hostname: domain,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: req.method,
        headers: req.headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers)
        proxyRes.pipe(res)
      },
    )
    proxyReq.on('error', (err) => {
      res.writeHead(502)
      res.end(`Proxy error: ${err.message}`)
    })
    req.pipe(proxyReq)
  }

  /** Handle HTTPS CONNECT tunneling. Phase 1: allow/deny at domain level only. */
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
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.end()
      return
    }

    // Phase 1: tunnel without TLS interception
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
  }

  private _recordAudit(
    domain: string,
    method: string,
    path: string,
    service: string | null,
    decision: 'allow' | 'deny',
    reason: string | null,
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
      contentType: null,
    })
  }
}
