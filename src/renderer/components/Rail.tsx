import React from 'react'
import { useAppStore } from '../store/useAppStore'
import type { RailPanel } from '../../types'
import PolicyPanel   from './panels/PolicyPanel'
import ActivityPanel from './panels/ActivityPanel'

const TABS: { id: RailPanel; label: string }[] = [
  { id: 'activity', label: 'Activity' },
  { id: 'policy',   label: 'Policy'   },
]

export default function Rail() {
  const { activeRailPanel, setActiveRailPanel } = useAppStore()

  return (
    <aside className="rail">
      <div className="rail-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`rail-tab${activeRailPanel === tab.id ? ' is-active' : ''}`}
            onClick={() => setActiveRailPanel(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeRailPanel === 'activity' && <ActivityPanel />}
      {activeRailPanel === 'policy'   && <PolicyPanel />}
    </aside>
  )
}
