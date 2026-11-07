import { Prisma } from '@prisma/client'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { loadAgentDirectory } from '../agent-package/agent-directory.js'
import { manifestToAgentTypeData } from '../agent-package/manifest-mapper.js'
import { parseAgentManifest } from '../agent-package/schemas/agent-manifest.schema.js'
import { manifestOfAgentType, resolveAgentRequirements, type AgentTypeManifestSource } from './agent-requirements.js'

// What a deployment needs comes from the manifest alone, and a row stored
// before the manifest column existed reads the same as one stored after.

const ROOT = process.cwd()
const builtIn = (slug: string) => loadAgentDirectory(path.join(ROOT, 'agents', slug)).manifest
const base = {
  version: '2.0',
  metadata: { name: 'A', slug: 'a-agent', version: '1.0.0', description: 'a' },
  image: { dockerfile: 'Dockerfile' },
}
const manifest = (extra: Record<string, unknown> = {}) => {
  const result = parseAgentManifest({ ...base, ...extra })
  if (!result.manifest) throw new Error(result.errors.join('\n'))
  return result.manifest
}

/** The row the seed or upload would write, as the deploy path reads it back. */
function storedRow(m: ReturnType<typeof manifest>, withManifestColumn: boolean): AgentTypeManifestSource {
  const data = manifestToAgentTypeData(m, null) as Record<string, any>
  const json = (value: unknown) => (value === Prisma.JsonNull || value === Prisma.DbNull ? null : value)
  return {
    slug: data.slug,
    manifest: withManifestColumn ? (data.manifest as any) : null,
    name: data.name,
    description: data.description,
    version: data.version,
    icon: data.icon,
    capabilities: data.capabilities,
    dockerfilePath: data.dockerfilePath,
    configSchema: json(data.configSchema) as any,
    defaultConfig: json(data.defaultConfig) as any,
    pipelineSchema: json(data.pipelineSchema) as any,
    resourceMemory: data.resourceMemory,
    resourceCpu: data.resourceCpu,
    sdkMinVersion: data.sdkMinVersion,
  }
}

describe('agent requirements', () => {
  it('stella-v2 needs a plan or a companion session, a configuration and an OpenAI key', () => {
    const r = resolveAgentRequirements(builtIn('stella-v2-agent'))
    expect(r.persona).toBe(true)
    expect(r.plans).toEqual({ required: true, modes: ['plan', 'companion'] })
    expect(r.configurator).toEqual({ required: true })
    expect(r.env.required).toEqual(['OPENAI_API_KEY'])
  })

  it('stella-light takes a configuration but does not need one', () => {
    const r = resolveAgentRequirements(builtIn('stella-light-agent'))
    expect(r.plans).toEqual({ required: true, modes: ['plan'] })
    expect(r.configurator).toEqual({ required: false })
  })

  it('an agent that declares nothing needs nothing', () => {
    const r = resolveAgentRequirements(manifest())
    expect(r).toMatchObject({
      persona: true,
      plans: null,
      configurator: null,
      env: { required: [], optional: [] },
      connectors: [],
      configSchema: null,
      defaultConfig: {},
      sdkMinVersion: null,
    })
    expect(r.resources).toEqual({
      memory: { request: '512Mi', limit: '512Mi' },
      cpu: { request: '250m', limit: '250m' },
      gpu: false,
    })
  })

  it('takes requests and limits from the manifest, lowering a default request to a smaller limit', () => {
    const r = resolveAgentRequirements(
      manifest({ resources: { memory: { limit: '256Mi' }, cpu: { request: '50m', limit: '1' } } }),
    )
    expect(r.resources.memory).toEqual({ request: '256Mi', limit: '256Mi' })
    expect(r.resources.cpu).toEqual({ request: '50m', limit: '1' })
  })

  it('hands out copies, so a caller cannot change the manifest', () => {
    const m = manifest({ configSchema: { type: 'object', properties: { a: { type: 'string' } } } })
    const r = resolveAgentRequirements(m)
    ;(r.configSchema as any).properties.a.type = 'number'
    expect((m.configSchema as any).properties.a.type).toBe('string')
  })
})

