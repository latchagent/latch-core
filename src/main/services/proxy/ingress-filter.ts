/**
 * @module ingress-filter
 * @description Content-type-aware response body scanning and tokenization.
 *
 * Scans HTTP response bodies for sensitive patterns defined by the originating
 * service. Text and JSON responses are scanned; binary content (images,
 * archives, git packfiles) is passed through without body inspection.
 *
 * Matched values are tokenized via the session's TokenMap with same-origin
 * metadata so they can only be de-tokenized when sent back to the
 * originating service.
 *
 * Note: This filter only tokenizes — it does not redact (remove) content.
 * The `redactionsApplied` field is always 0 and exists for interface compatibility.
 */

import { TokenMap } from './token-map'
import { safeRegexMatch } from '../../lib/safe-regex'
import type { ServiceDefinition, IngressScanResult } from '../../../types'

/** Content types that are safe to scan as text. */
const SCANNABLE_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/x-www-form-urlencoded']

export class IngressFilter {
  private tokenMap: TokenMap

  constructor(tokenMap: TokenMap) {
    this.tokenMap = tokenMap
  }

  /** Check if a Content-Type header value indicates scannable text content. */
  isScannable(contentType: string | null): boolean {
    if (!contentType) return false
    const lower = contentType.toLowerCase().split(';')[0].trim()
    return SCANNABLE_PREFIXES.some(prefix => lower.startsWith(prefix))
  }

  /**
   * Scan a response body for sensitive content.
   *
   * @param contentType - The Content-Type header value (null = unknown)
   * @param body - The response body as a string
   * @param service - The service definition (provides redaction patterns)
   * @param endpoint - The request path (for token origin metadata)
   * @returns Scan result with processed body and statistics
   */
  scanResponse(
    contentType: string | null,
    body: string,
    service: ServiceDefinition,
    endpoint: string,
  ): IngressScanResult {
    if (!this.isScannable(contentType)) {
      return {
        scanned: false,
        contentType,
        redactionsApplied: 0,
        tokenizationsApplied: 0,
        processedBody: null,
      }
    }

    let processedBody = body
    let tokenizationsApplied = 0

    // Apply each redaction pattern from the service definition
    for (const pattern of service.dataTier.redaction.patterns) {
      const matches = safeRegexMatch(pattern, 'g', processedBody)
      if (matches) {
        for (const match of matches) {
          processedBody = this.tokenMap.tokenizeInString(
            processedBody,
            match,
            {
              service: service.id,
              tier: service.dataTier.defaultTier,
              endpoint,
            },
          )
          tokenizationsApplied++
        }
      }
    }

    return {
      scanned: true,
      contentType,
      redactionsApplied: 0, // This filter only tokenizes, not redacts
      tokenizationsApplied,
      processedBody,
    }
  }
}
