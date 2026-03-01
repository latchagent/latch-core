import React, { useEffect, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import type { SessionReceipt, ProxyAuditEvent } from '../../../types'

export default function GatewayPanel() {
  const { activeSessionId } = useAppStore()
  const sessions = useAppStore(s => s.sessions)
  const services = useAppStore(s => s.services)
  const servicesLoaded = useAppStore(s => s.servicesLoaded)
  const loadServices = useAppStore(s => s.loadServices)
  const activeSession = activeSessionId ? sessions.get(activeSessionId) : null
  const [receipt, setReceipt] = useState<SessionReceipt | null>(null)
  const [events, setEvents] = useState<ProxyAuditEvent[]>([])
  const [prUrl, setPrUrl] = useState('')
  const [annotating, setAnnotating] = useState(false)
  const [annotationResult, setAnnotationResult] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [addingService, setAddingService] = useState(false)
  const [selectedServiceId, setSelectedServiceId] = useState('')

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
      setLoadError(err instanceof Error ? err.message : 'Failed to load gateway data')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (!servicesLoaded) loadServices()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeSessionId) {
      setIsLoading(false)
      return
    }
    fetchData(activeSessionId)
  }, [activeSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleAddService = async () => {
    if (!activeSessionId || !selectedServiceId) return
    setAddingService(true)
    try {
      const res = await window.latch.addGatewayService({ sessionId: activeSessionId, serviceId: selectedServiceId })
      if (res.ok) {
        // Update session's gateway serviceIds in store
        useAppStore.setState((s) => {
          const sessions = new Map(s.sessions)
          const sess = sessions.get(activeSessionId)
          if (sess?.gateway) {
            sessions.set(activeSessionId, {
              ...sess,
              gateway: {
                ...sess.gateway,
                serviceIds: [...sess.gateway.serviceIds, selectedServiceId],
              },
            })
          }
          return { sessions }
        })
        setSelectedServiceId('')
      }
    } finally {
      setAddingService(false)
    }
  }

  const handleAnnotatePR = async () => {
    if (!activeSessionId || !prUrl.trim()) return
    setAnnotating(true)
    setAnnotationResult(null)
    const res = await window.latch.annotateGitHubPR({ sessionId: activeSessionId, prUrl: prUrl.trim() })
    setAnnotationResult(res.ok ? `Posted: ${res.commentUrl}` : `Error: ${res.error}`)
    setAnnotating(false)
  }

  const handleRefresh = () => {
    if (activeSessionId) fetchData(activeSessionId)
  }

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h2 className="view-title">Gateway</h2>
          <p className="view-subtitle">Session isolation, attestation receipts, and audit logs.</p>
        </div>
        {activeSessionId && (
          <button className="view-action-btn" onClick={handleRefresh} disabled={isLoading}>
            {isLoading ? 'Loading...' : 'Refresh'}
          </button>
        )}
      </div>

      {!activeSessionId ? (
        <div className="policies-empty">
          <div className="policies-empty-text">No active session</div>
          <div className="policies-empty-hint">
            Select a session from the sidebar, then enable Gateway during session setup to use proxy-based network gating, credential injection, and audit logging.
          </div>
        </div>
      ) : (
        <>
          {activeSession?.gateway?.enabled && activeSession.gateway.proxyPort && !receipt && !isLoading && (
            <section className="gateway-section">
              <h4>Active Gateway</h4>
              <div className="gateway-grid">
                <span className="gateway-muted">Proxy</span><span>:{activeSession.gateway.proxyPort}</span>
                <span className="gateway-muted">Sandbox</span><span>{activeSession.gateway.sandboxBackend ?? 'none'}</span>
                <span className="gateway-muted">Services</span><span>{activeSession.gateway.serviceIds.length}</span>
                <span className="gateway-muted">Started</span><span>{activeSession.gateway.startedAt ?? '—'}</span>
              </div>
            </section>
          )}

          {activeSession?.gateway?.enabled && !receipt && !isLoading && (
            <>
              {(() => {
                const currentIds = new Set(activeSession.gateway?.serviceIds ?? [])
                const available = services.filter(s => s.hasCredential && !currentIds.has(s.id))
                if (available.length === 0) return null
                return (
                  <section className="gateway-section">
                    <h4>Add Service</h4>
                    <div className="gateway-pr-row">
                      <select
                        className="modal-input gateway-pr-input"
                        value={selectedServiceId}
                        onChange={e => setSelectedServiceId(e.target.value)}
                      >
                        <option value="">Select a service...</option>
                        {available.map(s => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                      <button
                        className="view-action-btn"
                        onClick={handleAddService}
                        disabled={addingService || !selectedServiceId}
                      >
                        {addingService ? 'Adding...' : 'Add'}
                      </button>
                    </div>
                  </section>
                )
              })()}
              <button className="view-action-btn" style={{ marginBottom: 16 }} onClick={async () => {
                if (!activeSessionId) return
                await window.latch?.stopGateway?.({ sessionId: activeSessionId, exitReason: 'normal' })
                fetchData(activeSessionId)
              }}>
                Finalize & Generate Receipt
              </button>
            </>
          )}

          {isLoading ? (
            <p className="text-muted">Loading gateway data...</p>
          ) : loadError ? (
            <p className="gateway-error">{loadError}</p>
          ) : receipt ? (
            <>
              <section className="gateway-section">
                <h4>Policy</h4>
                <div className="gateway-grid">
                  <span className="gateway-muted">Policy</span><span>{receipt.policy.id}</span>
                  <span className="gateway-muted">Tier</span><span>{receipt.policy.maxDataTier}</span>
                  <span className="gateway-muted">Sandbox</span><span>{receipt.gateway.sandboxType}</span>
                  <span className="gateway-muted">Exit</span><span>{receipt.gateway.exitReason}</span>
                </div>
              </section>

              <section className="gateway-section">
                <h4>Activity</h4>
                <div className="gateway-grid">
                  <span className="gateway-muted">Requests</span><span>{receipt.activity.networkRequests}</span>
                  <span className="gateway-muted">Blocked</span><span>{receipt.activity.blockedRequests}</span>
                  <span className="gateway-muted">Redactions</span><span>{receipt.activity.redactionsApplied}</span>
                  <span className="gateway-muted">Tokenizations</span><span>{receipt.activity.tokenizationsApplied}</span>
                  <span className="gateway-muted">Tool calls</span><span>{receipt.activity.toolCalls}</span>
                  <span className="gateway-muted">Tool denials</span><span>{receipt.activity.toolDenials}</span>
                </div>
              </section>

              <section className="gateway-section">
                <h4>Proof</h4>
                <div className="gateway-grid">
                  <span className="gateway-muted">Events</span><span>{receipt.proof.auditEventCount}</span>
                  <span className="gateway-muted">Merkle root</span>
                  <span className="gateway-mono">{receipt.proof.merkleRoot.slice(0, 16)}...</span>
                  <span className="gateway-muted">Signature</span>
                  <span className="gateway-mono">{receipt.proof.signature.slice(0, 16)}...</span>
                </div>
              </section>

              <section className="gateway-section">
                <h4>PR Annotation</h4>
                <div className="gateway-pr-row">
                  <input
                    className="modal-input gateway-pr-input"
                    type="text"
                    placeholder="https://github.com/owner/repo/pull/123"
                    value={prUrl}
                    onChange={e => setPrUrl(e.target.value)}
                  />
                  <button className="view-action-btn" onClick={handleAnnotatePR} disabled={annotating || !prUrl.trim()}>
                    {annotating ? 'Posting...' : 'Annotate PR'}
                  </button>
                </div>
                {annotationResult && <p className="gateway-annotation-result">{annotationResult}</p>}
              </section>
            </>
          ) : (
            <div className="policies-empty">
              <div className="policies-empty-text">No attestation receipt</div>
              <div className="policies-empty-hint">
                {activeSession?.gateway?.enabled
                  ? 'The gateway is active. Finalize the session to generate a signed receipt.'
                  : 'Enable Gateway when starting a session to get attestation receipts and audit logs.'}
              </div>
            </div>
          )}

          {events.length > 0 && (
            <section className="gateway-section">
              <h4>Audit Log ({events.length})</h4>
              <div className="gateway-audit-list">
                {events.map(evt => (
                  <div key={evt.id} className={`gateway-audit-row ${evt.decision === 'deny' ? 'is-denied' : ''}`}>
                    <span className="gateway-mono">{evt.method}</span>
                    <span>{evt.domain}{evt.path}</span>
                    <span className={`gateway-badge gateway-badge-${evt.decision}`}>{evt.decision}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
