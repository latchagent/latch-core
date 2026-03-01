import React, { useEffect, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import type { SessionReceipt, ProxyAuditEvent } from '../../../types'

export default function EnclavePanel() {
  const { activeSessionId } = useAppStore()
  const [receipt, setReceipt] = useState<SessionReceipt | null>(null)
  const [events, setEvents] = useState<ProxyAuditEvent[]>([])
  const [prUrl, setPrUrl] = useState('')
  const [annotating, setAnnotating] = useState(false)
  const [annotationResult, setAnnotationResult] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const fetchData = async (sessionId: string) => {
    setIsLoading(true)
    setLoadError(null)
    try {
      const [attestRes, auditRes] = await Promise.all([
        window.latch.getAttestation({ sessionId }),
        window.latch.listProxyAudit({ sessionId, limit: 100 }),
      ])
      setReceipt(attestRes.ok ? (attestRes.receipt ?? null) : null)
      setEvents(auditRes.ok ? auditRes.events : [])
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load enclave data')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (!activeSessionId) return
    fetchData(activeSessionId)
  }, [activeSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleAnnotatePR = async () => {
    if (!activeSessionId || !prUrl.trim()) return
    setAnnotating(true)
    setAnnotationResult(null)
    const res = await window.latch.annotateGitHubPR({ sessionId: activeSessionId, prUrl: prUrl.trim() })
    setAnnotationResult(res.ok ? `Posted: ${res.commentUrl}` : `Error: ${res.error}`)
    setAnnotating(false)
  }

  if (!activeSessionId) {
    return <div className="enclave-panel"><p className="enclave-muted">No active session</p></div>
  }

  const handleRefresh = () => {
    if (activeSessionId) fetchData(activeSessionId)
  }

  return (
    <div className="enclave-panel">
      <div className="enclave-header-row">
        <h3>Enclave Attestation</h3>
        <button className="panel-action" onClick={handleRefresh} disabled={isLoading}>
          {isLoading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {isLoading ? (
        <p className="enclave-muted">Loading enclave data...</p>
      ) : loadError ? (
        <p className="enclave-error">{loadError}</p>
      ) : receipt ? (
        <>
          <section className="enclave-section">
            <h4>Policy</h4>
            <div className="enclave-grid">
              <span className="enclave-muted">Policy</span><span>{receipt.policy.id}</span>
              <span className="enclave-muted">Tier</span><span>{receipt.policy.maxDataTier}</span>
              <span className="enclave-muted">Sandbox</span><span>{receipt.enclave.sandboxType}</span>
              <span className="enclave-muted">Exit</span><span>{receipt.enclave.exitReason}</span>
            </div>
          </section>

          <section className="enclave-section">
            <h4>Activity</h4>
            <div className="enclave-grid">
              <span className="enclave-muted">Requests</span><span>{receipt.activity.networkRequests}</span>
              <span className="enclave-muted">Blocked</span><span>{receipt.activity.blockedRequests}</span>
              <span className="enclave-muted">Redactions</span><span>{receipt.activity.redactionsApplied}</span>
              <span className="enclave-muted">Tokenizations</span><span>{receipt.activity.tokenizationsApplied}</span>
              <span className="enclave-muted">Tool calls</span><span>{receipt.activity.toolCalls}</span>
              <span className="enclave-muted">Tool denials</span><span>{receipt.activity.toolDenials}</span>
            </div>
          </section>

          <section className="enclave-section">
            <h4>Proof</h4>
            <div className="enclave-grid">
              <span className="enclave-muted">Events</span><span>{receipt.proof.auditEventCount}</span>
              <span className="enclave-muted">Merkle root</span>
              <span className="enclave-mono">{receipt.proof.merkleRoot.slice(0, 16)}...</span>
              <span className="enclave-muted">Signature</span>
              <span className="enclave-mono">{receipt.proof.signature.slice(0, 16)}...</span>
            </div>
          </section>

          <section className="enclave-section">
            <h4>PR Annotation</h4>
            <div className="enclave-pr-row">
              <input
                className="wizard-input enclave-pr-input"
                type="text"
                placeholder="https://github.com/owner/repo/pull/123"
                value={prUrl}
                onChange={e => setPrUrl(e.target.value)}
              />
              <button className="panel-action" onClick={handleAnnotatePR} disabled={annotating || !prUrl.trim()}>
                {annotating ? 'Posting...' : 'Annotate'}
              </button>
            </div>
            {annotationResult && <p className="enclave-annotation-result">{annotationResult}</p>}
          </section>
        </>
      ) : (
        <p className="enclave-muted">No attestation receipt for this session.</p>
      )}

      {events.length > 0 && (
        <section className="enclave-section">
          <h4>Audit Log ({events.length})</h4>
          <div className="enclave-audit-list">
            {events.map(evt => (
              <div key={evt.id} className={`enclave-audit-row ${evt.decision === 'deny' ? 'is-denied' : ''}`}>
                <span className="enclave-mono">{evt.method}</span>
                <span>{evt.domain}{evt.path}</span>
                <span className={`enclave-badge enclave-badge-${evt.decision}`}>{evt.decision}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
