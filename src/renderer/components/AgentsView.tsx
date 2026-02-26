import React, { useState } from 'react'
import { ArrowSquareOut } from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'

export default function AgentsView() {
  const { harnesses, loadHarnesses } = useAppStore()
  const [scanning, setScanning] = useState(false)

  // Sort: detected first, then alphabetical
  const sorted = [...harnesses].sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? -1 : 1
    return a.label.localeCompare(b.label)
  })

  const handleRescan = async () => {
    setScanning(true)
    await loadHarnesses()
    setScanning(false)
  }

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h2 className="view-title">Agents</h2>
          <p className="view-subtitle">Supported CLI agents for your sessions.</p>
        </div>
        <button className="view-action-btn" onClick={handleRescan} disabled={scanning}>
          {scanning ? 'Scanning...' : 'Re-scan'}
        </button>
      </div>

      {/* Agent list */}
      <div className="agents-section-label">CLI agents</div>
      <div className="agents-list">
        {sorted.map((agent) => (
          <div key={agent.id} className="agents-list-item">
            <div className="agents-list-info">
              <span className="agents-list-name">{agent.label}</span>
              {agent.url && (
                <a
                  className="agents-list-link"
                  href={agent.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => { e.preventDefault(); if (agent.url) window.latch?.openExternal?.(agent.url) }}
                  title={`Open ${agent.label} website`}
                >
                  <ArrowSquareOut size={12} weight="light" />
                </a>
              )}
            </div>
            <div className="agents-list-status">
              <span className={`agents-status-dot ${agent.installed ? 'is-detected' : ''}`} />
              <span className="agents-status-label">{agent.installed ? 'Detected' : 'Not detected'}</span>
            </div>
            <div className="agents-list-actions">
              {agent.installed && agent.recommendedCommand && (
                <span className="agents-command-badge">{agent.recommendedCommand}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
