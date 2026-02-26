import React, { useEffect, useRef, useState, useMemo } from 'react'
import { ArrowsClockwise, CaretDown, MagnifyingGlass } from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'
import { SKILL_CATALOG } from '../data/skill-catalog'
import type { SkillRecord } from '../../types'

function SyncDropdown() {
  const { harnesses } = useAppStore()
  const installed = harnesses.filter((h) => h.installed)
  const [open, setOpen] = useState(false)
  const [syncStates, setSyncStates] = useState<Record<string, 'idle' | 'syncing' | 'ok' | 'err'>>({})
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleSync = async (harnessId: string) => {
    setSyncStates((s) => ({ ...s, [harnessId]: 'syncing' }))
    const result = await window.latch?.syncSkills?.({ harnessId })
    setSyncStates((s) => ({ ...s, [harnessId]: result?.ok ? 'ok' : 'err' }))
    setTimeout(() => setSyncStates((s) => ({ ...s, [harnessId]: 'idle' })), 2500)
  }

  const handleSyncAll = async () => {
    for (const h of installed) {
      await handleSync(h.id)
    }
  }

  const anySyncing = Object.values(syncStates).some((s) => s === 'syncing')

  return (
    <div className="sync-dropdown" ref={ref}>
      <button
        className="sync-dropdown-trigger"
        onClick={() => setOpen(!open)}
        disabled={!installed.length}
        title={!installed.length ? 'No harnesses detected' : 'Sync skills to harnesses'}
      >
        <ArrowsClockwise size={14} weight="light" />
        Sync
        <CaretDown className="sync-dropdown-chevron" size={10} weight="light" />
      </button>
      {open && (
        <div className="sync-dropdown-menu">
          {installed.length > 1 && (
            <button
              className="sync-dropdown-item"
              onClick={handleSyncAll}
              disabled={anySyncing}
            >
              <span>Sync All</span>
              <span className="sync-dropdown-hint">{installed.length} harnesses</span>
            </button>
          )}
          {installed.map((h) => {
            const state = syncStates[h.id] ?? 'idle'
            return (
              <button
                key={h.id}
                className={`sync-dropdown-item${state !== 'idle' ? ` is-${state}` : ''}`}
                onClick={() => handleSync(h.id)}
                disabled={state === 'syncing'}
              >
                <span>{h.label}</span>
                {state === 'syncing' && <span className="sync-dropdown-status">Syncing...</span>}
                {state === 'ok'      && <span className="sync-dropdown-status is-ok">Done</span>}
                {state === 'err'     && <span className="sync-dropdown-status is-err">Failed</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function SkillsView() {
  const { skills, loadSkills, openSkillEditor, deleteSkill, saveSkill, openSkillDetail, skillInstallFlash } = useAppStore()
  const [search, setSearch] = useState('')
  useEffect(() => { loadSkills() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const installedIds = useMemo(() => new Set(skills.map(s => s.id)), [skills])

  const query = search.toLowerCase().trim()

  const filteredInstalled = useMemo(() => {
    if (!query) return skills
    return skills.filter(s =>
      s.name.toLowerCase().includes(query) ||
      s.description?.toLowerCase().includes(query) ||
      s.tags?.some(t => t.toLowerCase().includes(query))
    )
  }, [skills, query])

  const filteredCatalog = useMemo(() => {
    const available = SKILL_CATALOG.filter(s => !installedIds.has(s.id))
    if (!query) return available
    return available.filter(s =>
      s.name.toLowerCase().includes(query) ||
      s.description.toLowerCase().includes(query) ||
      s.tags.some(t => t.toLowerCase().includes(query))
    )
  }, [installedIds, query])

  const handleDelete = async (skill: SkillRecord) => {
    if (!confirm(`Delete skill "${skill.name}"?`)) return
    await deleteSkill(skill.id)
  }

  const handleInstall = async (catalogSkill: typeof SKILL_CATALOG[number]) => {
    await saveSkill({
      id: catalogSkill.id,
      name: catalogSkill.name,
      description: catalogSkill.description,
      body: catalogSkill.body,
      tags: catalogSkill.tags,
      harnesses: null,
    } as SkillRecord)
  }

  const handleInstallAll = async () => {
    const toInstall = SKILL_CATALOG.filter(s => !installedIds.has(s.id))
    for (const skill of toInstall) {
      await handleInstall(skill)
    }
  }

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h2 className="view-title">Skills</h2>
          <p className="view-subtitle">Extend your agents with reusable skill modules.</p>
        </div>
        <button className="view-action-btn" onClick={() => openSkillEditor(null)}>
          + New Skill
        </button>
      </div>

      {/* ── Search + Sync bar ──────────────────────────────────── */}
      <div className="skills-toolbar">
        <div className="skills-search-wrapper">
          <MagnifyingGlass className="skills-search-icon" size={14} weight="light" />
          <input
            className="skills-search-input"
            type="text"
            placeholder="Search skills..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <SyncDropdown />
      </div>

      {/* ── Info banner ───────────────────────────────────────── */}
      <div className="skills-info-banner">
        <p>Skills from the OpenAI and Anthropic catalogs. Install a skill to make it available across all your coding agents. Skills follow the open <strong>Agent Skills</strong> standard.</p>
      </div>

      {/* ── Installed section ─────────────────────────────────── */}
      <div className="skills-section">
        <div className="skills-section-header">
          <div className="skills-section-label">Installed</div>
          <span className="skills-section-count">{filteredInstalled.length}</span>
        </div>
        {filteredInstalled.length === 0 ? (
          <div className="panel-empty" style={{ padding: '16px 0' }}>
            {query ? 'No installed skills match your search.' : 'No skills installed yet. Browse the catalog below.'}
          </div>
        ) : (
          <div className="skills-catalog-grid">
            {filteredInstalled.map((skill) => (
              <div
                key={skill.id}
                className={`skill-catalog-card is-installed${skill.id === skillInstallFlash ? ' is-just-installed' : ''}`}
                onClick={() => openSkillDetail(skill)}
              >
                <div className="skill-catalog-content">
                  <div className="skill-catalog-name">{skill.name}</div>
                  {skill.description && (
                    <div className="skill-catalog-desc">{skill.description}</div>
                  )}
                  {skill.tags?.length > 0 && (
                    <div className="skill-card-tags">
                      {skill.tags.map((tag) => (
                        <span key={tag} className="skill-tag">{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="skill-catalog-actions">
                  <button className="skill-card-btn" onClick={(e) => { e.stopPropagation(); openSkillEditor(skill) }} title="Edit">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button className="skill-card-btn is-danger" onClick={(e) => { e.stopPropagation(); handleDelete(skill) }} title="Uninstall">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3,6 5,6 21,6" />
                      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Recommended section ───────────────────────────────── */}
      <div className="skills-section">
        <div className="skills-section-header">
          <div className="skills-section-label">Recommended</div>
          <span className="skills-section-count">{filteredCatalog.length}</span>
          {filteredCatalog.length > 0 && (
            <button className="skills-install-all-btn" onClick={handleInstallAll}>
              Install All
            </button>
          )}
        </div>
        {filteredCatalog.length === 0 ? (
          <div className="panel-empty" style={{ padding: '16px 0' }}>
            {query ? 'No catalog skills match your search.' : 'All catalog skills are installed.'}
          </div>
        ) : (
          <div className="skills-catalog-grid">
            {filteredCatalog.map((skill) => (
              <div
                key={skill.id}
                className="skill-catalog-card"
                onClick={() => openSkillDetail(skill)}
              >
                <div className="skill-catalog-content">
                  <div className="skill-catalog-name">{skill.name}</div>
                  <div className="skill-catalog-desc">{skill.description}</div>
                  <div className="skill-card-tags">
                    {skill.tags.map((tag) => (
                      <span key={tag} className="skill-tag">{tag}</span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
