/**
 * @module CreateServiceView
 * @description Full-page view for creating or editing a ServiceDefinition.
 * Replaces the former ServiceEditor modal with a routed view following
 * the same pattern as CreatePolicyView.
 */

import React, { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import OpSecretPicker from './OpSecretPicker'
import type {
  ServiceDefinition,
  ServiceCategory,
  ServiceProtocol,
  DataTier,
} from '../../types'

const CATEGORIES: ServiceCategory[] = ['vcs', 'cloud', 'comms', 'ci', 'registry', 'custom']
const PROTOCOLS: ServiceProtocol[] = ['http', 'ssh', 'db', 'grpc', 'custom']
const CREDENTIAL_TYPES = ['token', 'keypair', 'oauth', 'env-bundle'] as const
const DATA_TIERS: DataTier[] = ['public', 'internal', 'confidential', 'restricted']

interface HeaderEntry {
  key: string
  value: string
}

export default function CreateServiceView() {
  const initial = useAppStore(s => s.serviceEditorDef)
  const hasExistingCredential = useAppStore(s => s.serviceEditorHasCred)
  const saveService = useAppStore(s => s.saveService)
  const closeServiceEditor = useAppStore(s => s.closeServiceEditor)
  const loadServices = useAppStore(s => s.loadServices)

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
  const [credValues, setCredValues] = useState<Record<string, string>>({})
  const [credSources, setCredSources] = useState<Record<string, 'manual' | '1password'>>({})
  const [dataTier, setDataTier] = useState<DataTier>(initial?.dataTier.defaultTier ?? 'internal')
  const [redactionPatterns, setRedactionPatterns] = useState(
    initial?.dataTier.redaction.patterns.join('\n') ?? '',
  )
  const [skillDescription, setSkillDescription] = useState(initial?.skill.description ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const credFieldNames = credentialFields
    .split('\n')
    .map(f => f.trim())
    .filter(Boolean)

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

    // Build credential value JSON if any fields were filled in
    const filledCreds: Record<string, string> = {}
    for (const [field, val] of Object.entries(credValues)) {
      if (val.trim()) filledCreds[field] = val.trim()
    }
    const credentialValue = Object.keys(filledCreds).length > 0
      ? JSON.stringify(filledCreds)
      : undefined

    setSaving(true)
    setError(null)
    try {
      const result = await saveService(definition, credentialValue)
      if (!result.ok) {
        setError(result.error ?? 'Failed to save service')
        return
      }
      await loadServices()
      closeServiceEditor()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error saving service')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="view-container">
      <div className="cp-back-row">
        <button className="cp-back-btn" onClick={closeServiceEditor}>
          ← Services
        </button>
      </div>

      <div className="cp-page">
        <h2 className="cp-title">{initial ? 'Edit Service' : 'New Service'}</h2>
        <p className="cp-subtitle">
          {initial
            ? 'Update the service configuration and credentials.'
            : 'Configure authenticated access to an external service. Credentials are injected by the gateway proxy — never exposed to agents.'}
        </p>

        <div className="cp-form">
          {/* Name */}
          <label className="cp-label">Name</label>
          <input
            className="cp-input"
            placeholder="My API Service"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />

          {/* Category + Protocol side by side */}
          <div className="service-editor-row">
            <div className="service-editor-col">
              <label className="cp-label">Category</label>
              <select
                className="cp-input"
                value={category}
                onChange={(e) => setCategory(e.target.value as ServiceCategory)}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div className="service-editor-col">
              <label className="cp-label">Protocol</label>
              <select
                className="cp-input"
                value={protocol}
                onChange={(e) => setProtocol(e.target.value as ServiceProtocol)}
              >
                {PROTOCOLS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Domains */}
          <label className="cp-label">Domains (one per line)</label>
          <textarea
            className="cp-input service-editor-textarea"
            placeholder={'api.example.com\ncdn.example.com'}
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
            rows={3}
          />

          {/* Headers */}
          <label className="cp-label">Headers</label>
          {headers.map((h, i) => (
            <div key={i} className="service-editor-header-row">
              <input
                className="cp-input service-editor-header-key"
                placeholder="Header name"
                value={h.key}
                onChange={(e) => handleHeaderChange(i, 'key', e.target.value)}
              />
              <input
                className="cp-input service-editor-header-value"
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
          <button type="button" className="cp-add-glob" onClick={handleAddHeader}>
            + Add header
          </button>

          {/* Credential type + fields side by side */}
          <div className="service-editor-row">
            <div className="service-editor-col">
              <label className="cp-label">Credential type</label>
              <select
                className="cp-input"
                value={credentialType}
                onChange={(e) => setCredentialType(e.target.value as typeof CREDENTIAL_TYPES[number])}
              >
                {CREDENTIAL_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div className="service-editor-col">
              <label className="cp-label">Data tier</label>
              <select
                className="cp-input"
                value={dataTier}
                onChange={(e) => setDataTier(e.target.value as DataTier)}
              >
                {DATA_TIERS.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Credential fields */}
          <label className="cp-label">Credential fields (one per line)</label>
          <textarea
            className="cp-input service-editor-textarea"
            placeholder={'token\nsecret'}
            value={credentialFields}
            onChange={(e) => setCredentialFields(e.target.value)}
            rows={2}
          />

          {/* Credential values */}
          {credFieldNames.length > 0 && (
            <>
              <label className="cp-label">
                Credential {hasExistingCredential ? '(leave empty to keep current)' : ''}
              </label>
              {credFieldNames.map(field => {
                const source = credSources[field] ?? 'manual'
                return (
                  <div key={field} className="cred-field-row">
                    <div className="cred-source-toggle">
                      <button
                        type="button"
                        className={`cred-source-btn${source === 'manual' ? ' is-active' : ''}`}
                        onClick={() => setCredSources(prev => ({ ...prev, [field]: 'manual' }))}
                      >
                        Manual
                      </button>
                      <button
                        type="button"
                        className={`cred-source-btn${source === '1password' ? ' is-active' : ''}`}
                        onClick={() => setCredSources(prev => ({ ...prev, [field]: '1password' }))}
                      >
                        1Password
                      </button>
                    </div>
                    {source === 'manual' ? (
                      <input
                        className="cp-input"
                        type="password"
                        placeholder={field}
                        value={credValues[field] ?? ''}
                        onChange={(e) => setCredValues(prev => ({ ...prev, [field]: e.target.value }))}
                        autoComplete="off"
                      />
                    ) : (
                      <OpSecretPicker
                        fieldName={field}
                        value={credValues[field]}
                        onSelect={(opRef) => setCredValues(prev => ({ ...prev, [field]: opRef }))}
                      />
                    )}
                  </div>
                )
              })}
            </>
          )}

          {/* Redaction patterns */}
          <label className="cp-label">Redaction patterns (regex, one per line)</label>
          <textarea
            className="cp-input service-editor-textarea"
            placeholder={'\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z]{2,}\\b'}
            value={redactionPatterns}
            onChange={(e) => setRedactionPatterns(e.target.value)}
            rows={3}
          />

          {/* Skill description */}
          <label className="cp-label">Skill description</label>
          <textarea
            className="cp-input service-editor-textarea"
            placeholder="Describe what this service provides to agents..."
            value={skillDescription}
            onChange={(e) => setSkillDescription(e.target.value)}
            rows={3}
          />
        </div>

        {error && <div className="cp-error">{error}</div>}

        <div className="cp-actions">
          <button className="cp-cancel" onClick={closeServiceEditor}>
            Cancel
          </button>
          <button
            className="cp-generate-btn"
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
