/**
 * @module egress-filter
 * @description Domain matching, tier checking, credential injection, and
 * exfiltration detection for outbound proxy requests.
 */

import type { ServiceDefinition, DataTier } from '../../../types'

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
    const result: Record<string, string> = {}
    for (const [key, template] of Object.entries(service.injection.proxy.headers)) {
      let value = template
      for (const [field, fieldValue] of Object.entries(credentials)) {
        value = value.replace(`\${credential.${field}}`, fieldValue)
      }
      result[key] = value
    }
    return result
  }

  scanForLeaks(
    service: ServiceDefinition,
    body: string,
  ): { safe: boolean; leaked: string[] } {
    const leaked: string[] = []
    for (const pattern of service.dataTier.redaction.patterns) {
      try {
        const regex = new RegExp(pattern, 'g')
        const matches = body.match(regex)
        if (matches) leaked.push(...matches)
      } catch {
        // Invalid regex — skip
      }
    }
    return { safe: leaked.length === 0, leaked }
  }
}
