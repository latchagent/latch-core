/**
 * @module credential-utils
 * @description Shared credential template interpolation.
 * Replaces ${credential.<field>} placeholders in header templates
 * with actual credential values.
 */

/**
 * Interpolate credential fields into header templates.
 * Each template value may contain `${credential.<field>}` placeholders.
 */
export function interpolateCredentialHeaders(
  headerTemplates: Record<string, string>,
  credentials: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, template] of Object.entries(headerTemplates)) {
    let value = template
    for (const [field, fieldValue] of Object.entries(credentials)) {
      value = value.replace(`\${credential.${field}}`, fieldValue)
    }
    result[key] = value
  }
  return result
}
