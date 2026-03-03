// src/main/lib/leak-scanner.ts

/**
 * @module leak-scanner
 * @description Pure computation module that scans strings for credential
 * patterns. No I/O — takes a string, returns an array of LeakMatch objects.
 * Modeled after loop-detector.ts.
 */

import type { LeakMatch } from '../../types'

// ── Pattern Definitions ────────────────────────────────────────────────────

interface PatternDef {
  kind: string
  regex: RegExp
  redact: (match: string) => string
}

const PATTERNS: PatternDef[] = [
  {
    kind: 'aws-access-key',
    regex: /AKIA[0-9A-Z]{16}/g,
    redact: (m) => m.slice(0, 4) + '****' + m.slice(-4),
  },
  {
    kind: 'aws-secret-key',
    regex: /(?:aws_secret_access_key|AWS_SECRET)["\s:=]+([A-Za-z0-9/+=]{40})/gi,
    redact: () => '****[AWS Secret Key]****',
  },
  {
    kind: 'github-token',
    regex: /\b(ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})\b/g,
    redact: (m) => m.slice(0, 4) + '****' + m.slice(-4),
  },
  {
    kind: 'openai-anthropic-key',
    regex: /\bsk-[a-zA-Z0-9]{20,}\b/g,
    redact: (m) => 'sk-****' + m.slice(-4),
  },
  {
    kind: 'stripe-key',
    regex: /\b(sk_live_[A-Za-z0-9]{24,}|pk_live_[A-Za-z0-9]{24,}|rk_live_[A-Za-z0-9]{24,})\b/g,
    redact: (m) => m.slice(0, 8) + '****' + m.slice(-4),
  },
  {
    kind: 'private-key',
    regex: /-----BEGIN[A-Z ]*PRIVATE KEY-----/g,
    redact: () => '-----BEGIN ****PRIVATE KEY-----',
  },
  {
    kind: 'env-credential',
    regex: /\b(PASSWORD|SECRET|API_KEY|TOKEN|PRIVATE_KEY|AUTH_TOKEN|ACCESS_TOKEN)\s*[=:]\s*["']?([^\s"']{8,})["']?/gi,
    redact: (m) => {
      const eq = m.indexOf('=')
      const colon = m.indexOf(':')
      const sep = eq >= 0 ? eq : colon
      if (sep === -1) return m.slice(0, 10) + '****'
      return m.slice(0, sep + 1) + '****'
    },
  },
]

// ── Shannon Entropy ────────────────────────────────────────────────────────

const ENTROPY_THRESHOLD = 4.5
const MIN_ENTROPY_LENGTH = 20
const ENTROPY_REGEX = /[A-Za-z0-9/+=]{20,}/g

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let entropy = 0
  for (const count of freq.values()) {
    const p = count / s.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Scan a string for credential patterns.
 * Returns an array of LeakMatch objects (empty if no leaks found).
 */
export function scanForLeaks(
  text: string,
  filePath?: string,
): LeakMatch[] {
  const matches: LeakMatch[] = []
  const seen = new Set<string>()

  // Named patterns
  for (const pat of PATTERNS) {
    pat.regex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pat.regex.exec(text)) !== null) {
      const raw = m[0]
      const key = `${pat.kind}:${raw}`
      if (seen.has(key)) continue
      seen.add(key)

      const line = filePath ? text.slice(0, m.index).split('\n').length : undefined

      matches.push({
        kind: pat.kind,
        preview: pat.redact(raw),
        filePath,
        line,
      })
    }
  }

  // High-entropy strings (skip if already matched a named pattern)
  ENTROPY_REGEX.lastIndex = 0
  let em: RegExpExecArray | null
  while ((em = ENTROPY_REGEX.exec(text)) !== null) {
    const raw = em[0]
    if (raw.length < MIN_ENTROPY_LENGTH) continue

    // Skip if this substring was already caught by a named pattern
    let alreadyCaught = false
    for (const s of seen) {
      const matchedStr = s.split(':').slice(1).join(':')
      if (matchedStr && (raw.includes(matchedStr) || matchedStr.includes(raw))) {
        alreadyCaught = true
        break
      }
    }
    if (alreadyCaught) continue

    const entropy = shannonEntropy(raw)
    if (entropy >= ENTROPY_THRESHOLD) {
      const key = `high-entropy:${raw}`
      if (seen.has(key)) continue
      seen.add(key)

      matches.push({
        kind: 'high-entropy',
        preview: raw.slice(0, 6) + '****' + raw.slice(-4),
        filePath,
        line: filePath ? text.slice(0, em.index).split('\n').length : undefined,
      })
    }
  }

  return matches
}
