/**
 * @module policy-generator
 * @description Uses OpenAI structured output with Zod to generate
 * PolicyDocument objects from natural language descriptions.
 */

import { z } from 'zod'
import OpenAI from 'openai'
import { zodResponseFormat } from 'openai/helpers/zod'
import type { PolicyDocument } from '../../types'

// ─── Zod schemas matching PolicyDocument ──────────────────────────────────────

const PolicyPermissionsSchema = z.object({
  allowBash:           z.boolean().describe('Whether shell/bash execution is allowed.'),
  allowNetwork:        z.boolean().describe('Whether network access (web fetch, web search) is allowed.'),
  allowFileWrite:      z.boolean().describe('Whether file write/edit operations are allowed.'),
  confirmDestructive:  z.boolean().describe('Whether destructive operations require confirmation.'),
  blockedGlobs:        z.array(z.string()).describe('File path globs that are blocked from access. E.g. ["/etc/**", "~/.ssh/**"].'),
})

const ClaudePolicyConfigSchema = z.object({
  allowedTools: z.array(z.string()).optional().nullable().describe('Whitelist of Claude Code tool names (PascalCase). E.g. ["Read", "Write", "Bash"].'),
  deniedTools:  z.array(z.string()).optional().nullable().describe('Blacklist of Claude Code tool names.'),
})

const CodexPolicyConfigSchema = z.object({
  approvalMode: z.enum(['auto', 'read-only', 'full']).optional().nullable().describe('Codex approval mode.'),
  sandbox:      z.enum(['strict', 'moderate', 'permissive']).optional().nullable().describe('Codex sandbox level.'),
  deniedCommands: z.array(z.string()).optional().nullable().describe('Shell command prefixes to block.'),
  promptCommands: z.array(z.string()).optional().nullable().describe('Shell command prefixes requiring approval.'),
})

const OpenClawPolicyConfigSchema = z.object({
  allowedTools: z.array(z.string()).optional().nullable().describe('Whitelist of OpenClaw tool names (lowercase).'),
  deniedTools:  z.array(z.string()).optional().nullable().describe('Blacklist of OpenClaw tool names.'),
})

const HarnessesConfigSchema = z.object({
  claude:   ClaudePolicyConfigSchema.optional().nullable(),
  codex:    CodexPolicyConfigSchema.optional().nullable(),
  openclaw: OpenClawPolicyConfigSchema.optional().nullable(),
})

const PolicyDocumentSchema = z.object({
  id:          z.string().describe('A short kebab-case ID for this policy.'),
  name:        z.string().describe('Human-readable name for the policy.'),
  description: z.string().describe('One-sentence description of what this policy does.'),
  permissions: PolicyPermissionsSchema,
  harnesses:   HarnessesConfigSchema,
})

// ─── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a policy generator for Latch Desktop, a terminal control plane for LLM coding harnesses (Claude Code, Codex, OpenClaw).

You generate PolicyDocument objects that control what AI agents can do.

## Permission flags
- allowBash: Allow shell/command execution
- allowNetwork: Allow web fetch, web search, HTTP requests
- allowFileWrite: Allow file write and edit operations
- confirmDestructive: Require confirmation for destructive ops
- blockedGlobs: File path patterns to block (e.g. "/etc/**", "~/.ssh/**", "*.env")

## Harness configs
- Claude Code tools use PascalCase: Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, Task
- Codex uses approvalMode (auto|read-only|full), sandbox (strict|moderate|permissive), deniedCommands, promptCommands
- OpenClaw tools use lowercase: read, write, exec, web_search, web_fetch, browser

## Example policies

1. Default (balanced):
   - allowBash: true, allowNetwork: true, allowFileWrite: true, confirmDestructive: true
   - blockedGlobs: ["/etc/**", "~/.ssh/**"]

2. Strict (locked down):
   - allowBash: true, allowNetwork: false, allowFileWrite: true, confirmDestructive: true
   - blockedGlobs: ["/etc/**", "~/.ssh/**", "~/.aws/**", "*.env", "*.key", "*.pem"]
   - Claude: allowedTools: ["Read", "Write", "Bash"]
   - Codex: approvalMode: "full", sandbox: "strict"

3. Read-Only (observation only):
   - allowBash: false, allowNetwork: false, allowFileWrite: false, confirmDestructive: true
   - Claude: allowedTools: ["Read", "Glob", "Grep"]

Generate a policy matching the user's description. Use reasonable defaults for unspecified fields. The id should be a short kebab-case string.`

// ─── Helpers ────────────────────────────────────────────────────────────────

function getOpenAIClient(apiKey?: string): OpenAI {
  const key = apiKey || process.env.OPENAI_API_KEY
  if (!key) {
    throw new Error('OpenAI API key not configured. Set it in Model Providers or via OPENAI_API_KEY env var.')
  }
  return new OpenAI({ apiKey: key })
}

// ─── Session title generator ────────────────────────────────────────────────

/**
 * Generate a short, descriptive session title from the user's goal.
 * Returns a 2-5 word title. Falls back to a truncated goal if no API key.
 */
export async function generateSessionTitle(goal: string, apiKey?: string): Promise<string> {
  if (!apiKey && !process.env.OPENAI_API_KEY) {
    // Graceful fallback: truncate goal to ~30 chars
    return goal.length <= 30 ? goal : goal.slice(0, 27) + '...'
  }

  const openai = getOpenAIClient(apiKey)

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'Generate a short session title (2-5 words, no quotes) that summarizes the user\'s coding goal. Be specific and concise. Examples: "Auth Login Flow", "Fix CI Pipeline", "Add Dark Mode", "Refactor API Layer".',
      },
      { role: 'user', content: goal },
    ],
    max_tokens: 20,
    temperature: 0.3,
  })

  const title = completion.choices[0]?.message?.content?.trim()
  if (!title) return goal.length <= 30 ? goal : goal.slice(0, 27) + '...'
  return title
}

// ─── Policy generator ───────────────────────────────────────────────────────

/**
 * Generate a PolicyDocument from a natural language prompt using OpenAI structured output.
 * Requires OPENAI_API_KEY environment variable.
 */
export async function generatePolicy(prompt: string, apiKey?: string): Promise<PolicyDocument> {
  const openai = getOpenAIClient(apiKey)

  const completion = await openai.chat.completions.parse({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    response_format: zodResponseFormat(PolicyDocumentSchema, 'policy'),
  })

  const parsed = completion.choices[0]?.message?.parsed
  if (!parsed) {
    throw new Error('No policy generated. The model returned an empty response.')
  }

  // Validate with Zod for safety
  const validated = PolicyDocumentSchema.parse(parsed)

  // Assign a unique ID
  const policy: PolicyDocument = {
    ...validated,
    id: `policy-${Date.now()}`,
  }

  return policy
}
