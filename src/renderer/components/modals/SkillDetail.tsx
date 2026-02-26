/**
 * @module SkillDetail
 * @description Read-only preview modal for a catalog or installed skill.
 * Shows name, description, tags, and full body/instructions.
 * Footer offers "Install Skill" (catalog) or "Edit" (installed).
 */

import React, { useMemo, KeyboardEvent } from 'react'
import { useAppStore } from '../../store/useAppStore'
import type { SkillRecord } from '../../../types'

export default function SkillDetail() {
  const {
    skillDetailSkill: skill,
    closeSkillDetail,
    skills,
    saveSkill,
    openSkillEditor,
  } = useAppStore()

  const installedIds = useMemo(() => new Set(skills.map((s) => s.id)), [skills])
  const isInstalled = skill ? installedIds.has(skill.id) : false

  const handleInstall = async () => {
    if (!skill) return
    await saveSkill({
      id: skill.id,
      name: skill.name,
      description: skill.description ?? '',
      body: 'body' in skill ? skill.body : '',
      tags: 'tags' in skill ? skill.tags ?? [] : [],
      harnesses: null,
    } as SkillRecord)
    // Set install flash then auto-clear after animation
    useAppStore.setState({ skillInstallFlash: skill.id })
    setTimeout(() => useAppStore.setState({ skillInstallFlash: null }), 2500)
    closeSkillDetail()
  }

  const handleEdit = () => {
    if (!skill) return
    const installed = skills.find((s) => s.id === skill.id)
    openSkillEditor(installed ?? (skill as SkillRecord))
    closeSkillDetail()
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeSkillDetail()
  }

  if (!skill) return null

  const icon = 'icon' in skill ? (skill as any).icon : skill.name.charAt(0).toUpperCase()

  return (
    <div
      className="modal-backdrop"
      onKeyDown={handleKeyDown}
      onClick={(e) => { if (e.target === e.currentTarget) closeSkillDetail() }}
    >
      <div className="modal" id="skill-detail-modal">
        <div className="modal-header">
          <div className="skill-detail-header-row">
            <div className="skill-catalog-icon">{icon}</div>
            <span className="modal-title">{skill.name}</span>
          </div>
          <button className="modal-close" onClick={closeSkillDetail}>×</button>
        </div>

        <div className="modal-body">
          {skill.description && (
            <p className="skill-detail-desc">{skill.description}</p>
          )}

          {'tags' in skill && (skill.tags as string[])?.length > 0 && (
            <div className="skill-card-tags" style={{ marginBottom: 16 }}>
              {(skill.tags as string[]).map((tag) => (
                <span key={tag} className="skill-tag">{tag}</span>
              ))}
            </div>
          )}

          {'body' in skill && skill.body && (
            <>
              <div className="skill-detail-section-label">Instructions</div>
              <pre className="skill-detail-body">{skill.body}</pre>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="modal-btn" onClick={closeSkillDetail}>Close</button>
          {isInstalled ? (
            <button className="modal-btn is-primary" onClick={handleEdit}>Edit</button>
          ) : (
            <button className="modal-btn is-primary" onClick={handleInstall}>Install Skill</button>
          )}
        </div>
      </div>
    </div>
  )
}
