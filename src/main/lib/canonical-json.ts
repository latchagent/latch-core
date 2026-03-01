/**
 * @module canonical-json
 * @description Canonical JSON serialization with recursively sorted keys.
 *
 * Produces a deterministic JSON string regardless of object key insertion order,
 * which is required for hashing and signing operations.
 */

/**
 * Serialize a value to canonical JSON with recursively sorted object keys.
 * Arrays preserve order; primitives serialize normally.
 */
export function canonicalJsonStringify(obj: unknown): string {
  return JSON.stringify(sortKeys(obj))
}

function sortKeys(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys)
  }
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key])
  }
  return sorted
}
