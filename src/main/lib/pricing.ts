/**
 * @module pricing
 * @description Hardcoded model pricing table and cost calculator.
 * No network calls — pricing ships with the app.
 */

/** Per-million-token rates */
export interface ModelPricing {
  inputPerMTok: number
  outputPerMTok: number
  cacheWritePerMTok: number
  cacheReadPerMTok: number
}

/** Token counts extracted from a single assistant turn */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
}

// ── Pricing Table ───────────────────────────────────────────────────────────

const CLAUDE_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6':   { inputPerMTok: 5.00,  outputPerMTok: 25.00, cacheWritePerMTok: 10.00, cacheReadPerMTok: 0.50 },
  'claude-opus-4-5':   { inputPerMTok: 5.00,  outputPerMTok: 25.00, cacheWritePerMTok: 10.00, cacheReadPerMTok: 0.50 },
  'claude-opus-4-1':   { inputPerMTok: 15.00, outputPerMTok: 75.00, cacheWritePerMTok: 30.00, cacheReadPerMTok: 1.50 },
  'claude-opus-4':     { inputPerMTok: 15.00, outputPerMTok: 75.00, cacheWritePerMTok: 30.00, cacheReadPerMTok: 1.50 },
  'claude-sonnet-4-6': { inputPerMTok: 3.00,  outputPerMTok: 15.00, cacheWritePerMTok: 6.00,  cacheReadPerMTok: 0.30 },
  'claude-sonnet-4-5': { inputPerMTok: 3.00,  outputPerMTok: 15.00, cacheWritePerMTok: 6.00,  cacheReadPerMTok: 0.30 },
  'claude-sonnet-4':   { inputPerMTok: 3.00,  outputPerMTok: 15.00, cacheWritePerMTok: 6.00,  cacheReadPerMTok: 0.30 },
  'claude-haiku-4-5':  { inputPerMTok: 1.00,  outputPerMTok: 5.00,  cacheWritePerMTok: 2.00,  cacheReadPerMTok: 0.10 },
  'claude-haiku-3-5':  { inputPerMTok: 0.80,  outputPerMTok: 4.00,  cacheWritePerMTok: 1.60,  cacheReadPerMTok: 0.08 },
  'claude-haiku-3':    { inputPerMTok: 0.25,  outputPerMTok: 1.25,  cacheWritePerMTok: 0.50,  cacheReadPerMTok: 0.03 },
}

const OPENAI_PRICING: Record<string, ModelPricing> = {
  'gpt-5-codex':   { inputPerMTok: 1.25, outputPerMTok: 10.00, cacheWritePerMTok: 0, cacheReadPerMTok: 0.125 },
  'gpt-5.1-codex': { inputPerMTok: 1.25, outputPerMTok: 10.00, cacheWritePerMTok: 0, cacheReadPerMTok: 0.125 },
  'gpt-5':         { inputPerMTok: 1.25, outputPerMTok: 10.00, cacheWritePerMTok: 0, cacheReadPerMTok: 0.125 },
  'gpt-5.1':       { inputPerMTok: 1.25, outputPerMTok: 10.00, cacheWritePerMTok: 0, cacheReadPerMTok: 0.125 },
  'gpt-4.1':       { inputPerMTok: 2.00, outputPerMTok: 8.00,  cacheWritePerMTok: 0, cacheReadPerMTok: 0.50  },
  'gpt-4.1-mini':  { inputPerMTok: 0.40, outputPerMTok: 1.60,  cacheWritePerMTok: 0, cacheReadPerMTok: 0.10  },
  'gpt-4o':        { inputPerMTok: 2.50, outputPerMTok: 10.00, cacheWritePerMTok: 0, cacheReadPerMTok: 1.25  },
  'gpt-4o-mini':   { inputPerMTok: 0.15, outputPerMTok: 0.60,  cacheWritePerMTok: 0, cacheReadPerMTok: 0.075 },
  'o3':            { inputPerMTok: 2.00, outputPerMTok: 8.00,  cacheWritePerMTok: 0, cacheReadPerMTok: 0.50  },
  'o3-mini':       { inputPerMTok: 1.10, outputPerMTok: 4.40,  cacheWritePerMTok: 0, cacheReadPerMTok: 0.55  },
  'o4-mini':       { inputPerMTok: 1.10, outputPerMTok: 4.40,  cacheWritePerMTok: 0, cacheReadPerMTok: 0.275 },
}

/** Most expensive Claude rate — fallback for unknown Claude models */
const CLAUDE_FALLBACK = CLAUDE_PRICING['claude-opus-4-1']
/** Most expensive OpenAI rate — fallback for unknown OpenAI models */
const OPENAI_FALLBACK = OPENAI_PRICING['o3']

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Strip date suffix from model ID.
 * e.g. "claude-opus-4-6-20260101" → "claude-opus-4-6"
 */
export function normalizeModelId(raw: string): string {
  return raw.replace(/-\d{8}$/, '')
}

/**
 * Look up pricing for a model ID.
 * Falls back to the most expensive model in the family for safety.
 */
export function getModelPricing(rawModelId: string): ModelPricing {
  const id = normalizeModelId(rawModelId)
  if (CLAUDE_PRICING[id]) return CLAUDE_PRICING[id]
  if (OPENAI_PRICING[id]) return OPENAI_PRICING[id]

  // Fuzzy family match
  if (id.startsWith('claude-')) {
    console.warn(`[pricing] Unknown Claude model "${id}", using opus-4-1 fallback`)
    return CLAUDE_FALLBACK
  }
  if (id.startsWith('gpt-') || id.startsWith('o3') || id.startsWith('o4')) {
    console.warn(`[pricing] Unknown OpenAI model "${id}", using o3 fallback`)
    return OPENAI_FALLBACK
  }

  console.warn(`[pricing] Unknown model family "${id}", using Claude opus fallback`)
  return CLAUDE_FALLBACK
}

/**
 * Calculate cost in USD for a single turn's token usage.
 */
export function calculateCost(usage: TokenUsage, rawModelId: string): number {
  const pricing = getModelPricing(rawModelId)
  const cost =
    (usage.inputTokens / 1_000_000) * pricing.inputPerMTok +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMTok +
    (usage.cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMTok +
    (usage.cacheReadTokens / 1_000_000) * pricing.cacheReadPerMTok
  return Math.round(cost * 1_000_000) / 1_000_000 // 6 decimal precision
}

/**
 * Detect harness family from model ID.
 */
export function harnessFromModel(rawModelId: string): 'claude' | 'codex' | 'unknown' {
  const id = normalizeModelId(rawModelId)
  if (id.startsWith('claude-')) return 'claude'
  if (id.startsWith('gpt-') || id.startsWith('o3') || id.startsWith('o4')) return 'codex'
  return 'unknown'
}
