/**
 * @module secret-resolver
 * @description Resolves `${secret:KEY}` references from the SecretStore.
 *
 * Used by mcp-sync.ts and pty-manager.ts to replace secret placeholders
 * with real values at runtime — without writing raw secrets to disk.
 */

import type { SecretStore } from '../stores/secret-store'

const SECRET_REF_PATTERN = /\$\{secret:([^}]+)\}/g

/** Resolve all `${secret:KEY}` references in a string. Unresolved refs are left as-is. */
export function resolveSecretRefs(template: string, store: SecretStore): string {
  return template.replace(SECRET_REF_PATTERN, (_match, key: string) => {
    const value = store.resolve(key)
    return value ?? _match
  })
}

/** Resolve all `${secret:KEY}` references in an env var record. */
export function resolveEnvSecrets(
  env: Record<string, string>,
  store: SecretStore,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    result[k] = resolveSecretRefs(v, store)
  }
  return result
}

/** Extract all secret keys referenced in a string. */
export function extractSecretKeys(template: string): string[] {
  const keys: string[] = []
  let match: RegExpExecArray | null
  const re = new RegExp(SECRET_REF_PATTERN.source, 'g')
  while ((match = re.exec(template)) !== null) {
    keys.push(match[1])
  }
  return keys
}

/** Validate that all referenced secrets exist. Returns keys that are missing. */
export function validateSecretRefs(
  env: Record<string, string>,
  store: SecretStore,
): string[] {
  const missing: string[] = []
  for (const v of Object.values(env)) {
    for (const key of extractSecretKeys(v)) {
      if (!store.has(key)) missing.push(key)
    }
  }
  return [...new Set(missing)]
}
