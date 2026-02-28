/**
 * @module SecretEditor
 * @description Modal for creating / editing a vault secret.
 * The value field is write-only — it is never pre-filled on edit.
 */

import React, { useEffect, useState, KeyboardEvent } from 'react'
import { useAppStore } from '../../store/useAppStore'

export default function SecretEditor() {
  const { secretEditorSecret, closeSecretEditor, saveSecret } = useAppStore()

  const base = secretEditorSecret
  const isEdit = !!base

  const [name,        setName]        = useState(base?.name ?? '')
  const [key,         setKey]         = useState(base?.key  ?? '')
  const [description, setDescription] = useState(base?.description ?? '')
  const [value,       setValue]       = useState('')
  const [tags,        setTags]        = useState(base?.tags?.join(', ') ?? '')

  useEffect(() => {
    setName(base?.name ?? '')
    setKey(base?.key   ?? '')
    setDescription(base?.description ?? '')
    setValue('') // Never pre-fill value — write-only
    setTags(base?.tags?.join(', ') ?? '')
  }, [secretEditorSecret]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    if (!name.trim() || !key.trim()) return
    if (!isEdit && !value) return // value required for new secrets

    await saveSecret({
      id:          base?.id ?? `secret-${Date.now()}`,
      name:        name.trim(),
      key:         key.trim(),
      description: description.trim(),
      value,
      tags:        tags.split(',').map((t) => t.trim()).filter(Boolean),
    })
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeSecretEditor()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave()
  }

  return (
    <div
      className="modal-backdrop"
      onKeyDown={handleKeyDown}
      onClick={(e) => { if (e.target === e.currentTarget) closeSecretEditor() }}
    >
      <div className="modal" id="secret-editor-modal">
        <div className="modal-header">
          <span className="modal-title">{isEdit ? 'Edit Secret' : 'New Secret'}</span>
          <button className="modal-close" onClick={closeSecretEditor}>x</button>
        </div>

        <div className="modal-body">
          <div className="modal-field">
            <label className="modal-label" htmlFor="secret-name">Name</label>
            <input
              className="modal-input"
              id="secret-name"
              placeholder="e.g. GitHub PAT"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="modal-field">
            <label className="modal-label" htmlFor="secret-key">Key</label>
            <input
              className="modal-input"
              id="secret-key"
              placeholder="e.g. GITHUB_TOKEN"
              value={key}
              onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
            />
            <div className="modal-hint">
              {'Referenced as ${secret:' + (key || 'KEY') + '}'}
            </div>
          </div>
          <div className="modal-field">
            <label className="modal-label" htmlFor="secret-description">Description</label>
            <input
              className="modal-input"
              id="secret-description"
              placeholder="e.g. API key for Spoonacular food/recipe API"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <div className="modal-hint">
              Shown to agents as a hint so they know which secrets are available.
            </div>
          </div>
          <div className="modal-field">
            <label className="modal-label" htmlFor="secret-value">
              Value {isEdit && <span className="modal-hint-inline">(leave empty to keep current)</span>}
            </label>
            <input
              className="modal-input"
              id="secret-value"
              type="password"
              placeholder={isEdit ? 'Leave empty to keep current value' : 'Paste secret value'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="modal-field">
            <label className="modal-label" htmlFor="secret-tags">Tags (comma-separated)</label>
            <input
              className="modal-input"
              id="secret-tags"
              placeholder="api, production"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </div>
        </div>

        <div className="modal-footer">
          <button className="modal-btn" onClick={closeSecretEditor}>Cancel</button>
          <button className="modal-btn is-primary" onClick={handleSave}>
            {isEdit ? 'Update Secret' : 'Save Secret'}
          </button>
        </div>
      </div>
    </div>
  )
}
