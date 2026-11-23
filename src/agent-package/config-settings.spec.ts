import * as fs from 'fs'
import * as path from 'path'
import {
  checkConfigSettingValue,
  configSettingsOf,
  declareConfigSettings,
  type ConfigSetting,
} from './config-settings.js'
import { manifestToAgentTypeData } from './manifest-mapper.js'
import { parseAgentManifest, parseAgentManifestYaml } from './schemas/agent-manifest.schema.js'

// #996: an agent declares the settings a configuration may change, once, and
// validation and the Configurator read that one list.

const base = {
  version: '2.0',
  metadata: { name: 'A', slug: 'a-agent', version: '1.0.0', description: 'a' },
  image: { dockerfile: 'Dockerfile' },
  pipelineSchema: {
    nodes: [
      {
        id: 'expert_pool',
        label: 'Expert Pool',
        position: { row: 0, col: 0 },
        slots: [{ id: 'ask_threshold', label: 'Ask', type: 'number', default: 0.45, min: 0, max: 1 }],
      },
    ],
    edges: [],
    thresholds: [],
  },
}

const errorsOf = (manifest: Record<string, unknown>) => parseAgentManifest(manifest).errors.join('\n')

describe('declaring configuration settings', () => {
  it('turns pipeline slots into settings keyed <node>.<slot>', () => {
    const settings = declareConfigSettings({
      nodes: [
        {
          id: 'response_generator',
          slots: [
            { id: 'model', label: 'Model', type: 'select', options: ['a', 'b'], default: 'a' },
            { id: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 1.5, default: 0.7 },
          ],
        },
      ],
    })
    expect(settings).toEqual([
      { key: 'response_generator.model', type: 'enum', label: 'Model', default: 'a', options: [{ value: 'a' }, { value: 'b' }] },
      { key: 'response_generator.temperature', type: 'number', label: 'Temperature', default: 0.7, min: 0, max: 1.5 },
    ])
  })

  it('accepts a settings section next to the slots, and the mapper stores both in pipelineSchema', () => {
    const result = parseAgentManifest({
      ...base,
      settings: [{ key: 'expert_pool.expert_context', type: 'text', label: 'Context', default: '', maxLength: 1000 }],
    })
    expect(result.errors).toEqual([])
    const column = manifestToAgentTypeData(result.manifest!, null).pipelineSchema as Record<string, unknown>
    expect(configSettingsOf(column).map((s) => s.key)).toEqual(['expert_pool.ask_threshold', 'expert_pool.expert_context'])
  })

  it('refuses a setting declared twice, or for a stage that is not a pipeline node', () => {
    expect(errorsOf({ ...base, settings: [{ key: 'expert_pool.ask_threshold', type: 'number' }] })).toContain(
      'expert_pool.ask_threshold is declared more than once',
    )
    expect(errorsOf({ ...base, settings: [{ key: 'nowhere.x', type: 'text' }] })).toContain('"nowhere" is not a pipelineSchema node')
  })

  it('refuses a declaration that does not hold together', () => {
    expect(errorsOf({ ...base, settings: [{ key: 'expert_pool.mode', type: 'enum' }] })).toContain('enum settings must list options')
    expect(errorsOf({ ...base, settings: [{ key: 'expert_pool.x', type: 'text', min: 1 }] })).toContain('only number and integer')
    expect(errorsOf({ ...base, settings: [{ key: 'expert_pool.x', type: 'number', max: 1, default: 2 }] })).toContain(
      'default must be at most 1',
    )
    expect(errorsOf({ ...base, settings: [{ key: 'ExpertPool.x', type: 'number' }] })).toContain('must be <stage>.<name>')
  })

  it.each(
    fs
      .readdirSync(path.join(process.cwd(), 'agents'))
      .filter((slug) => fs.existsSync(path.join(process.cwd(), 'agents', slug, 'agent.yaml'))),
  )('%s: declares each setting once, and every default fits its declaration', (slug) => {
    const parsed = parseAgentManifestYaml(fs.readFileSync(path.join(process.cwd(), 'agents', slug, 'agent.yaml'), 'utf-8'))
    expect(parsed.errors).toEqual([])
    const column = manifestToAgentTypeData(parsed.manifest!, null).pipelineSchema as Record<string, unknown> | null
    for (const setting of configSettingsOf(column)) {
      expect([setting.key, checkConfigSettingValue(setting, setting.default)]).toEqual([setting.key, null])
    }
  })
})

describe('checkConfigSettingValue', () => {
  const s = (setting: Partial<ConfigSetting>): ConfigSetting => ({ key: 'n.x', type: 'text', ...setting })

  it('treats null and undefined as unset', () => {
    expect(checkConfigSettingValue(s({ type: 'number', min: 0 }), null)).toBeNull()
    expect(checkConfigSettingValue(s({ type: 'number', min: 0 }), undefined)).toBeNull()
  })

  it('checks numbers by type and range, like env vars', () => {
    expect(checkConfigSettingValue(s({ type: 'number', min: 0, max: 1 }), 0.6)).toBeNull()
    expect(checkConfigSettingValue(s({ type: 'number', min: 0, max: 1 }), 2)).toBe('must be between 0 and 1')
    expect(checkConfigSettingValue(s({ type: 'number' }), '0.6')).toBe('must be a number')
    expect(checkConfigSettingValue(s({ type: 'integer' }), 1.5)).toBe('must be a whole number')
  })

  it('checks text, choices, booleans and lists', () => {
    expect(checkConfigSettingValue(s({ type: 'text', maxLength: 3 }), 'abcd')).toBe('must be at most 3 characters')
    expect(checkConfigSettingValue(s({ type: 'enum', options: [{ value: 'a' }] }), 'b')).toBe('must be one of: a')
    expect(checkConfigSettingValue(s({ type: 'boolean' }), 'true')).toBe('must be true or false')
    expect(checkConfigSettingValue(s({ type: 'string_list' }), ['a', 1])).toBe('must be a list of texts')
    expect(checkConfigSettingValue(s({ type: 'key_value' }), { a: 'b' })).toBeNull()
    expect(checkConfigSettingValue(s({ type: 'expert_list' }), [])).toBe('must be an object')
  })
})
