/**
 * @module safe-regex
 * @description ReDoS-safe regex testing using a sandboxed VM with a timeout.
 * Extracted from authz-server.ts for reuse across the proxy pipeline.
 */

import vm from 'node:vm'

const REGEX_TIMEOUT_MS = 50

/** Execute a regex test with a timeout to prevent ReDoS attacks. */
export function safeRegexTest(pattern: string, flags: string, input: string): boolean {
  try {
    const sandbox = { result: false, pattern, flags, input }
    vm.runInNewContext(
      'result = new RegExp(pattern, flags).test(input)',
      sandbox,
      { timeout: REGEX_TIMEOUT_MS },
    )
    return sandbox.result
  } catch {
    return false // timeout or invalid regex — treat as no match
  }
}

/**
 * Execute a regex match with a timeout to prevent ReDoS attacks.
 * Returns all matches or null if no matches / timeout / invalid pattern.
 */
export function safeRegexMatch(pattern: string, flags: string, input: string): string[] | null {
  try {
    const sandbox = { result: null as string[] | null, pattern, flags, input }
    vm.runInNewContext(
      'result = input.match(new RegExp(pattern, flags))',
      sandbox,
      { timeout: REGEX_TIMEOUT_MS },
    )
    return sandbox.result
  } catch {
    return null // timeout or invalid regex — treat as no match
  }
}
