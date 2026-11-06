import { describe, expect, it } from 'vitest'
import type { DeployRequirements } from './api-types'
import { asksForMode, deployNeeds, effectiveMode } from './deployNeeds'

const base: DeployRequirements = {
  persona: true,
  plans: null,
  configurator: null,
  env: { required: [], optional: [] },
  connectors: [],
  configSchema: null,
  defaultConfig: {},
  sdkMinVersion: null,
}

describe('deployNeeds', () => {
  it('reads the server requirements', () => {
    const needs = deployNeeds({
      requirements: {
        ...base,
        persona: false,
        plans: { required: true, modes: ['plan'] },
        configurator: { required: false },
        env: { required: ['OPENAI_API_KEY'], optional: [{ name: 'STELLA_LANGUAGE', description: 'Spoken language', default: 'de' }] },
      },
    })
    expect(needs).toEqual({
      persona: false,
      modes: ['plan'],
      planRequired: true,
      configurator: true,
      requiredEnvVars: ['OPENAI_API_KEY'],
      optionalEnvVars: [{ name: 'STELLA_LANGUAGE', description: 'Spoken language', default: 'de' }],
    })
  })

  it('asks for a mode only when the agent has two', () => {
    const one = deployNeeds({ requirements: { ...base, plans: { required: true, modes: ['plan'] } } })
    const two = deployNeeds({ requirements: { ...base, plans: { required: false, modes: ['plan', 'companion'] } } })
    expect(asksForMode(one)).toBe(false)
    expect(asksForMode(two)).toBe(true)
    expect(effectiveMode(one, 'companion')).toBe('plan')
    expect(effectiveMode(two, 'companion')).toBe('companion')
  })

  it('asks for nothing when the server sent no requirements (the server refuses that deploy)', () => {
    expect(deployNeeds({ requirements: null })).toMatchObject({ modes: [], planRequired: false, requiredEnvVars: [] })
  })

  it('needs nothing without a type', () => {
    expect(deployNeeds(null).modes).toEqual([])
  })
})
