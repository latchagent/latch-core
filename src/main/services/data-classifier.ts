/**
 * @module data-classifier
 * @description LLM-assisted data classification for response bodies.
 *
 * Design principle: LLMs may PROPOSE classifications but NEVER ENFORCE.
 * All classifications are advisory — the user must review and promote
 * suggestions to service definition patterns.
 */

import type { DataClassification, DataTier } from '../../types'

const VALID_TIERS: DataTier[] = ['public', 'internal', 'confidential', 'restricted']

const MAX_BODY_LENGTH = 4000

/** Build the classification prompt for the LLM. */
export function buildClassificationPrompt(
  body: string,
  serviceId: string,
  contentType: string,
): string {
  const excerpt = body.length > MAX_BODY_LENGTH
    ? body.slice(0, MAX_BODY_LENGTH) + '\n... [truncated]'
    : body

  return `You are a data classification assistant. Analyze the following API response body and classify its sensitivity tier.

Service: ${serviceId}
Content-Type: ${contentType}

Response body:
\`\`\`
${excerpt}
\`\`\`

Classify the data into one of these tiers:
- public: No sensitive data, safe for any context
- internal: Internal identifiers, non-public URLs, internal config
- confidential: PII (emails, names, addresses), API keys, tokens, credentials
- restricted: Financial data, health records, SSNs, encryption keys

Respond with a JSON object:
{
  "suggestedTier": "<tier>",
  "confidence": <0-1>,
  "patterns": ["<pattern description>", ...],
  "reasoning": "<explanation>"
}`
}

/** Parse and validate the LLM's classification response. */
export function parseClassificationResponse(response: string): DataClassification | null {
  try {
    const parsed = JSON.parse(response)
    if (!VALID_TIERS.includes(parsed.suggestedTier)) return null
    if (typeof parsed.confidence !== 'number') return null

    return {
      suggestedTier: parsed.suggestedTier,
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
      patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
      reasoning: String(parsed.reasoning ?? ''),
    }
  } catch {
    return null
  }
}

/**
 * Data classifier using the OpenAI API (same dep as policy-generator).
 * Requires an OpenAI API key in settings.
 */
export class DataClassifier {
  private apiKey: string | null

  constructor(apiKey: string | null) {
    this.apiKey = apiKey
  }

  /** Classify a response body. Returns null if no API key or classification fails. */
  async classify(
    body: string,
    serviceId: string,
    contentType: string,
  ): Promise<DataClassification | null> {
    if (!this.apiKey) return null

    const prompt = buildClassificationPrompt(body, serviceId, contentType)

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(15000),
      })

      if (!response.ok) return null

      const data = await response.json() as any
      const content = data.choices?.[0]?.message?.content
      if (!content) return null

      return parseClassificationResponse(content)
    } catch {
      return null
    }
  }
}
