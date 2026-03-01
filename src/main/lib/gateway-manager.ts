/**
 * @module gateway-manager
 * @description Manages sandbox lifecycle for gateway sessions.
 *
 * Selection cascade: Docker → Seatbelt (macOS) → Bubblewrap (Linux) → null.
 */

import type { ServiceDefinition, SandboxBackend } from '../../types'

export interface GatewayEnvInput {
  proxyPort: number
  authzPort: number
  sessionId: string
  services: ServiceDefinition[]
  credentials: Map<string, Record<string, string>>
  caCertPath?: string  // Phase 2: ephemeral CA cert for TLS interception
}

export class GatewayManager {
  /**
   * Build the environment variables for a gateway session.
   * Includes proxy vars, service-specific env, and Latch metadata.
   */
  static buildGatewayEnv(input: GatewayEnvInput): Record<string, string> {
    const env: Record<string, string> = {
      // Proxy routing — all traffic through Latch proxy
      HTTP_PROXY: `http://127.0.0.1:${input.proxyPort}`,
      HTTPS_PROXY: `http://127.0.0.1:${input.proxyPort}`,
      http_proxy: `http://127.0.0.1:${input.proxyPort}`,
      https_proxy: `http://127.0.0.1:${input.proxyPort}`,
      NO_PROXY: '',

      // Latch metadata
      LATCH_GATEWAY: 'true',
      LATCH_SESSION_ID: input.sessionId,

      // Security hardening
      HISTFILE: '/dev/null',
    }

    // TLS interception — trust the session's ephemeral CA
    if (input.caCertPath) {
      env.NODE_EXTRA_CA_CERTS = input.caCertPath
      env.SSL_CERT_FILE = input.caCertPath
      env.GIT_SSL_CAINFO = input.caCertPath
    }

    // Inject service-specific env vars with credential substitution
    for (const service of input.services) {
      const creds = input.credentials.get(service.id) ?? {}
      for (const [envKey, template] of Object.entries(service.injection.env)) {
        let value = template
        for (const [field, fieldValue] of Object.entries(creds)) {
          value = value.replace(`\${credential.${field}}`, fieldValue)
        }
        // Only set if all placeholders were resolved
        if (!value.includes('${credential.')) {
          env[envKey] = value
        }
      }
    }

    return env
  }

  /**
   * Detect which sandbox backend is available.
   * Selection cascade: Docker → Seatbelt (macOS) → Bubblewrap (Linux) → null.
   */
  static async detectBackend(): Promise<SandboxBackend | null> {
    // 1. Docker
    try {
      const { execSync } = await import('node:child_process')
      execSync('docker info', { stdio: 'ignore', timeout: 5000 })
      return 'docker'
    } catch {
      // Docker not available
    }

    // 2. Seatbelt (macOS)
    if (process.platform === 'darwin') {
      try {
        const { execSync } = await import('node:child_process')
        execSync('which sandbox-exec', { stdio: 'ignore', timeout: 5000 })
        return 'seatbelt'
      } catch {
        // sandbox-exec not available
      }
    }

    // 3. Bubblewrap (Linux)
    if (process.platform === 'linux') {
      try {
        const { execSync } = await import('node:child_process')
        execSync('which bwrap', { stdio: 'ignore', timeout: 5000 })
        return 'bubblewrap'
      } catch {
        // bwrap not available
      }
    }

    return null
  }
}
