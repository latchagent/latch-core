import { useEffect, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import ServiceEditor from '../modals/ServiceEditor'
import type { ServiceDefinition } from '../../../types'

export default function ServicesPanel() {
  const services = useAppStore(s => s.services)
  const serviceCatalog = useAppStore(s => s.serviceCatalog)
  const servicesLoaded = useAppStore(s => s.servicesLoaded)
  const loadServices = useAppStore(s => s.loadServices)
  const deleteService = useAppStore(s => s.deleteService)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingService, setEditingService] = useState<ServiceDefinition | null>(null)
  const [editingHasCredential, setEditingHasCredential] = useState(false)
  const [validating, setValidating] = useState<string | null>(null)
  const [validationResults, setValidationResults] = useState<Record<string, boolean | null>>({})

  useEffect(() => {
    if (!servicesLoaded) loadServices()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!servicesLoaded) return <div className="view-container"><p className="text-muted">Loading services...</p></div>

  const handleNewService = () => {
    setEditingService(null)
    setEditingHasCredential(false)
    setEditorOpen(true)
  }

  const handleEditService = (definition: ServiceDefinition, hasCredential: boolean) => {
    setEditingService(definition)
    setEditingHasCredential(hasCredential)
    setEditorOpen(true)
  }

  const handleDeleteService = async (id: string, name: string) => {
    if (!window.confirm(`Delete service "${name}"? This cannot be undone.`)) return
    await deleteService(id)
  }

  const handleCatalogClick = (catalog: ServiceDefinition) => {
    setEditingService({ ...catalog, id: `custom-${Date.now()}` })
    setEditingHasCredential(false)
    setEditorOpen(true)
  }

  const handleValidate = async (serviceId: string) => {
    if (!window.latch?.refreshCredential) return
    setValidating(serviceId)
    setValidationResults(prev => ({ ...prev, [serviceId]: null }))
    try {
      const result = await window.latch.refreshCredential({ serviceId })
      setValidationResults(prev => ({ ...prev, [serviceId]: result.ok }))
    } catch {
      setValidationResults(prev => ({ ...prev, [serviceId]: false }))
    } finally {
      setValidating(null)
    }
  }

  const handleEditorClose = () => {
    setEditorOpen(false)
    setEditingService(null)
    loadServices()
  }

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h2 className="view-title">Services</h2>
          <p className="view-subtitle">Configure authenticated access to external tools without exposing credentials to agents.</p>
        </div>
        <button className="view-action-btn" onClick={handleNewService}>
          + New Service
        </button>
      </div>

      {services.length === 0 ? (
        <div className="policies-empty">
          <div className="policies-empty-text">No services configured</div>
          <div className="policies-empty-hint">
            Services provide authenticated access to GitHub, AWS, npm, and other tools. Credentials are injected by the gateway proxy — never exposed to agents.
          </div>
          <button className="cp-generate-btn" onClick={handleNewService}>
            + New Service
          </button>
        </div>
      ) : (
        <div className="policies-list">
          {services.map(svc => (
            <div
              key={svc.id}
              className="policy-list-item"
              onClick={() => handleEditService(svc.definition, svc.hasCredential)}
            >
              <div className="policy-list-left">
                <div className="policy-list-name">
                  {svc.name}
                  <span className={`policy-active-badge ${svc.hasCredential ? '' : 'is-warn'}`}>
                    {svc.hasCredential ? 'configured' : 'no credential'}
                  </span>
                </div>
                <div className="policy-list-desc">{svc.category} · {svc.definition.dataTier.defaultTier}</div>
              </div>
              <div className="policy-list-right">
                <div className="policy-list-actions">
                  {svc.hasCredential && (
                    <button
                      className={`panel-action ${validationResults[svc.id] === true ? 'is-ok' : validationResults[svc.id] === false ? 'is-danger' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleValidate(svc.id)
                      }}
                      disabled={validating === svc.id}
                    >
                      {validating === svc.id ? 'Validating...' : validationResults[svc.id] === true ? 'Valid' : validationResults[svc.id] === false ? 'Invalid' : 'Validate'}
                    </button>
                  )}
                  <button
                    className="panel-action is-danger"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteService(svc.id, svc.name)
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {serviceCatalog.length > 0 && (
        <>
          <div className="view-section-label" style={{ marginTop: 24 }}>Available from catalog</div>
          <div className="policies-list">
            {serviceCatalog
              .filter(cat => !services.some(s => s.definitionId === cat.id))
              .map(cat => (
                <div
                  key={cat.id}
                  className="policy-list-item"
                  onClick={() => handleCatalogClick(cat)}
                  style={{ cursor: 'pointer' }}
                >
                  <div className="policy-list-left">
                    <div className="policy-list-name">{cat.name}</div>
                    <div className="policy-list-desc">{cat.category}</div>
                  </div>
                </div>
              ))}
          </div>
        </>
      )}

      {editorOpen && (
        <ServiceEditor onClose={handleEditorClose} initial={editingService} hasExistingCredential={editingHasCredential} />
      )}
    </div>
  )
}
