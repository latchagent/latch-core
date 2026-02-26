/**
 * @module SkillEditor
 * @description Modal for creating / editing a SkillRecord.
 */

import React, { useEffect, useState, KeyboardEvent } from 'react'
import { useAppStore } from '../../store/useAppStore'
import type { SkillRecord } from '../../../types'

export default function SkillEditor() {
  const { skillEditorSkill, closeSkillEditor, saveSkill } = useAppStore()

  const base = skillEditorSkill
  const [name,      setName]      = useState(base?.name        ?? '')
  const [desc,      setDesc]      = useState(base?.description ?? '')
  const [tags,      setTags]      = useState(base?.tags?.join(', ')      ?? '')
  const [harnesses, setHarnesses] = useState(base?.harnesses?.join(', ') ?? '')
  const [body,      setBody]      = useState(base?.body        ?? '')

  useEffect(() => {
    setName(base?.name        ?? '')
    setDesc(base?.description ?? '')
    setTags(base?.tags?.join(', ')      ?? '')
    setHarnesses(base?.harnesses?.join(', ') ?? '')
    setBody(base?.body        ?? '')
  }, [skillEditorSkill]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    if (!name.trim() || !body.trim()) return
    const skill: SkillRecord = {
      id:          base?.id ?? `skill-${Date.now()}`,
      name:        name.trim(),
      description: desc.trim(),
      body:        body.trim(),
      tags:        tags.split(',').map((t) => t.trim()).filter(Boolean),
      harnesses:   harnesses.trim() ? harnesses.split(',').map((h) => h.trim()).filter(Boolean) : null,
    }
    await saveSkill(skill)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeSkillEditor()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave()
  }

  return (
    <div
      className="modal-backdrop"
      onKeyDown={handleKeyDown}
      onClick={(e) => { if (e.target === e.currentTarget) closeSkillEditor() }}
    >
      <div className="modal" id="skill-editor-modal">
        <div className="modal-header">
          <span className="modal-title">{base ? 'Edit Skill' : 'New Skill'}</span>
          <button className="modal-close" onClick={closeSkillEditor}>×</button>
        </div>

        <div className="modal-body">
          <div className="modal-field">
            <label className="modal-label" htmlFor="se-name">Name</label>
            <input
              className="modal-input"
              id="se-name"
              placeholder="My skill"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="modal-field">
            <label className="modal-label" htmlFor="se-description">Description</label>
            <input
              className="modal-input"
              id="se-description"
              placeholder="What this skill does"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
            />
          </div>
          <div className="modal-field">
            <label className="modal-label" htmlFor="se-tags">Tags (comma-separated)</label>
            <input
              className="modal-input"
              id="se-tags"
              placeholder="git, testing, review"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </div>
          <div className="modal-field">
            <label className="modal-label" htmlFor="se-harnesses">Harnesses (blank = all)</label>
            <input
              className="modal-input"
              id="se-harnesses"
              placeholder="claude, codex"
              value={harnesses}
              onChange={(e) => setHarnesses(e.target.value)}
            />
          </div>
          <div className="modal-field" style={{ flex: 1 }}>
            <label className="modal-label" htmlFor="se-body">Skill body (markdown)</label>
            <textarea
              className="modal-input modal-textarea"
              id="se-body"
              placeholder={'When asked to do X, follow these steps:\n1. ...\n2. ...'}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
        </div>

        <div className="modal-footer">
          <button className="modal-btn" onClick={closeSkillEditor}>Cancel</button>
          <button className="modal-btn is-primary" onClick={handleSave}>Save Skill</button>
        </div>
      </div>
    </div>
  )
}
