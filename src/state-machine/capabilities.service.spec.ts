import { jest } from '@jest/globals'
import { CapabilitiesService } from './capabilities.service.js'

/**
 * The service only fetches; these pin what it fetches and hands to
 * sessionCapabilities (capabilities.spec.ts covers the rules themselves).
 */

const plan = {
  id: 'quiz',
  title: 'Memory quiz',
  states: [{ id: 's1', title: 'Warm-up', tasks: [] }],
}

function manifestRow(connectorTools?: { modes: string[] }) {
  return {
    slug: 'agent',
    manifest: {
      version: '2.0',
      metadata: { name: 'A', slug: 'agent', version: '1.0.0', description: 'd' },
      capabilities: ['plans', 'companion'],
      features: { persona: true, plans: { modes: ['plan', 'companion'] }, ...(connectorTools ? { connectorTools } : {}) },
      image: { dockerfile: 'Dockerfile' },
    },
  }
}

function setup({
  state = null as unknown,
  instance = null as unknown,
  pending = [] as Array<{ description: string }>,
  connectors = [] as unknown[],
} = {}) {
  const findFirst = jest.fn().mockResolvedValue(instance)
  const listConnectors = jest.fn().mockResolvedValue(connectors)
  const service = new CapabilitiesService(
    { agentInstance: { findFirst } } as any,
    { getState: jest.fn().mockResolvedValue(state), getPendingTasks: jest.fn().mockResolvedValue(pending) } as any,
    { listConnectors } as any,
  )
  return { service, findFirst, listConnectors }
}

function companion(connectorTools?: { modes: string[] }) {
  return {
    id: 'agent-1',
    sessionId: 'sess',
    deployedByUserId: 'u1',
    connectorBindings: [{ handle: 'weather', connectorId: 'c1' }],
    session: { projectId: 'p1' },
    agentConfig: {
      mode: 'companion',
      available_plans: [{ id: 'quiz', title: 'Memory quiz', description: 'Ten questions', plan }],
    },
    agentTypeRef: manifestRow(connectorTools),
  }
}

const weather = [{ handle: 'weather', name: 'Weather', status: 'ok', tools: [{ name: 'forecast', description: 'Forecast' }] }]

describe('CapabilitiesService', () => {
  it('asks for the named agent in this session, else the newest live one', async () => {
    const { service, findFirst } = setup()
    await service.getCapabilities('sess', 'agent-1')
    expect(findFirst.mock.calls[0][0].where).toEqual({ id: 'agent-1', sessionId: 'sess' })

    await service.getCapabilities('sess')
    expect(findFirst.mock.calls[1][0].where).toEqual({ sessionId: 'sess', status: { in: ['STARTING', 'RUNNING'] } })
  })

  it('plan mode: the plan with what is still open', async () => {
    const { service } = setup({
      state: { planData: plan, currentStateId: 's1' },
      instance: { ...companion(), agentConfig: { plan } },
      pending: [{ description: 'Ask how they slept' }],
    })
    expect(await service.getCapabilities('sess')).toEqual({
      mode: 'plan',
      capabilities: [
        { id: 'follow_plan', kind: 'plan', title: 'Memory quiz', description: 'Now: Warm-up. Still open: Ask how they slept.' },
      ],
    })
  })

  it('companion: the snapshotted activities, no connector lookup unless the type calls tools', async () => {
    const { service, listConnectors } = setup({ instance: companion() })
    const result = await service.getCapabilities('sess')
    expect(result.mode).toBe('companion')
    expect(result.capabilities.map((c) => c.id)).toEqual(['activity.quiz', 'go_to_sleep'])
    expect(listConnectors).not.toHaveBeenCalled()
  })

  it('companion with connectorTools: lists the bound connectors the agent may still use', async () => {
    const { service, listConnectors } = setup({ instance: companion({ modes: ['companion'] }), connectors: weather })
    const result = await service.getCapabilities('sess')
    expect(result.capabilities.map((c) => c.id)).toEqual(['activity.quiz', 'go_to_sleep', 'weather.forecast'])
    expect(listConnectors).toHaveBeenCalledWith({
      agentId: 'agent-1',
      sessionId: 'sess',
      projectId: 'p1',
      deployedByUserId: 'u1',
      bindings: [{ handle: 'weather', connectorId: 'c1' }],
    })
  })

  it('a connector that is not working adds no tools', async () => {
    const broken = [{ handle: 'mail', name: 'Mail', status: 'error', tools: [{ name: 'send', description: 'Send' }] }]
    const { service } = setup({ instance: companion({ modes: ['companion'] }), connectors: [...weather, ...broken] })
    const result = await service.getCapabilities('sess')
    expect(result.capabilities.map((c) => c.id)).toEqual(['activity.quiz', 'go_to_sleep', 'weather.forecast'])
  })

  it('inside an activity: no connector lookup, even when declared for companion', async () => {
    const { service, listConnectors } = setup({
      state: { planData: plan, currentStateId: 's1' },
      instance: companion({ modes: ['companion'] }),
      connectors: weather,
    })
    const result = await service.getCapabilities('sess')
    expect(result.mode).toBe('activity')
    expect(result.capabilities.map((c) => c.id)).toEqual(['follow_plan', 'leave_activity'])
    expect(listConnectors).not.toHaveBeenCalled()
  })

  it('no agent: plan mode from the plan alone', async () => {
    const { service } = setup({ state: { planData: plan, currentStateId: 's1' } })
    const result = await service.getCapabilities('sess')
    expect(result).toEqual({
      mode: 'plan',
      capabilities: [{ id: 'follow_plan', kind: 'plan', title: 'Memory quiz', description: 'Now: Warm-up.' }],
    })
  })
})
