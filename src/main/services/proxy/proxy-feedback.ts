/**
 * @module proxy-feedback
 * @description Formats proxy enforcement messages for agent terminal output.
 *
 * When the proxy blocks a request, redacts data, or tokenizes values,
 * a formatted message is sent to the agent's PTY so they have visibility
 * into enforcement actions.
 */

import type { ProxyFeedbackMessage } from '../../../types'

const LABELS: Record<ProxyFeedbackMessage['type'], string> = {
  block: 'BLOCKED',
  redaction: 'REDACTED',
  tokenization: 'TOKENIZED',
  'tls-exception': 'TLS-EXCEPTION',
  'scope-violation': 'SCOPE-DENIED',
  'credential-expired': 'CRED-EXPIRED',
  'leak-detected': 'LEAK-DETECTED',
}

/**
 * Format a proxy feedback message as a terminal-friendly string.
 * Uses ANSI dim styling so it's visible but not intrusive.
 */
export function formatFeedback(msg: ProxyFeedbackMessage): string {
  const label = LABELS[msg.type]
  const service = msg.service ? ` (${msg.service})` : ''
  // \x1b[2m = dim, \x1b[0m = reset
  return `\x1b[2m[LATCH] ${label}: ${msg.domain}${service} — ${msg.detail}\x1b[0m\r\n`
}

/**
 * Create a feedback callback that formats and sends messages to a PTY.
 *
 * @param writeFn - Function that writes a string to the agent's terminal
 * @returns A callback suitable for LatchProxyConfig.onFeedback
 */
export function createFeedbackSender(
  writeFn: (data: string) => void,
): (msg: ProxyFeedbackMessage) => void {
  return (msg: ProxyFeedbackMessage) => {
    writeFn(formatFeedback(msg))
  }
}
