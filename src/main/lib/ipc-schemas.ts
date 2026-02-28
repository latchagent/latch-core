/**
 * @module ipc-schemas
 * @description Zod schemas for validating IPC payloads from the renderer.
 * Prevents type confusion, injection, and resource exhaustion attacks.
 */

import { z } from 'zod'

// ── PTY ──────────────────────────────────────────────────────────────────────

export const PtyCreateSchema = z.object({
  sessionId: z.string().min(1).max(200),
  cwd: z.string().max(1024).optional(),
  cols: z.number().int().min(1).max(10000),
  rows: z.number().int().min(1).max(10000),
  env: z.record(z.string(), z.string().max(10000)).optional(),
  dockerContainerId: z.string().regex(/^[a-f0-9]{12}([a-f0-9]{52})?$/).optional(),
})

export const PtyWriteSchema = z.object({
  sessionId: z.string().min(1).max(200),
  data: z.string(),
})

export const PtyResizeSchema = z.object({
  sessionId: z.string().min(1).max(200),
  cols: z.number().int().min(1).max(10000),
  rows: z.number().int().min(1).max(10000),
})

export const PtyKillSchema = z.object({
  sessionId: z.string().min(1).max(200),
})

// ── Sessions ─────────────────────────────────────────────────────────────────

export const SessionCreateSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  harness_id: z.string().max(100).nullable().optional(),
  harness_command: z.string().max(1024).nullable().optional(),
  repo_root: z.string().max(2048).nullable().optional(),
  worktree_path: z.string().max(2048).nullable().optional(),
  branch_ref: z.string().max(500).nullable().optional(),
  policy_set: z.string().max(200).optional(),
  policy_override: z.any().optional(),
  goal: z.string().max(50000).optional(),
}).passthrough()

export const SessionUpdateSchema = z.object({
  id: z.string().min(1).max(200),
  updates: z.object({}).passthrough(),
})

// ── Policies ─────────────────────────────────────────────────────────────────

export const PolicySaveSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  permissions: z.object({}).passthrough(),
  harnesses: z.object({}).passthrough(),
}).passthrough()

// ── Skills ───────────────────────────────────────────────────────────────────

export const SkillSaveSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  body: z.string().max(100000),
  tags: z.array(z.string().max(100)).max(50).optional(),
  harnesses: z.array(z.string().max(100)).max(20).nullable().optional(),
}).passthrough()

// ── MCP Servers ──────────────────────────────────────────────────────────────

export const McpSaveSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  transport: z.enum(['stdio', 'http']),
  description: z.string().max(5000).optional(),
  command: z.string().max(2048).optional(),
  args: z.array(z.string().max(2048)).max(50).optional(),
  tools: z.array(z.string().max(200)).max(500).optional(),
  toolDescriptions: z.record(z.string(), z.string().max(2000)).optional(),
  env: z.record(z.string(), z.string().max(10000)).optional(),
  url: z.string().max(2048).optional(),
  headers: z.record(z.string(), z.string().max(10000)).optional(),
  harnesses: z.array(z.string().max(100)).max(20).nullable().optional(),
  enabled: z.boolean().optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  catalogId: z.string().max(200).nullable().optional(),
}).passthrough()

// ── Agents ───────────────────────────────────────────────────────────────────

export const AgentsReadSchema = z.object({
  dir: z.string().min(1).max(2048),
})

export const AgentsWriteSchema = z.object({
  filePath: z.string().min(1).max(2048),
  content: z.string().max(500000),
})

// ── Settings ─────────────────────────────────────────────────────────────────

export const SettingsKeySchema = z.object({
  key: z.string().min(1).max(200),
})

export const SettingsSetSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.string().max(50000),
  sensitive: z.boolean().optional(),
})

// ── Secrets ──────────────────────────────────────────────────────────────────

export const SecretSaveSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  key: z.string().min(1).max(200).regex(/^[A-Z0-9_]+$/),
  value: z.string().max(50000),
  description: z.string().max(2000).optional(),
  scope: z.string().max(200).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
})

// ── Docker ───────────────────────────────────────────────────────────────────

export const DockerStartSchema = z.object({
  sessionId: z.string().min(1).max(200),
  image: z.string().min(1).max(500),
  workspacePath: z.string().max(2048).optional(),
  networkEnabled: z.boolean().optional(),
  ports: z.array(z.object({
    host: z.number().int().min(1).max(65535),
    container: z.number().int().min(1).max(65535),
  })).max(20).optional(),
  extraVolumes: z.array(z.object({
    hostPath: z.string().max(2048),
    containerPath: z.string().max(2048),
    readOnly: z.boolean(),
  })).max(20).optional(),
})

// ── Authz ────────────────────────────────────────────────────────────────────

export const AuthzRegisterSchema = z.object({
  sessionId: z.string().min(1).max(200),
  harnessId: z.string().min(1).max(100),
  policyId: z.string().min(1).max(200),
  policyOverride: z.any().nullable().optional(),
})

// ── Helper ───────────────────────────────────────────────────────────────────

/** Validate an IPC payload against a schema. Returns parsed data or error result. */
export function validateIpc<T>(schema: z.ZodType<T>, payload: unknown): { ok: true; data: T } | { ok: false; error: string } {
  const result = schema.safeParse(payload)
  if (result.success) return { ok: true, data: result.data }
  const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  return { ok: false, error: `Invalid payload: ${issues}` }
}
