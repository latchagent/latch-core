/**
 * @module token-map
 * @description Per-session tokenization with same-origin enforcement.
 *
 * Tokens replace sensitive values in proxy responses. They carry origin
 * metadata (service, tier, endpoint) and can only be de-tokenized when
 * sent back to the originating service (same-origin policy).
 */

import { randomBytes } from 'node:crypto'
import type { TokenEntry, DataTier } from '../../../types'

const TOKEN_RE = /tok_[a-f0-9]{8}/g

export class TokenMap {
  private tokens = new Map<string, TokenEntry>()

  tokenize(
    value: string,
    origin: { service: string; tier: DataTier; endpoint: string },
  ): TokenEntry {
    // Check if this exact value+service is already tokenized
    for (const entry of this.tokens.values()) {
      if (entry.value === value && entry.origin.service === origin.service) {
        return entry
      }
    }

    const id = `tok_${randomBytes(4).toString('hex')}`
    const entry: TokenEntry = {
      id,
      value,
      origin,
      validDestinations: [origin.service],
      createdAt: new Date().toISOString(),
    }
    this.tokens.set(id, entry)
    return entry
  }

  resolve(tokenId: string, destService: string): string | null {
    const entry = this.tokens.get(tokenId)
    if (!entry) return null
    if (!entry.validDestinations.includes(destService)) return null
    return entry.value
  }

  tokenizeInString(
    text: string,
    value: string,
    origin: { service: string; tier: DataTier; endpoint: string },
  ): string {
    if (!text.includes(value)) return text
    const entry = this.tokenize(value, origin)
    return text.replaceAll(value, entry.id)
  }

  detokenizeString(text: string, destService: string): string {
    return text.replace(TOKEN_RE, (match) => {
      const resolved = this.resolve(match, destService)
      return resolved ?? match
    })
  }

  list(): TokenEntry[] {
    return Array.from(this.tokens.values())
  }

  clear(): void {
    this.tokens.clear()
  }
}
