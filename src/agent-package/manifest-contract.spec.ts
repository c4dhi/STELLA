import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import AdmZip from 'adm-zip'
import * as os from 'os'
import { builtInDockerfilePath, loadAgentDirectory } from './agent-directory.js'
import { AgentPackageService } from './agent-package.service.js'
import { DEFAULT_DOCKERFILE, RESOURCE_DEFAULTS } from './manifest-defaults.js'
import { manifestToAgentTypeData, toLegacyConfigSchema } from './manifest-mapper.js'
import {
  MANIFEST_JSON_SCHEMA_PATH,
  manifestJsonSchema,
  parseAgentManifest,
  parseAgentManifestYaml,
  validateAgainstSchema,
} from './schemas/agent-manifest.schema.js'
import * as clamping from '../kubernetes/utils/resource-clamping.util.js'

// agent.yaml is the single source of truth for an agent. These pin the pieces
// that make that true: one format (older ones upgrade losslessly), one mapping
// to the database for built-in and uploaded agents, and one set of defaults.

const ROOT = process.cwd()
const FIXTURES = path.join(ROOT, 'src/agent-package/__fixtures__')
const BUILTIN = ['stella-v2-agent', 'stella-light-agent']

const read = (p: string) => fs.readFileSync(p, 'utf-8')
const parse = (text: string) => {
  const result = parseAgentManifestYaml(text)
  if (!result.valid) throw new Error(result.errors.join('\n'))
  return result
}
const base = {
  version: '2.0',
  metadata: { name: 'A', slug: 'a-agent', version: '1.0.0', description: 'a' },
  image: { dockerfile: 'Dockerfile' },
}

describe('built-in agents on manifest 2.0', () => {
  it.each(BUILTIN)('%s: the 1.0 file upgrades to exactly the 2.0 file', (slug) => {
    const v1 = parse(read(path.join(FIXTURES, `${slug}.v1.yaml`)))
    const v2 = parse(read(path.join(ROOT, 'agents', slug, 'agent.yaml')))
    expect(v2.warnings).toEqual([])
    expect(v1.warnings.join('\n')).toContain('Manifest version 1.0 is deprecated')
    // What 1.0 could not say, which STELLA used to hard-code for the built-ins:
    // that a configuration is required, and the pod's start command.
    const v2Features = { ...v2.manifest!.features, configurator: v2.manifest!.features.configurator && { required: false } }
    const { command: _command, ...v2Image } = v2.manifest!.image
    expect(v1.manifest).toEqual({ ...v2.manifest, features: v2Features, image: v2Image })
  })

  it.each(BUILTIN)('%s: the configSchema column stays what readers of 1.0 flags expect', (slug) => {
    // The deploy wizard and env injection still read x-stella-* from this column.
    const old = (yaml.load(read(path.join(FIXTURES, `${slug}.v1.yaml`))) as Record<string, unknown>).configSchema
    const column = toLegacyConfigSchema(parse(read(path.join(ROOT, 'agents', slug, 'agent.yaml'))).manifest!)
    const { 'x-stella-connectors': connectors, ...rest } = column
    expect(connectors).toEqual([])
    expect(rest).toEqual(old)
  })
})

