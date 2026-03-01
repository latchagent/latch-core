import { describe, it, expect } from 'vitest'
import { SkillGenerator } from './skill-generator'
import type { ServiceDefinition } from '../../types'

const GITHUB: ServiceDefinition = {
  id: 'github',
  name: 'GitHub',
  category: 'vcs',
  protocol: 'http',
  credential: { type: 'token', fields: ['token'] },
  injection: { env: {}, files: {}, proxy: { domains: ['api.github.com'], headers: {} } },
  dataTier: { defaultTier: 'internal', redaction: { patterns: [], fields: [] } },
  skill: {
    description: 'GitHub access via gh CLI.',
    capabilities: ['gh pr create', 'git push'],
    constraints: ['Never print tokens'],
  },
}

describe('SkillGenerator', () => {
  const gen = new SkillGenerator()

  it('generates gateway meta skill', () => {
    const content = gen.generateGatewayMeta([GITHUB])
    expect(content).toContain('Latch Gateway')
    expect(content).toContain('GitHub')
    expect(content).toContain('Do not bypass network restrictions')
  })

  it('generates service skill', () => {
    const content = gen.generateServiceSkill(GITHUB)
    expect(content).toContain('GitHub')
    expect(content).toContain('gh pr create')
    expect(content).toContain('Never print tokens')
    expect(content).toContain('do NOT ask for tokens')
  })

  it('gateway meta lists all services', () => {
    const svc2: ServiceDefinition = { ...GITHUB, id: 'npm', name: 'npm', skill: { ...GITHUB.skill, description: 'npm access.' } }
    const content = gen.generateGatewayMeta([GITHUB, svc2])
    expect(content).toContain('GitHub')
    expect(content).toContain('npm')
  })
})
