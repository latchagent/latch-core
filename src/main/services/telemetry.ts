/**
 * @module telemetry
 * @description Anonymous usage telemetry via Aptabase.
 *
 * Telemetry is opt-in — disabled by default. Users enable it in
 * Settings → Anonymous telemetry. No personal data is ever collected;
 * Aptabase enforces anonymity at the SDK level (no user IDs, no IP storage).
 *
 * All tracking calls are no-ops when telemetry is disabled or before
 * the module is initialised.
 *
 * IMPORTANT: `initTelemetrySDK()` must be called BEFORE `app.whenReady()`
 * (Aptabase requirement). Call `bindTelemetrySettings()` later once the
 * SettingsStore is available.
 */

import { initialize, trackEvent } from '@aptabase/electron/main'

// ─── State ───────────────────────────────────────────────────────────────────

let initialised = false
let enabled     = false

/** Reference to SettingsStore.get so we can check the toggle at call time. */
let getSetting: ((key: string) => string | null) | null = null

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialise the Aptabase SDK. Must be called BEFORE `app.whenReady()`.
 */
export function initTelemetrySDK(appKey: string): void {
  if (!appKey) return
  try {
    initialize(appKey)
    initialised = true
  } catch (err: unknown) {
    console.warn('[telemetry] Aptabase init failed:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Bind the settings store so `track()` can check the telemetry toggle.
 * Call after the DB / SettingsStore is ready (inside `app.whenReady()`).
 */
export function bindTelemetrySettings(getter: (key: string) => string | null): void {
  getSetting = getter
  enabled = getter('telemetry-enabled') === 'true'
}

/**
 * Track an anonymous event. No-op if telemetry is disabled.
 *
 * @param event  Event name (e.g. "session_created").
 * @param props  Optional string/number/boolean properties.
 */
export async function track(
  event: string,
  props?: Record<string, string | number | boolean>
): Promise<void> {
  // Re-read the setting each time so toggling takes effect immediately
  if (getSetting) {
    enabled = getSetting('telemetry-enabled') === 'true'
  }

  if (!enabled || !initialised) return

  try {
    await trackEvent(event, props)
  } catch (err: unknown) {
    console.warn('[telemetry] Failed to track event:', event, err instanceof Error ? err.message : String(err))
  }
}
