/**
 * @module UpdateBanner
 * @description Thin banner that appears when an app update is available.
 *
 * States:
 *  - available  → "Latch v{x} is available" + Download button
 *  - downloading → progress bar
 *  - downloaded → "Ready to install" + Restart button
 *  - error → error message + Retry button
 *
 * Listens to the `latch:updater-status` push event and can trigger
 * download / install via the preload API.
 */

import React, { useEffect, useState } from 'react'
import type { UpdateState } from '../../types'

export default function UpdateBanner() {
  const [state, setState] = useState<UpdateState | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    // Seed from current state
    window.latch?.getUpdateState?.().then((s) => {
      if (s.ok) setState(s)
    })
    // Listen for push updates
    const dispose = window.latch?.onUpdaterStatus?.((s) => {
      setState(s)
      setDismissed(false) // re-show on new status
    })
    return () => { dispose?.() }
  }, [])

  // Check on mount (delayed so boot doesn't stall)
  useEffect(() => {
    const timer = setTimeout(() => {
      window.latch?.checkForUpdates?.()
    }, 10_000)
    return () => clearTimeout(timer)
  }, [])

  if (!state || dismissed) return null
  if (state.status === 'idle' || state.status === 'checking' || state.status === 'not-available') return null

  const handleDownload = () => window.latch?.downloadUpdate?.()
  const handleInstall = () => window.latch?.installUpdate?.()
  const handleRetry = () => window.latch?.checkForUpdates?.()

  return (
    <div className="update-banner">
      {state.status === 'available' && (
        <>
          <span>Latch v{state.version} is available.</span>
          <button className="update-banner-btn" onClick={handleDownload}>Download</button>
          <button className="update-banner-dismiss" onClick={() => setDismissed(true)}>&times;</button>
        </>
      )}

      {state.status === 'downloading' && (
        <>
          <span>Downloading update{state.progress != null ? ` (${state.progress}%)` : ''}...</span>
          <div className="update-banner-progress">
            <div className="update-banner-progress-fill" style={{ width: `${state.progress ?? 0}%` }} />
          </div>
        </>
      )}

      {state.status === 'downloaded' && (
        <>
          <span>Update ready — restart to install v{state.version}.</span>
          <button className="update-banner-btn" onClick={handleInstall}>Restart Now</button>
          <button className="update-banner-dismiss" onClick={() => setDismissed(true)}>&times;</button>
        </>
      )}

      {state.status === 'error' && (
        <>
          <span className="update-banner-error">Update error: {state.error}</span>
          <button className="update-banner-btn" onClick={handleRetry}>Retry</button>
          <button className="update-banner-dismiss" onClick={() => setDismissed(true)}>&times;</button>
        </>
      )}
    </div>
  )
}
