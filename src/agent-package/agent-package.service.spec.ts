import AdmZip from 'adm-zip'
import { AgentPackageService } from './agent-package.service.js'

/**
 * Focused unit tests for readExpertDefaults — the publish-time gate for expert
 * JSONs shipped in config/experts/*.json. Covers dedup, nameless-file rejection,
 * and verdict-action validation (PR review findings #15 and #3).
 */
describe('AgentPackageService.readExpertDefaults', () => {
  // readExpertDefaults only touches the zip; the collaborators are unused here.
  const service = new AgentPackageService(null as any, null as any, null as any)

  const zipOf = (files: Record<string, unknown>): Buffer => {
    const zip = new AdmZip()
    for (const [path, body] of Object.entries(files)) {
      zip.addFile(path, Buffer.from(JSON.stringify(body), 'utf-8'))
    }
    return zip.toBuffer()
  }

  it('reads expert defaults gated on the experts capability', () => {
    const buf = zipOf({
      'config/experts/medical.json': { name: 'medical', priority: 95 },
    })
    const result = service.readExpertDefaults(buf, ['experts'])
    expect(result).toHaveLength(1)
    expect(result![0].name).toBe('medical')
  })

  it('returns null when the agent has neither experts nor plans capability', () => {
    const buf = zipOf({ 'config/experts/medical.json': { name: 'medical' } })
    expect(service.readExpertDefaults(buf, ['voice'])).toBeNull()
  })

  it('rejects a duplicate expert name across files', () => {
    const buf = zipOf({
      'config/experts/a.json': { name: 'medical', priority: 95 },
      'config/experts/b.json': { name: 'medical', priority: 90 },
    })
    expect(() => service.readExpertDefaults(buf, ['experts'])).toThrow(/Duplicate expert name "medical"/)
  })

  it('rejects an expert config missing a name', () => {
    const buf = zipOf({
      'config/experts/nameless.json': { priority: 50, description: 'no name' },
    })
    expect(() => service.readExpertDefaults(buf, ['experts'])).toThrow(/missing a "name"/)
  })

  it('rejects a typo’d verdict action at publish time', () => {
    const buf = zipOf({
      'config/experts/medical.json': {
        name: 'medical',
        verdict_directives: {
          critical: { action: 'overide', template: 'Call emergency services.' },
        },
      },
    })
    expect(() => service.readExpertDefaults(buf, ['experts'])).toThrow(/invalid action "overide"/)
  })

  it('accepts all valid verdict actions', () => {
    const buf = zipOf({
      'config/experts/medical.json': {
        name: 'medical',
        verdict_directives: {
          none: { action: 'inform' },
          low: { action: 'prepend', template: 'x' },
          high: { action: 'override', template: 'y' },
          critical: { action: 'short_circuit', template: 'z' },
        },
      },
    })
    expect(() => service.readExpertDefaults(buf, ['experts'])).not.toThrow()
  })
})
