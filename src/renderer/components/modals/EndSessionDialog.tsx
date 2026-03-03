import React, { useState } from 'react'
import { Pause, GitMerge } from '@phosphor-icons/react'
import { useAppStore } from '../../store/useAppStore'

export default function EndSessionDialog() {
  const endDialogSessionId = useAppStore((s) => s.endDialogSessionId)
  const sessions = useAppStore((s) => s.sessions)
  const pauseSession = useAppStore((s) => s.pauseSession)
  const mergeAndClose = useAppStore((s) => s.mergeAndClose)
  const dismissEndDialog = useAppStore((s) => s.dismissEndDialog)

  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!endDialogSessionId) return null
  const session = sessions.get(endDialogSessionId)
  if (!session) return null

  const handlePause = () => {
    pauseSession(endDialogSessionId)
  }

  const handleMerge = async () => {
    setMerging(true)
    setError(null)
    const result = await mergeAndClose(endDialogSessionId)
    if (!result.ok) {
      setError(result.error ?? 'Merge failed')
      setMerging(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="end-session-dialog">
        <h2 className="end-session-title">End Session</h2>
        <p className="end-session-desc">
          Choose how to end <strong>{session.name}</strong>
        </p>

        {error && <div className="end-session-error">{error}</div>}

        <div className="end-session-options">
          <button className="end-session-option" onClick={handlePause}>
            <Pause size={20} weight="bold" />
            <div>
              <div className="end-session-option-label">Pause</div>
              <div className="end-session-option-hint">
                Send Ctrl+C — you can resume later
              </div>
            </div>
          </button>

          <button
            className="end-session-option is-merge"
            onClick={handleMerge}
            disabled={merging}
          >
            <GitMerge size={20} weight="bold" />
            <div>
              <div className="end-session-option-label">
                {merging ? 'Merging...' : 'Merge & Close'}
              </div>
              <div className="end-session-option-hint">
                Merge <code>{session.branchRef}</code> into default branch
              </div>
            </div>
          </button>
        </div>

        <button className="end-session-cancel" onClick={dismissEndDialog}>
          Cancel
        </button>
      </div>
    </div>
  )
}
