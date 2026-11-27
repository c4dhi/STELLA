import { describe, expect, it } from 'vitest'
import { publicSetupSteps } from './publicSetupSteps'
import type { DeployNeeds } from './deployNeeds'

const needs = (modes: DeployNeeds['modes']): DeployNeeds => ({
  persona: true, modes, planRequired: true, configurator: false, requiredEnvVars: [], optionalEnvVars: [],
})
const shown = { configurator: false, voice: false }

describe('the public project setup offers every mode the agent declares (#207)', () => {
  it('asks for the mode when the agent can run as a companion too', () => {
    expect(publicSetupSteps(needs(['plan', 'companion']), 'plan', shown)).toEqual(
      ['agent', 'configure', 'mode', 'persona', 'plan', 'connectors'],
    )
  })

  it('picks activities instead of one plan in companion mode', () => {
    expect(publicSetupSteps(needs(['plan', 'companion']), 'companion', shown)).toEqual(
      ['agent', 'configure', 'mode', 'persona', 'activities', 'connectors'],
    )
  })

  it('does not ask an agent that only follows plans', () => {
    expect(publicSetupSteps(needs(['plan']), 'plan', shown)).toEqual(
      ['agent', 'configure', 'persona', 'plan', 'connectors'],
    )
  })

  it('shows no plan step for an agent that runs no plans', () => {
    expect(publicSetupSteps(needs([]), 'plan', { configurator: false, voice: true })).toEqual(
      ['agent', 'configure', 'persona', 'connectors', 'voice'],
    )
  })
})
