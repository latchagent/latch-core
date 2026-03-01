/**
 * @module credential-manager
 * @description Manages credential lifecycle: expiry detection, validation,
 * usage tracking, and status reporting.
 *
 * Does NOT store credentials — that's SecretStore's job. This module
 * tracks metadata about credential health and provides lifecycle hooks.
 */

import type { ServiceDefinition } from '../../types'
import { interpolateCredentialHeaders } from '../lib/credential-utils'

export interface CredentialStatus {
  serviceId: string
  valid: boolean
  lastValidated: string | null
  lastUsed: string | null
  expired: boolean
}

export interface ValidationResult {
  valid: boolean
  status: number | null
  error?: string
}

export class CredentialManager {
  private statuses = new Map<string, CredentialStatus>()

  /** Check if a service's credential has expired based on expiresAt. */
  isExpired(service: ServiceDefinition): boolean {
    const expiresAt = service.credential.expiresAt
    if (!expiresAt) return false
    return new Date(expiresAt).getTime() < Date.now()
  }

  /**
   * Validate a credential by making a lightweight request to the service.
   * Uses the first domain in the service's proxy config.
   */
  async validateCredential(
    service: ServiceDefinition,
    credentials: Record<string, string>,
  ): Promise<ValidationResult> {
    const domain = service.injection.proxy.domains[0]
    if (!domain) return { valid: false, status: null, error: 'No domain configured' }

    try {
      // Build headers with credential injection
      const headers = interpolateCredentialHeaders(service.injection.proxy.headers, credentials)

      const response = await fetch(`https://${domain}/`, {
        method: 'HEAD',
        headers,
        signal: AbortSignal.timeout(5000),
      })

      const valid = response.ok || response.status === 404 || response.status === 405
      this.recordValidation(service.id, valid)
      return { valid, status: response.status }
    } catch (err: unknown) {
      return { valid: false, status: null, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Record that a credential was validated. */
  recordValidation(serviceId: string, valid: boolean): void {
    const existing = this.statuses.get(serviceId) ?? this._defaultStatus(serviceId)
    existing.valid = valid
    existing.lastValidated = new Date().toISOString()
    existing.expired = !valid
    this.statuses.set(serviceId, existing)
  }

  /** Record that a credential was used (injected into a request). */
  recordUsage(serviceId: string): void {
    const existing = this.statuses.get(serviceId) ?? this._defaultStatus(serviceId)
    existing.lastUsed = new Date().toISOString()
    this.statuses.set(serviceId, existing)
  }

  /** Get the current status for a service's credential. */
  getStatus(serviceId: string): CredentialStatus {
    return this.statuses.get(serviceId) ?? this._defaultStatus(serviceId)
  }

  private _defaultStatus(serviceId: string): CredentialStatus {
    return { serviceId, valid: true, lastValidated: null, lastUsed: null, expired: false }
  }
}
