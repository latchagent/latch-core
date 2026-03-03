/**
 * @module OpSecretPicker
 * @description Inline picker for selecting a 1Password secret reference.
 *
 * Three cascading dropdowns: Vault → Item → Field.
 * Builds an `op://vault/item/field` reference and calls `onSelect`.
 * Handles connection flow inline if not already connected.
 */

import React, { useEffect, useState, useCallback } from 'react'
import type { OpVault, OpItem, OpField } from '../../types'

interface OpSecretPickerProps {
  /** Credential field name (used as default hint). */
  fieldName: string
  /** Called with the `op://vault/item/field` reference when user completes selection. */
  onSelect: (opRef: string) => void
  /** Pre-selected op:// reference (for editing). */
  value?: string
}

type PickerState = 'checking' | 'unavailable' | 'disconnected' | 'connecting' | 'ready' | 'error'

export default function OpSecretPicker({ fieldName, onSelect, value }: OpSecretPickerProps) {
  const [state, setState] = useState<PickerState>('checking')
  const [error, setError] = useState('')

  const [vaults, setVaults] = useState<OpVault[]>([])
  const [items, setItems] = useState<OpItem[]>([])
  const [fields, setFields] = useState<OpField[]>([])

  const [selectedVaultId, setSelectedVaultId] = useState('')
  const [selectedItemId, setSelectedItemId] = useState('')
  const [selectedFieldLabel, setSelectedFieldLabel] = useState('')

  const [loadingVaults, setLoadingVaults] = useState(false)
  const [loadingItems, setLoadingItems] = useState(false)
  const [loadingFields, setLoadingFields] = useState(false)

  const [itemFilter, setItemFilter] = useState('')

  // ── Derived ────────────────────────────────────────────────────────────

  const selectedVault = vaults.find(v => v.id === selectedVaultId)
  const selectedItem = items.find(i => i.id === selectedItemId)
  const filteredItems = itemFilter
    ? items.filter(i => i.title.toLowerCase().includes(itemFilter.toLowerCase()))
    : items

  const [needsCli, setNeedsCli] = useState(false)

  // ── Check status on mount ──────────────────────────────────────────────

  useEffect(() => {
    const check = async () => {
      const status = await window.latch?.opStatus?.() as any
      if (!status) { setState('unavailable'); return }
      if (!status.available) {
        if (status.appInstalled && !status.cliInstalled) setNeedsCli(true)
        setState('unavailable')
        return
      }
      if (status.connected) {
        setState('ready')
        doLoadVaults()
      } else {
        setState('disconnected')
      }
    }
    check()
  }, [])

  // ── Connect ────────────────────────────────────────────────────────────

  const handleConnect = useCallback(async () => {
    setState('connecting')
    setError('')
    const result = await window.latch?.opConnect?.()
    if (result?.ok) {
      setState('ready')
      doLoadVaults()
    } else {
      setError(result?.error ?? 'Connection failed')
      setState('error')
    }
  }, [])

  // ── Load vaults ────────────────────────────────────────────────────────

  const doLoadVaults = useCallback(async () => {
    setLoadingVaults(true)
    const result = await window.latch?.opListVaults?.()
    setLoadingVaults(false)
    if (result?.ok) {
      setVaults(result.vaults)
      // Auto-select if only one vault
      if (result.vaults.length === 1) {
        setSelectedVaultId(result.vaults[0].id)
        doLoadItems(result.vaults[0].id)
      }
    } else {
      setError(result?.error ?? 'Failed to load vaults')
    }
  }, [])

  // ── Load items ─────────────────────────────────────────────────────────

  const doLoadItems = useCallback(async (vaultId: string) => {
    setLoadingItems(true)
    setItems([])
    setFields([])
    setSelectedItemId('')
    setSelectedFieldLabel('')
    setItemFilter('')
    const result = await window.latch?.opListItems?.({ vaultId })
    setLoadingItems(false)
    if (result?.ok) {
      setItems(result.items)
    } else {
      setError(result?.error ?? 'Failed to load items')
    }
  }, [])

  // ── Load fields ────────────────────────────────────────────────────────

  const doLoadFields = useCallback(async (itemId: string, vaultId: string) => {
    setLoadingFields(true)
    setFields([])
    setSelectedFieldLabel('')
    const result = await window.latch?.opGetItemFields?.({ itemId, vaultId })
    setLoadingFields(false)
    if (result?.ok) {
      setFields(result.fields)
      // Auto-select if there's a "password", "credential", or "token" field
      const autoField = result.fields.find(f =>
        ['password', 'credential', 'token', fieldName].includes(f.label.toLowerCase())
      )
      if (autoField) {
        setSelectedFieldLabel(autoField.label)
        emitRef(vaultId, itemId, autoField.label)
      } else if (result.fields.length === 1) {
        setSelectedFieldLabel(result.fields[0].label)
        emitRef(vaultId, itemId, result.fields[0].label)
      }
    } else {
      setError(result?.error ?? 'Failed to load fields')
    }
  }, [fieldName])

  // ── Build & emit op:// reference ───────────────────────────────────────

  const emitRef = (vaultId: string, itemId: string, fieldLabel: string) => {
    const vault = vaults.find(v => v.id === vaultId)
    const item = items.find(i => i.id === itemId)
    if (vault && item && fieldLabel) {
      onSelect(`op://${vault.name}/${item.title}/${fieldLabel}`)
    }
  }

  // ── Handlers ───────────────────────────────────────────────────────────

  const handleVaultChange = (vaultId: string) => {
    setSelectedVaultId(vaultId)
    if (vaultId) doLoadItems(vaultId)
  }

  const handleItemChange = (itemId: string) => {
    setSelectedItemId(itemId)
    if (itemId && selectedVaultId) doLoadFields(itemId, selectedVaultId)
  }

  const handleFieldChange = (fieldLabel: string) => {
    setSelectedFieldLabel(fieldLabel)
    if (fieldLabel) emitRef(selectedVaultId, selectedItemId, fieldLabel)
  }

  // ── Render states ──────────────────────────────────────────────────────

  if (state === 'checking') {
    return <div className="op-picker-status">Checking 1Password...</div>
  }

  if (state === 'unavailable') {
    return (
      <div className="op-picker-status op-picker-unavailable">
        {needsCli ? (
          <>
            1Password CLI not enabled.
            <span className="op-picker-hint">Open 1Password → Settings → Developer → enable "Integrate with 1Password CLI".</span>
          </>
        ) : (
          <>
            1Password not detected.
            <span className="op-picker-hint">Install 1Password 8+ to use this feature.</span>
          </>
        )}
      </div>
    )
  }

  if (state === 'disconnected' || state === 'connecting' || state === 'error') {
    return (
      <div className="op-picker-connect">
        <button
          className="panel-action is-primary"
          onClick={handleConnect}
          disabled={state === 'connecting'}
          style={{ padding: '4px 12px', fontSize: 12 }}
        >
          {state === 'connecting' ? 'Connecting...' : 'Connect to 1Password'}
        </button>
        {error && <span className="op-picker-error">{error}</span>}
      </div>
    )
  }

  // ── Connected: vault → item → field ────────────────────────────────────

  return (
    <div className="op-picker">
      {/* Vault */}
      <select
        className="cp-input op-picker-select"
        value={selectedVaultId}
        onChange={(e) => handleVaultChange(e.target.value)}
        disabled={loadingVaults}
      >
        <option value="">{loadingVaults ? 'Loading vaults...' : 'Select vault'}</option>
        {vaults.map(v => (
          <option key={v.id} value={v.id}>{v.name}</option>
        ))}
      </select>

      {/* Item (with filter when list is long) */}
      {selectedVaultId && (
        <>
          {items.length > 8 && (
            <input
              className="cp-input"
              placeholder="Filter items..."
              value={itemFilter}
              onChange={(e) => setItemFilter(e.target.value)}
              style={{ marginTop: 4 }}
            />
          )}
          <select
            className="cp-input op-picker-select"
            value={selectedItemId}
            onChange={(e) => handleItemChange(e.target.value)}
            disabled={loadingItems}
            style={{ marginTop: 4 }}
          >
            <option value="">{loadingItems ? 'Loading items...' : 'Select item'}</option>
            {filteredItems.map(i => (
              <option key={i.id} value={i.id}>{i.title}</option>
            ))}
          </select>
        </>
      )}

      {/* Field */}
      {selectedItemId && fields.length > 0 && (
        <select
          className="cp-input op-picker-select"
          value={selectedFieldLabel}
          onChange={(e) => handleFieldChange(e.target.value)}
          disabled={loadingFields}
          style={{ marginTop: 4 }}
        >
          <option value="">{loadingFields ? 'Loading fields...' : 'Select field'}</option>
          {fields.map(f => (
            <option key={f.id} value={f.label}>
              {f.label}{f.sectionLabel ? ` (${f.sectionLabel})` : ''}{f.type === 'CONCEALED' ? ' 🔒' : ''}
            </option>
          ))}
        </select>
      )}

      {/* Reference preview */}
      {selectedVault && selectedItem && selectedFieldLabel && (
        <div className="op-picker-ref">
          op://{selectedVault.name}/{selectedItem.title}/{selectedFieldLabel}
        </div>
      )}
    </div>
  )
}
