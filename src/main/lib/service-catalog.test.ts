// src/main/lib/service-catalog.test.ts
import { describe, it, expect } from 'vitest'
import { SERVICE_CATALOG, getCatalogService } from './service-catalog'

describe('ServiceCatalog', () => {
  it('has at least 5 built-in services', () => {
    expect(SERVICE_CATALOG.length).toBeGreaterThanOrEqual(5)
  })

  it('every service has required fields', () => {
    for (const svc of SERVICE_CATALOG) {
      expect(svc.id).toBeTruthy()
      expect(svc.name).toBeTruthy()
      expect(svc.category).toBeTruthy()
      expect(svc.protocol).toBe('http') // v1: all HTTP
      expect(svc.credential.fields.length).toBeGreaterThan(0)
      expect(svc.injection.proxy.domains.length).toBeGreaterThan(0)
      expect(svc.skill.description).toBeTruthy()
    }
  })

  it('looks up service by id', () => {
    const gh = getCatalogService('github')
    expect(gh).toBeDefined()
    expect(gh!.name).toBe('GitHub')
  })

  it('returns undefined for unknown id', () => {
    expect(getCatalogService('nope')).toBeUndefined()
  })
})
