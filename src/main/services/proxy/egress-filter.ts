/**
 * @module egress-filter
 * @description Domain matching, tier checking, credential injection, and
 * exfiltration detection for outbound proxy requests.
 */

import type { ServiceDefinition, DataTier } from '../../../types'
import { safeRegexMatch, safeRegexTest } from '../../lib/safe-regex'
import { interpolateCredentialHeaders } from '../../lib/credential-utils'

/** Valid hostname characters — rejects whitespace, newlines, and non-hostname chars. */
const VALID_DOMAIN_RE = /^[a-zA-Z0-9.*-]+$/

const TIER_LEVELS: Record<DataTier, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
}

export class EgressFilter {
  private services: ServiceDefinition[]
  private domainRules: Array<{ regex: RegExp; service: ServiceDefinition }>

  constructor(services: ServiceDefinition[]) {
    this.services = services
    this.domainRules = []
    for (const svc of services) {
      for (const domain of svc.injection.proxy.domains) {
        if (!VALID_DOMAIN_RE.test(domain)) continue // L2: reject invalid domain chars
        const pattern = domain.replace(/\./g, '\\.').replace(/\*/g, '[^.]+')
        this.domainRules.push({
          regex: new RegExp(`^${pattern}$`, 'i'),
          service: svc,
        })
      }
    }
  }

  /** Rebuild domain rules from an updated service list (for hot-reload). */
  rebuildRules(services: ServiceDefinition[]): void {
    this.services = services
    this.domainRules = []
    for (const svc of services) {
      for (const domain of svc.injection.proxy.domains) {
        if (!VALID_DOMAIN_RE.test(domain)) continue
        const pattern = domain.replace(/\./g, '\\.').replace(/\*/g, '[^.]+')
        this.domainRules.push({
          regex: new RegExp(`^${pattern}$`, 'i'),
          service: svc,
        })
      }
    }
  }

  matchService(domain: string): ServiceDefinition | null {
    const lower = domain.toLowerCase()
    for (const rule of this.domainRules) {
      if (rule.regex.test(lower)) return rule.service
    }
    return null
  }

  checkTierAccess(serviceTier: DataTier, maxTier: DataTier): boolean {
    return TIER_LEVELS[serviceTier] <= TIER_LEVELS[maxTier]
  }

  injectHeaders(
    service: ServiceDefinition,
    credentials: Record<string, string>,
  ): Record<string, string> {
    return interpolateCredentialHeaders(service.injection.proxy.headers, credentials)
  }

  scanForLeaks(
    service: ServiceDefinition,
    body: string,
  ): { safe: boolean; leaked: string[] } {
    const leaked: string[] = []
    for (const pattern of service.dataTier.redaction.patterns) {
      const matches = safeRegexMatch(pattern, 'g', body)
      if (matches) leaked.push(...matches)
    }
    return { safe: leaked.length === 0, leaked }
  }

  /**
   * Check if a request's method and path are allowed by the service's path rules.
   * Returns { allowed: true } if no rules defined or request passes.
   * Deny rules take precedence over allow rules.
   */
  checkPathScope(
    service: ServiceDefinition,
    method: string,
    path: string,
  ): { allowed: boolean; reason?: string } {
    const rules = service.injection.proxy.pathRules
    if (!rules || rules.length === 0) return { allowed: true }

    // Check deny rules first (deny takes precedence)
    for (const rule of rules) {
      if (rule.decision !== 'deny') continue
      if (this._methodMatches(rule.methods, method) && this._pathMatches(rule.paths, path)) {
        return { allowed: false, reason: `${method} ${path} denied by path rule` }
      }
    }

    // Check allow rules — if any allow rules exist, request must match one
    const allowRules = rules.filter(r => r.decision === 'allow')
    if (allowRules.length === 0) return { allowed: true }

    for (const rule of allowRules) {
      if (this._methodMatches(rule.methods, method) && this._pathMatches(rule.paths, path)) {
        return { allowed: true }
      }
    }

    // C3: Allow rules exist but none matched — deny (allowlist semantics)
    return { allowed: false, reason: 'No matching allow rule' }
  }

  private _methodMatches(methods: string[], method: string): boolean {
    return methods.includes('*') || methods.includes(method.toUpperCase())
  }

  private _pathMatches(patterns: string[], path: string): boolean {
    return patterns.some(pattern => {
      const escaped = '^' + pattern.replace(/\*\*/g, '.*').replace(/(?<!\.)(\*)/g, '[^/]*') + '$'
      return safeRegexTest(escaped, '', path)
    })
  }
}
