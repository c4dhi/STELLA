import { CURRENT_SDK_VERSION } from '../agent-package/manifest-defaults.js'
import { parseAgentManifest } from '../agent-package/schemas/agent-manifest.schema.js'
import { resolveAgentRequirements } from './agent-requirements.js'
import { assertDeployRequest, withAgentDefaults, withEnvDefaults } from './deploy-request.js'

// Whatever the manifest declares, a deployment must carry; whatever it does
// not declare, a deployment may not bring.

const base = {
  version: '2.0',
  metadata: { name: 'A', slug: 'a-agent', version: '1.0.0', description: 'a' },
  image: { dockerfile: 'Dockerfile' },
}
const pipelineSchema = { nodes: [], edges: [], thresholds: [] }
const requirements = (extra: Record<string, unknown> = {}) => {
  const result = parseAgentManifest({ ...base, ...extra })
  if (!result.manifest) throw new Error(result.errors.join('\n'))
  return resolveAgentRequirements(result.manifest)
}
const check = (r: ReturnType<typeof requirements>, config: Record<string, unknown> = {}, env: Record<string, string> = {}) =>
  () => assertDeployRequest('a-agent', r, config, env)

describe('assertDeployRequest', () => {
  it('lets an agent that declares nothing deploy with nothing', () => {
    expect(check(requirements())).not.toThrow()
  })

  describe('plans', () => {
    const plain = requirements()
    const planned = requirements({ capabilities: ['plans'], features: { plans: { required: true } } })
    const companion = requirements({
      capabilities: ['plans', 'companion'],
      features: { plans: { required: true, modes: ['plan', 'companion'] } },
    })

    it('refuses a plan, a companion session or activities for an agent without plans', () => {
      expect(check(plain, { plan: {} })).toThrow('it does not run plans')
      expect(check(plain, { mode: 'companion' })).toThrow('it does not run plans')
      expect(check(plain, { available_plans: [] })).toThrow('it does not run plans')
    })

    it('needs a plan when plans are required', () => {
      expect(check(planned)).toThrow('Cannot deploy a-agent: it needs a plan')
      expect(check(planned, { plan: { id: 'p' } })).not.toThrow()
    })

    it('accepts a companion session instead of a plan only when the agent declares that mode', () => {
      expect(check(planned, { mode: 'companion', available_plans: [] })).toThrow('it cannot run as a companion')
      expect(check(companion)).toThrow('it needs a plan, or to run as a companion')
      expect(check(companion, { mode: 'companion', available_plans: [] })).not.toThrow()
    })

    it('refuses a single plan for an agent that only runs as a companion', () => {
      const only = requirements({
        capabilities: ['plans', 'companion'],
        features: { plans: { modes: ['companion'] } },
      })
      expect(check(only, { plan: {} })).toThrow('it does not follow a single plan')
    })
  })

  describe('configurator', () => {
    it('refuses a configuration for an agent without the configurator', () => {
      expect(check(requirements(), { pipeline_config: {} })).toThrow('it takes no Configurator configuration')
    })

    it('needs a configuration only when it is required', () => {
      const optional = requirements({ pipelineSchema, features: { configurator: true } })
      const required = requirements({ pipelineSchema, features: { configurator: { required: true } } })
      expect(check(optional)).not.toThrow()
      expect(check(required)).toThrow('it needs a configuration from the Configurator')
      expect(check(required, { pipeline_config: [] })).toThrow('it needs a configuration from the Configurator')
      expect(check(required, { pipeline_config: { nodes: {} } })).not.toThrow()
    })
  })

  it('names every missing required env var; an empty value is missing', () => {
    const r = requirements({ env: { required: ['A_KEY', 'B_KEY', 'C_KEY'] } })
    expect(check(r, {}, { A_KEY: 'x', B_KEY: '  ' })).toThrow('missing required environment variables: B_KEY, C_KEY')
    expect(check(r, {}, { A_KEY: 'x', B_KEY: 'y', C_KEY: 'z' })).not.toThrow()
  })

  it('refuses an agent that needs a newer SDK than this STELLA runs', () => {
    expect(check(requirements({ sdk: { minVersion: '99.0.0' } }))).toThrow(
      `it needs stella-ai-agent-sdk 99.0.0, newer than this STELLA supports (${CURRENT_SDK_VERSION})`,
    )
    expect(check(requirements({ sdk: { minVersion: CURRENT_SDK_VERSION } }))).not.toThrow()
  })

  it('reports every problem at once', () => {
    const r = requirements({ env: { required: ['A_KEY'] } })
    expect(check(r, { plan: {}, pipeline_config: {} })).toThrow(
      'Cannot deploy a-agent: it does not run plans, so a deployment cannot give it one; it takes no Configurator configuration; missing required environment variables: A_KEY',
    )
  })
})

describe('withAgentDefaults', () => {
  const r = requirements({ defaultConfig: { elias: { tags: ['a', 'b'] }, llm: { model: 'm', temperature: 0.7 } } })

  it('gives the agent its defaultConfig plus the platform keys', () => {
    const plan = { id: 'p', states: [] }
    const config = withAgentDefaults('a-agent', r, { plan, persona: { name: 'Grace' } })
    expect(config).toEqual({ elias: { tags: ['a', 'b'] }, llm: { model: 'm', temperature: 0.7 }, plan, persona: { name: 'Grace' } })
  })

  it('refuses any setting a deployment tries to give the agent', () => {
    expect(() => withAgentDefaults('a-agent', r, { elias: { project_id: 'p1' } })).toThrow(
      'Cannot deploy a-agent: a deployment sets no agent settings (elias); pass them as env vars',
    )
    expect(() => withAgentDefaults('a-agent', r, { llm: { temperature: 0.2 } })).toThrow('(llm)')
    expect(() => withAgentDefaults('a-agent', requirements(), { anything: 1 })).toThrow('(anything)')
  })

  it('accepts a saved config again, so a restart or wake can pass it', () => {
    const once = withAgentDefaults('a-agent', r, { mode: 'plan' })
    expect(withAgentDefaults('a-agent', r, once)).toEqual(once)
  })
})

describe('withEnvDefaults', () => {
  const env = {
    required: ['OPENAI_API_KEY'],
    optional: [
      { name: 'TTS_ENABLED', default: 'true' },
      { name: 'TRANSCRIPT_DEBOUNCE_MS', default: '300' },
      { name: 'STELLA_LANGUAGE' },
    ],
  }

  it('fills in declared defaults the deployment left out or left empty; a provided value wins', () => {
    const { env: out, appliedDefaults } = withEnvDefaults(env, { OPENAI_API_KEY: 'k', TTS_ENABLED: 'false', TRANSCRIPT_DEBOUNCE_MS: ' ' })
    expect(out).toEqual({ OPENAI_API_KEY: 'k', TTS_ENABLED: 'false', TRANSCRIPT_DEBOUNCE_MS: '300' })
    expect(appliedDefaults).toEqual(['TRANSCRIPT_DEBOUNCE_MS'])
  })

  it('gives the same env when run again, so restart and wake can pass it', () => {
    const once = withEnvDefaults(env, { OPENAI_API_KEY: 'k' }).env
    expect(withEnvDefaults(env, once).env).toEqual(once)
  })
})