describe('built-in agents are found by their folder', () => {
  it.each(BUILTIN)('%s: lives in agents/<slug>/ with the default Dockerfile name, which build.sh pre-builds', (slug) => {
    const { manifest } = loadAgentDirectory(path.join(ROOT, 'agents', slug))
    expect(builtInDockerfilePath(manifest)).toBe(`agents/${slug}/${DEFAULT_DOCKERFILE}`)
  })

  it('refuses a built-in whose folder is not named after its slug', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'))
    fs.copyFileSync(path.join(ROOT, 'agents/stella-light-agent/agent.yaml'), path.join(dir, 'agent.yaml'))
    expect(() => loadAgentDirectory(dir)).toThrow(/must be named stella-light-agent/)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('one mapping for built-in and uploaded agents', () => {
  it.each(BUILTIN)('%s: seed and upload read the same experts and write the same columns', (slug) => {
    const dir = path.join(ROOT, 'agents', slug)
    const seeded = loadAgentDirectory(dir)

    const zip = new AdmZip()
    zip.addLocalFolder(dir, '', (file) => file === 'agent.yaml' || file.startsWith('config/experts/'))
    const service = new AgentPackageService({} as any, {} as any, {} as any)
    const uploaded = service.readExpertDefaults(zip.toBuffer(), seeded.manifest.capabilities)

    expect(uploaded).toEqual(seeded.expertDefaults)
    expect(manifestToAgentTypeData(seeded.manifest, uploaded)).toEqual(
      manifestToAgentTypeData(seeded.manifest, seeded.expertDefaults),
    )
  })

  it('stores the full normalized manifest', () => {
    const { manifest } = parse(read(path.join(ROOT, 'agents/stella-v2-agent/agent.yaml')))
    expect(manifestToAgentTypeData(manifest!, null).manifest).toEqual(manifest)
  })
})

describe('one set of defaults', () => {
  it('pod clamping uses the manifest defaults and maxima', () => {
    expect(clamping.DEFAULT_MEMORY_LIMIT).toBe(RESOURCE_DEFAULTS.memory.limit)
    expect(clamping.DEFAULT_CPU_LIMIT).toBe(RESOURCE_DEFAULTS.cpu.limit)
    expect(clamping.MAX_MEMORY_BYTES).toBe(4 * 1024 ** 3)
    expect(clamping.MAX_CPU_MILLICORES).toBe(2000)
  })

  it('the database column defaults match', () => {
    const prisma = read(path.join(ROOT, 'prisma/schema.prisma'))
    expect(prisma).toMatch(new RegExp(`resourceMemory\\s+String\\?\\s+@default\\("${RESOURCE_DEFAULTS.memory.limit}"\\)`))
    expect(prisma).toMatch(new RegExp(`resourceCpu\\s+String\\?\\s+@default\\("${RESOURCE_DEFAULTS.cpu.limit}"\\)`))
  })

  it('an agent that declares nothing gets the defaults', () => {
    const { manifest } = parseAgentManifest(base)
    expect(manifest!.features).toEqual({ persona: true })
    expect(manifest!.env).toEqual({ required: [], optional: [] })
    const row = manifestToAgentTypeData(manifest!, null)
    expect([row.resourceMemory, row.resourceCpu]).toEqual([RESOURCE_DEFAULTS.memory.limit, RESOURCE_DEFAULTS.cpu.limit])
  })
})

describe('manifest 2.0 rules', () => {
  const errors = (extra: Record<string, unknown>) => parseAgentManifest({ ...base, ...extra }).errors.join('\n')

  it('refuses an unknown manifest version', () => {
    expect(errors({ version: '3.0' })).toContain('unsupported manifest version')
  })

  it('refuses unknown top-level keys instead of dropping them', () => {
    expect(errors({ connectorz: [] })).toContain('connectorz')
  })

  it('refuses 1.0 flags inside a 2.0 configSchema', () => {
    expect(errors({ configSchema: { type: 'object', 'x-stella-env-vars': ['A_KEY'] } })).toContain(
      'x-stella-env-vars is a manifest 1.0 flag',
    )
  })

  it('keeps features and capabilities in agreement', () => {
    expect(errors({ features: { plans: {} } })).toContain('features.plans needs the "plans" capability')
    expect(errors({ capabilities: ['plans'] })).toContain('the "plans" capability needs features.plans')
    expect(errors({ capabilities: ['plans'], features: { plans: { modes: ['plan', 'companion'] } } })).toContain(
      'includes "companion" exactly when',
    )
  })

  it('needs a pipelineSchema for the configurator', () => {
    expect(errors({ features: { configurator: true } })).toContain('features.configurator needs a pipelineSchema')
  })

  it('reads configurator: true as an optional configuration', () => {
    const pipelineSchema = { nodes: [], edges: [], thresholds: [] }
    const on = parseAgentManifest({ ...base, pipelineSchema, features: { configurator: true } })
    const required = parseAgentManifest({ ...base, pipelineSchema, features: { configurator: { required: true } } })
    const off = parseAgentManifest({ ...base, features: { configurator: false } })
    expect([on.errors, required.errors, off.errors]).toEqual([[], [], []])
    expect(on.manifest!.features.configurator).toEqual({ required: false })
    expect(required.manifest!.features.configurator).toEqual({ required: true })
    expect(off.manifest!.features.configurator).toBeUndefined()
  })

  it('refuses a request above its limit, and limits above the maximum', () => {
    expect(errors({ resources: { memory: { request: '1Gi', limit: '256Mi' } } })).toContain('memory request must not exceed its limit')
    expect(errors({ resources: { cpu: { limit: '4' } } })).toContain('cpu limit exceeds maximum allowed: 2000m')
  })

  it('checks defaultConfig against configSchema', () => {
    expect(
      errors({
        configSchema: { type: 'object', properties: { project_id: { type: 'string' } } },
        defaultConfig: { project_id: 7 },
      }),
    ).toContain('defaultConfig: must be string at /project_id')
  })

  it('refuses regular expressions in configSchema, which could freeze the server (ReDoS)', () => {
    // The case from review: this took 312 ms at 26 characters and doubles with each one more.
    const configSchema = {
      type: 'object',
      properties: { name: { type: 'string', pattern: '^(a+)+$' } },
      $defs: { tag: { type: 'object', patternProperties: { '^(a|a)+$': { type: 'string' } } } },
    }
    const started = Date.now()
    const result = parseAgentManifest({ ...base, configSchema, defaultConfig: { name: 'a'.repeat(40) + '!' } })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(result.errors.join('\n')).toContain('pattern is not allowed (at /properties/name/pattern)')
    expect(result.errors.join('\n')).toContain('patternProperties is not allowed (at /$defs/tag/patternProperties)')
    // A setting that is merely named "pattern" is fine.
    expect(parseAgentManifest({ ...base, configSchema: { type: 'object', properties: { pattern: { type: 'string' } } } }).errors).toEqual([])
  })

  it.each([
    // The three bypasses from review: each took over 300 ms and doubled with each character.
    ['$ref to a custom root key', { type: 'object', properties: { s: { $ref: '#/x-defs/evil' } }, 'x-defs': { evil: { type: 'string', pattern: '^(a+)+$' } } }],
    ['draft-7 dependencies', { type: 'object', dependencies: { s: { properties: { s: { type: 'string', pattern: '^(a+)+$' } } } } }],
    ['$ref into an unknown key', { type: 'object', properties: { t: { foo: { type: 'string', pattern: '^(a+)+$' } }, s: { $ref: '#/properties/t/foo' } } }],
    ['propertyNames', { type: 'object', propertyNames: { pattern: '^(a+)+$' } }],
  ])('refuses a regular expression reached through %s, without running it', (_, configSchema) => {
    for (const extra of [{ defaultConfig: { s: 'a'.repeat(40) + '!' } }, {}]) {
      const started = Date.now()
      const result = parseAgentManifest({ ...base, configSchema, ...extra })
      expect(Date.now() - started).toBeLessThan(200)
      expect(result.errors.join('\n')).toMatch(/^configSchema: (regular expressions are not allowed|pattern is not allowed)/)
    }
    // The deploy path refuses it too, for a row stored before this check.
    expect(validateAgainstSchema(configSchema, { s: 'a'.repeat(40) + '!' }).join('\n')).toMatch(/not allowed/)
  })

  it('reports a $schema Ajv does not know as an error, not a crash', () => {
    const configSchema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }
    expect(parseAgentManifest({ ...base, configSchema }).errors.join('\n')).toMatch(/^configSchema: schema cannot be used/)
  })

  it('reports a configSchema Ajv cannot compile as an error, not a crash', () => {
    const configSchema = { type: 'object', properties: { a: { $ref: '#/$defs/missing' } } }
    for (const extra of [{ defaultConfig: { a: 1 } }, {}]) {
      const result = parseAgentManifest({ ...base, configSchema, ...extra })
      expect(result.errors.join('\n')).toMatch(/^configSchema: schema cannot be used/)
    }
  })

  it('does not ask defaultConfig for settings the user must give', () => {
    const configSchema = {
      type: 'object',
      required: ['elias'],
      properties: { elias: { type: 'object', required: ['project_id'], properties: { project_id: { type: 'string' } } } },
    }
    expect(parseAgentManifest({ ...base, configSchema, defaultConfig: { elias: {} } }).errors).toEqual([])
  })

  it('refuses a name that is both a required and an optional env var', () => {
    expect(errors({ env: { required: ['A_KEY'], optional: [{ name: 'A_KEY' }] } })).toContain('A_KEY is both required and optional')
  })
})

describe('upgrading manifest 1.0', () => {
  const upgrade = (configSchema: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    parseAgentManifest({ ...base, version: '1.0', configSchema, ...extra })

  it('moves connectors out of configSchema', () => {
    const slot = { slot: 'elias', kind: 'mcp', required: true, label: 'ELIAS', requiredTools: ['get_guide'] }
    const result = upgrade({ type: 'object', 'x-stella-connectors': [slot] })
    expect(result.manifest!.connectors).toEqual([slot])
    expect(result.manifest!.configSchema).toBeUndefined()
  })

  it('keeps user settings and drops only the injected plan', () => {
    const result = upgrade(
      {
        type: 'object',
        required: ['plan', 'elias'],
        properties: {
          plan: { type: 'object', 'x-stella-requires-plan': true },
          elias: { type: 'object', properties: { project_id: { type: 'string' } } },
        },
      },
      { capabilities: ['plans'] },
    )
    expect(result.manifest!.features.plans).toEqual({ required: true, modes: ['plan'] })
    expect(result.manifest!.configSchema).toEqual({
      type: 'object',
      required: ['elias'],
      properties: { elias: { type: 'object', properties: { project_id: { type: 'string' } } } },
    })
  })

  it('maps the companion capability to the companion mode', () => {
    const result = upgrade({ type: 'object' }, { capabilities: ['plans', 'companion'] })
    expect(result.manifest!.features.plans).toEqual({ required: false, modes: ['plan', 'companion'] })
  })
})

describe('published JSON Schema', () => {
  it(`${MANIFEST_JSON_SCHEMA_PATH} is current (run npm run manifest:schema)`, () => {
    const committed = JSON.parse(read(path.join(ROOT, MANIFEST_JSON_SCHEMA_PATH)))
    expect(committed).toEqual(manifestJsonSchema())
  })
})
