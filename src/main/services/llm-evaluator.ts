/**
 * @module llm-evaluator
 * @description Runtime LLM-based tool call evaluator for the authz decision chain.
 *
 * When enabled in a policy's `llmEvaluator` config, unmatched tool calls are sent
 * to an LLM (via the user's OpenAI API key) that evaluates them against the
 * policy's intent description and returns allow/deny/prompt.
 *
 * This acts as a smart fallback for cases that are hard to express as static rules.
 */

import OpenAI from 'openai'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LlmEvaluatorConfig {
  enabled: boolean
  intent: string
  scope: 'fallback' | 'all-mcp' | 'specific-servers'
  servers?: string[]
  model?: string
}

export interface LlmEvalResult {
  decision: 'allow' | 'deny' | 'prompt'
  reason: string
}

// ─── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a security policy evaluator for an AI coding agent. Your job is to decide whether a tool call should be allowed, denied, or require human approval based on a policy intent.

Rules:
- Respond with exactly one decision: ALLOW, DENY, or PROMPT
- Follow it with a brief reason (one sentence)
- ALLOW: The tool call is clearly safe and consistent with the policy intent
- DENY: The tool call clearly violates the policy intent
- PROMPT: The tool call is ambiguous — a human should review it
- When in doubt, choose PROMPT over ALLOW
- Format: "DECISION: reason"

Examples:
- "ALLOW: Reading repository metadata is a read-only operation consistent with the policy."
- "DENY: Deleting a branch violates the read-only policy intent."
- "PROMPT: Creating an issue may or may not be desired — user should confirm."
`

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Evaluate a tool call using an LLM.
 *
 * @param config     LLM evaluator configuration from the policy.
 * @param toolName   Full tool name (e.g. "mcp__github__create_issue").
 * @param toolInput  Tool arguments (sanitized — no secrets).
 * @param actionClass  The classified action type (read/write/execute/send).
 * @param apiKey     User's OpenAI API key.
 * @returns          Decision and reason.
 */
export async function evaluateWithLlm(
  config: LlmEvaluatorConfig,
  toolName: string,
  toolInput: Record<string, unknown>,
  actionClass: string,
  apiKey: string,
): Promise<LlmEvalResult> {
  const model = config.model || 'gpt-4o-mini'

  // Sanitize tool input — truncate large values, remove potential secrets
  const sanitizedInput = sanitizeInput(toolInput)

  const userMessage = [
    `Policy intent: "${config.intent}"`,
    '',
    'A tool call has been made:',
    `- Tool: ${toolName}`,
    `- Action class: ${actionClass}`,
    `- Arguments: ${JSON.stringify(sanitizedInput, null, 2)}`,
    '',
    'Should this tool call be ALLOW, DENY, or PROMPT?',
  ].join('\n')

  try {
    const client = new OpenAI({ apiKey })

    const response = await Promise.race([
      client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 150,
        temperature: 0,
      }),
      timeout(5000),
    ])

    if (!response || !('choices' in response)) {
      return { decision: 'deny', reason: 'LLM evaluation timed out — denied by default.' }
    }

    const text = response.choices[0]?.message?.content?.trim() ?? ''
    return parseResponse(text)
  } catch (err: any) {
    console.error('[llm-evaluator] Evaluation failed:', err?.message)
    return { decision: 'deny', reason: `LLM evaluation failed: ${err?.message ?? 'unknown error'}` }
  }
}

/**
 * Check whether the LLM evaluator should run for this tool call.
 */
export function shouldEvaluate(config: LlmEvaluatorConfig, toolName: string): boolean {
  if (!config.enabled) return false

  switch (config.scope) {
    case 'fallback':
      return true
    case 'all-mcp':
      return toolName.startsWith('mcp__')
    case 'specific-servers':
      return (config.servers ?? []).some(s => toolName.startsWith(`mcp__${s}__`))
    default:
      return false
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseResponse(text: string): LlmEvalResult {
  const upper = text.toUpperCase()

  if (upper.startsWith('ALLOW')) {
    return { decision: 'allow', reason: extractReason(text) }
  }
  if (upper.startsWith('DENY')) {
    return { decision: 'deny', reason: extractReason(text) }
  }
  if (upper.startsWith('PROMPT')) {
    return { decision: 'prompt', reason: extractReason(text) }
  }

  // Fallback: look for keywords anywhere
  if (upper.includes('ALLOW')) return { decision: 'allow', reason: extractReason(text) }
  if (upper.includes('DENY')) return { decision: 'deny', reason: extractReason(text) }
  if (upper.includes('PROMPT')) return { decision: 'prompt', reason: extractReason(text) }

  // Unparseable — deny by default
  return { decision: 'deny', reason: 'LLM response could not be parsed — denied by default.' }
}

function extractReason(text: string): string {
  // Remove "DECISION:" prefix and clean up
  const cleaned = text.replace(/^(ALLOW|DENY|PROMPT)\s*:?\s*/i, '').trim()
  return cleaned || 'No reason provided.'
}

function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > 500) {
      result[key] = value.slice(0, 500) + '...[truncated]'
    } else {
      result[key] = value
    }
  }
  return result
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('LLM evaluation timed out')), ms)
  })
}
