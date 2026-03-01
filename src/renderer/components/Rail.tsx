import React from 'react'
import { useAppStore } from '../store/useAppStore'
import type { RailPanel } from '../../types'
import PolicyPanel   from './panels/PolicyPanel'
import ActivityPanel from './panels/ActivityPanel'
import ServicesPanel from './panels/ServicesPanel'
import EnclavePanel from './panels/EnclavePanel'

const TABS: { id: RailPanel; label: string }[] = [
  { id: 'activity', label: 'Activity' },
  { id: 'policy',   label: 'Policy'   },
  { id: 'services', label: 'Services' },
  { id: 'enclave', label: 'Enclave' },
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
      {activeRailPanel === 'services' && <ServicesPanel />}
      {activeRailPanel === 'enclave' && <EnclavePanel />}
    </aside>
  )
}
