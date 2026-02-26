import React, { useEffect, useState } from 'react'
import { Broadcast, CaretRight } from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'
import type { FeedItem } from '../../types'

function harnessLabel(harnessId: string): string {
  const map: Record<string, string> = {
    claude: 'Claude',
    codex: 'Codex',
    openclaw: 'OpenClaw',
    droid: 'Droid',
    opencode: 'OpenCode',
  }
  return map[harnessId] ?? harnessId
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ts
  }
}

function FeedGroup({ sessionId, items }: { sessionId: string; items: FeedItem[] }) {
  const [expanded, setExpanded] = useState(false)
  const sessions = useAppStore((s) => s.sessions)

  const session = sessions.get(sessionId)
  const name = session?.name ?? sessionId

  const latest = items[0]
  const olderItems = items.slice(1)

  return (
    <div className="feed-group">
      <div className="feed-group-header">{name}</div>

      {/* Latest item — always visible */}
      <div className="feed-item">
        <div className="feed-item-header">
          <span className={`feed-harness-badge harness-${latest.harnessId}`}>
            {harnessLabel(latest.harnessId)}
          </span>
          <span className="feed-item-time">{formatTime(latest.timestamp)}</span>
        </div>
        <div className="feed-item-message">{latest.message}</div>
      </div>

      {/* Expand toggle */}
      {olderItems.length > 0 && (
        <button className="feed-expand-btn" onClick={() => setExpanded(!expanded)}>
          <CaretRight className="feed-expand-chevron" weight="light"
            style={{ transform: expanded ? 'rotate(90deg)' : undefined }} />
          {expanded ? 'Hide' : 'Show'} {olderItems.length} earlier update{olderItems.length !== 1 ? 's' : ''}
        </button>
      )}

      {/* Timeline — older items */}
      {expanded && (
        <div className="feed-timeline">
          {olderItems.map((item) => (
            <div key={item.id} className="feed-timeline-item">
              <div className="feed-timeline-dot" />
              <div className="feed-timeline-content">
                <span className="feed-item-time">{formatTime(item.timestamp)}</span>
                <span className="feed-timeline-message">{item.message}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function FeedView() {
  const { feedItems, loadFeed, clearFeed } = useAppStore()

  useEffect(() => {
    loadFeed()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Group items by session (items are already newest-first)
  const grouped = new Map<string, FeedItem[]>()
  for (const item of feedItems) {
    const existing = grouped.get(item.sessionId) ?? []
    existing.push(item)
    grouped.set(item.sessionId, existing)
  }

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h2 className="view-title">Feed</h2>
          <p className="view-subtitle">Real-time status updates from your agents.</p>
        </div>
        {feedItems.length > 0 && (
          <button className="view-action-btn" onClick={clearFeed}>
            Clear
          </button>
        )}
      </div>

      {feedItems.length === 0 ? (
        <div className="feed-empty">
          <div className="feed-empty-icon">
            <Broadcast size={40} weight="light" />
          </div>
          <div className="feed-empty-text">No status updates yet</div>
          <div className="feed-empty-hint">
            Agents will report their progress here as they work.
          </div>
        </div>
      ) : (
        <div className="feed-list">
          {Array.from(grouped.entries()).map(([sid, items]) => (
            <FeedGroup key={sid} sessionId={sid} items={items} />
          ))}
        </div>
      )}
    </div>
  )
}
