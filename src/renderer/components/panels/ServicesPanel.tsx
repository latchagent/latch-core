import { useState } from 'react'
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

  if (!servicesLoaded) return <div className="panel-empty">Loading services...</div>

  const handleNewService = () => {
    setEditingService(null)
    setEditorOpen(true)
  }

  const handleEditService = (definition: ServiceDefinition) => {
    setEditingService(definition)
    setEditorOpen(true)
  }

  const handleDeleteService = async (id: string, name: string) => {
    if (!window.confirm(`Delete service "${name}"? This cannot be undone.`)) return
    await deleteService(id)
  }

  const handleCatalogClick = (catalog: ServiceDefinition) => {
    setEditingService({ ...catalog, id: `custom-${Date.now()}` })
    setEditorOpen(true)
  }

  const handleEditorClose = () => {
    setEditorOpen(false)
    setEditingService(null)
    loadServices()
  }

  return (
    <div className="services-panel">
      <div className="panel-header">
        <h3>Services</h3>
      </div>

      <button
        className="panel-action is-primary"
        style={{ marginBottom: 12 }}
        onClick={handleNewService}
      >
        + Create Service
      </button>

      {services.length === 0 ? (
        <div className="panel-empty">
          <p>No services configured.</p>
          <p className="text-muted">Services provide authenticated access to external tools (GitHub, AWS, npm, etc.) without exposing credentials to agents.</p>
        </div>
      ) : (
        <div className="services-list">
          {services.map(svc => (
            <div
              key={svc.id}
              className="service-item"
              onClick={() => handleEditService(svc.definition)}
            >
              <div className="service-item-header">
                <span className="service-name">{svc.name}</span>
                <span className={`service-badge ${svc.hasCredential ? 'badge-ok' : 'badge-warn'}`}>
                  {svc.hasCredential ? 'configured' : 'no credential'}
                </span>
              </div>
              <div className="service-item-meta">
                <span className="text-muted">{svc.category} · {svc.definition.dataTier.defaultTier}</span>
              </div>
              <div className="service-item-actions">
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
          ))}
        </div>
      )}

      {serviceCatalog.length > 0 && (
        <div className="panel-section">
          <h4>Available Services</h4>
          <div className="catalog-list">
            {serviceCatalog
              .filter(cat => !services.some(s => s.definitionId === cat.id))
              .map(cat => (
                <div
                  key={cat.id}
                  className="catalog-item"
                  onClick={() => handleCatalogClick(cat)}
                >
                  <span className="service-name">{cat.name}</span>
                  <span className="text-muted">{cat.category}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {editorOpen && (
        <ServiceEditor onClose={handleEditorClose} initial={editingService} />
      )}
    </div>
  )
}
