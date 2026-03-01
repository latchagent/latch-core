/**
 * @module ServiceEditor
 * @description Modal for creating / editing a custom ServiceDefinition.
 * Builds a full ServiceDefinition from form fields and submits via
 * window.latch.saveService({ definition }).
 */

import React, { useState, KeyboardEvent } from 'react'
import { useAppStore } from '../../store/useAppStore'
import type {
  ServiceDefinition,
  ServiceCategory,
  ServiceProtocol,
  DataTier,
} from '../../../types'

const CATEGORIES: ServiceCategory[] = ['vcs', 'cloud', 'comms', 'ci', 'registry', 'custom']
const PROTOCOLS: ServiceProtocol[] = ['http', 'ssh', 'db', 'grpc', 'custom']
const CREDENTIAL_TYPES = ['token', 'keypair', 'oauth', 'env-bundle'] as const
const DATA_TIERS: DataTier[] = ['public', 'internal', 'confidential', 'restricted']

interface HeaderEntry {
  key: string
  value: string
}

interface ServiceEditorProps {
  onClose: () => void
  initial?: ServiceDefinition | null
}

export default function ServiceEditor({ onClose, initial }: ServiceEditorProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [category, setCategory] = useState<ServiceCategory>(initial?.category ?? 'custom')
  const [protocol, setProtocol] = useState<ServiceProtocol>(initial?.protocol ?? 'http')
  const [domains, setDomains] = useState(initial?.injection.proxy.domains.join('\n') ?? '')
  const [headers, setHeaders] = useState<HeaderEntry[]>(() => {
    if (!initial?.injection.proxy.headers) return [{ key: '', value: '' }]
    const entries = Object.entries(initial.injection.proxy.headers)
    return entries.length > 0 ? entries.map(([k, v]) => ({ key: k, value: v })) : [{ key: '', value: '' }]
  })
  const [credentialType, setCredentialType] = useState<typeof CREDENTIAL_TYPES[number]>(
    initial?.credential.type ?? 'token',
  )
  const [credentialFields, setCredentialFields] = useState(
    initial?.credential.fields.join('\n') ?? 'token',
  )
  const [dataTier, setDataTier] = useState<DataTier>(initial?.dataTier.defaultTier ?? 'internal')
  const [redactionPatterns, setRedactionPatterns] = useState(
    initial?.dataTier.redaction.patterns.join('\n') ?? '',
  )
  const [skillDescription, setSkillDescription] = useState(initial?.skill.description ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saveService = useAppStore(s => s.saveService)

  const handleAddHeader = () => {
    setHeaders((h) => [...h, { key: '', value: '' }])
  }

  const handleRemoveHeader = (index: number) => {
    setHeaders((h) => h.filter((_, i) => i !== index))
  }

  const handleHeaderChange = (index: number, field: 'key' | 'value', val: string) => {
    setHeaders((h) => h.map((entry, i) => (i === index ? { ...entry, [field]: val } : entry)))
  }

  const handleSave = async () => {
    if (!name.trim()) return
    const domainList = domains
      .split('\n')
      .map((d) => d.trim())
      .filter(Boolean)
    if (domainList.length === 0) return

    const headerRecord: Record<string, string> = {}
    for (const h of headers) {
      if (h.key.trim()) headerRecord[h.key.trim()] = h.value
    }

    const fields = credentialFields
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean)

    const patterns = redactionPatterns
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean)

    const definition: ServiceDefinition = {
      id: initial?.id ?? `custom-${Date.now()}`,
      name: name.trim(),
      category,
      protocol,
      credential: {
        type: credentialType,
        fields: fields.length > 0 ? fields : ['token'],
      },
      injection: {
        env: {},
        files: {},
        proxy: {
          domains: domainList,
          headers: headerRecord,
        },
      },
      dataTier: {
        defaultTier: dataTier,
        redaction: {
          patterns,
          fields: [],
        },
      },
      skill: {
        description: skillDescription.trim(),
        capabilities: [],
        constraints: [],
      },
    }

    setSaving(true)
    setError(null)
    try {
      const result = await saveService(definition)
      if (!result.ok) {
        setError(result.error ?? 'Failed to save service')
        return
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error saving service')
    } finally {
      setSaving(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave()
  }

  return (
    <div
      className="modal-backdrop"
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal service-editor-modal">
        <div className="modal-header">
          <span className="modal-title">
            {initial ? 'Edit Service' : 'New Service'}
          </span>
          <button className="modal-close" onClick={onClose}>
            x
          </button>
        </div>

        <div className="modal-body">
          {/* Name */}
          <div className="modal-field">
            <label className="modal-label" htmlFor="svc-name">
              Name
            </label>
            <input
              className="modal-input"
              id="svc-name"
              placeholder="My API Service"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          {/* Category */}
          <div className="modal-field">
            <label className="modal-label" htmlFor="svc-category">
              Category
            </label>
            <select
              className="modal-input"
              id="svc-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as ServiceCategory)}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          {/* Protocol */}
          <div className="modal-field">
            <label className="modal-label" htmlFor="svc-protocol">
              Protocol
            </label>
            <select
              className="modal-input"
              id="svc-protocol"
              value={protocol}
              onChange={(e) => setProtocol(e.target.value as ServiceProtocol)}
            >
              {PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          {/* Domains */}
          <div className="modal-field">
            <label className="modal-label" htmlFor="svc-domains">
              Domains (one per line)
            </label>
            <textarea
              className="modal-input service-editor-textarea"
              id="svc-domains"
              placeholder={'api.example.com\ncdn.example.com'}
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              rows={3}
            />
          </div>

          {/* Headers (key-value pairs) */}
          <div className="modal-field">
            <label className="modal-label">Headers</label>
            {headers.map((h, i) => (
              <div key={i} className="service-editor-header-row">
                <input
                  className="modal-input service-editor-header-key"
                  placeholder="Header name"
                  value={h.key}
                  onChange={(e) => handleHeaderChange(i, 'key', e.target.value)}
                />
                <input
                  className="modal-input service-editor-header-value"
                  placeholder="Value (e.g. Bearer ${credential.token})"
                  value={h.value}
                  onChange={(e) => handleHeaderChange(i, 'value', e.target.value)}
                />
                <button
                  type="button"
                  className="service-editor-header-remove"
                  onClick={() => handleRemoveHeader(i)}
                >
                  x
                </button>
              </div>
            ))}
            <button
              type="button"
              className="modal-add-glob"
              onClick={handleAddHeader}
            >
              + Add header
            </button>
          </div>

          {/* Credential type */}
          <div className="modal-field">
            <label className="modal-label" htmlFor="svc-cred-type">
              Credential type
            </label>
            <select
              className="modal-input"
              id="svc-cred-type"
              value={credentialType}
              onChange={(e) =>
                setCredentialType(e.target.value as typeof CREDENTIAL_TYPES[number])
              }
            >
              {CREDENTIAL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          {/* Credential fields */}
          <div className="modal-field">
            <label className="modal-label" htmlFor="svc-cred-fields">
              Credential fields (one per line)
            </label>
            <textarea
              className="modal-input service-editor-textarea"
              id="svc-cred-fields"
              placeholder={'token\nsecret'}
              value={credentialFields}
              onChange={(e) => setCredentialFields(e.target.value)}
              rows={2}
            />
          </div>

          {/* Data tier */}
          <div className="modal-field">
            <label className="modal-label" htmlFor="svc-data-tier">
              Data tier
            </label>
            <select
              className="modal-input"
              id="svc-data-tier"
              value={dataTier}
              onChange={(e) => setDataTier(e.target.value as DataTier)}
            >
              {DATA_TIERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          {/* Redaction patterns */}
          <div className="modal-field">
            <label className="modal-label" htmlFor="svc-redaction">
              Redaction patterns (regex, one per line)
            </label>
            <textarea
              className="modal-input service-editor-textarea"
              id="svc-redaction"
              placeholder={'\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z]{2,}\\b'}
              value={redactionPatterns}
              onChange={(e) => setRedactionPatterns(e.target.value)}
              rows={3}
            />
          </div>

          {/* Skill description */}
          <div className="modal-field">
            <label className="modal-label" htmlFor="svc-skill-desc">
              Skill description
            </label>
            <textarea
              className="modal-input service-editor-textarea"
              id="svc-skill-desc"
              placeholder="Describe what this service provides to agents..."
              value={skillDescription}
              onChange={(e) => setSkillDescription(e.target.value)}
              rows={3}
            />
          </div>
        </div>

        <div className="modal-footer">
          {error && <span className="modal-error">{error}</span>}
          <button className="modal-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="modal-btn is-primary"
            onClick={handleSave}
            disabled={saving || !name.trim()}
          >
            {saving ? 'Saving...' : 'Save Service'}
          </button>
        </div>
      </div>
    </div>
  )
}