describe('the manifest of a stored agent type', () => {
  it.each(['stella-v2-agent', 'stella-light-agent'])('%s: reads the manifest column', (slug) => {
    const m = builtIn(slug)
    expect(manifestOfAgentType(storedRow(m, true))).toEqual(m)
  })

  it.each(['stella-v2-agent', 'stella-light-agent'])(
    '%s: a row from before the manifest column gives the same requirements',
    (slug) => {
      const m = builtIn(slug)
      // Such a row's configSchema column carries the 1.0 x-stella-* flags.
      const v1 = yaml.load(fs.readFileSync(path.join(ROOT, 'src/agent-package/__fixtures__', `${slug}.v1.yaml`), 'utf-8')) as any
      const legacy = resolveAgentRequirements(manifestOfAgentType({ ...storedRow(m, false), configSchema: v1.configSchema }))
      const current = resolveAgentRequirements(m)
      // 1.0 columns cannot say that a configuration is required, nor carry
      // requests or a client channel (the seed refreshes built-ins on start).
      expect({ ...legacy, configurator: null, resources: null, client: null }).toEqual({
        ...current,
        configurator: null,
        resources: null,
        client: null,
      })
      expect(legacy.client).toEqual({ events: [], commands: [] })
      expect(legacy.configurator).toEqual({ required: false })
      expect(legacy.resources.memory.limit).toBe(current.resources.memory.limit)
    },
  )

  it('refuses a row it cannot read, saying to upload again', () => {
    const row = storedRow(manifest(), false)
    row.version = 'not-a-version'
    expect(() => manifestOfAgentType(row)).toThrow(/a-agent has a manifest STELLA cannot read.*Upload it again/)
  })
})

describe('the client channel', () => {
  const client = (value: unknown) => parseAgentManifest({ ...base, client: value })

  it('stella-v2 declares what its face sends and is told', () => {
    const r = resolveAgentRequirements(builtIn('stella-v2-agent'))
    expect(r.client.events.map((e) => e.name)).toEqual(['wake', 'sleep'])
    expect(r.client.commands.map((c) => c.name)).toEqual(['sleep', 'sleep_allowed'])
  })

  it('declares nothing by default, also for a stored row without it', () => {
    expect(resolveAgentRequirements(manifest()).client).toEqual({ events: [], commands: [] })
    expect(resolveAgentRequirements(manifestOfAgentType(storedRow(manifest(), false))).client).toEqual({ events: [], commands: [] })
  })

  it('takes events and commands with a JSON Schema for their data', () => {
    const result = client({
      events: [{ name: 'rate', description: 'stars', data: { type: 'object', properties: { stars: { type: 'integer', minimum: 1 } } } }],
      commands: [{ name: 'show_card' }],
    })
    expect(result.errors).toEqual([])
    expect(result.manifest!.client.events[0].name).toBe('rate')
  })

  it.each([
    [{ events: [{ name: 'stella.interaction_mode' }] }, /client.events.0.name/],
    [{ events: [{ name: 'Wake' }] }, /client.events.0.name/],
    [{ events: [{ name: 'wake' }, { name: 'wake' }] }, /duplicate event "wake"/],
    [{ commands: [{ name: 'go', extra: true }] }, /client.commands.0/],
    [{ events: [{ name: 'say', data: { type: 'object', properties: { t: { type: 'string', pattern: 'a+' } } } }] }, /client.events.0.data \(say\): pattern is not allowed/],
    [{ events: [{ name: 'say', data: { type: 'nope' } }] }, /client.events.0.data/],
  ])('refuses %j', (value, error) => {
    const result = client(value)
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toMatch(error)
  })
})
