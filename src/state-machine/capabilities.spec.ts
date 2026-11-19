import { CAPABILITY_DESCRIPTION_MAX, sessionCapabilities, type CapabilityInput } from './capabilities.js'

const weather = {
  handle: 'weather',
  name: 'Weather',
  tools: [{ name: 'forecast', description: 'Forecast for a place\nand a day' }],
}

function input(over: Partial<CapabilityInput>): CapabilityInput {
  return {
    deploymentMode: 'plan',
    plan: null,
    activities: [],
    connectors: [],
    connectorToolModes: [],
    ...over,
  }
}

const morningPlan = { title: 'Morning check-in', currentStateTitle: 'Sleep', openItems: ['How did you sleep?'] }

describe('sessionCapabilities', () => {
  describe('plan mode', () => {
    it('follows the plan and nothing else', () => {
      const result = sessionCapabilities(input({ plan: morningPlan, activities: [{ id: 'a', title: 'Quiz' }] }))
      expect(result.mode).toBe('plan')
      expect(result.capabilities).toEqual([
        {
          id: 'follow_plan',
          kind: 'plan',
          title: 'Morning check-in',
          description: 'Now: Sleep. Still open: How did you sleep?.',
        },
      ])
    })

    it('has nothing to offer without a plan', () => {
      expect(sessionCapabilities(input({})).capabilities).toEqual([])
    })

    it('lists connector tools only when the agent type calls them in plan mode', () => {
      const without = sessionCapabilities(input({ plan: morningPlan, connectors: [weather] }))
      expect(without.capabilities.map((c) => c.id)).toEqual(['follow_plan'])

      const companionOnly = sessionCapabilities(
        input({ plan: morningPlan, connectors: [weather], connectorToolModes: ['companion'] }),
      )
      expect(companionOnly.capabilities.map((c) => c.id)).toEqual(['follow_plan'])

      const declared = sessionCapabilities(
        input({ plan: morningPlan, connectors: [weather], connectorToolModes: ['plan'] }),
      )
      expect(declared.capabilities.map((c) => c.id)).toEqual(['follow_plan', 'weather.forecast'])
    })

    it('names at most three open items', () => {
      const plan = { title: 'P', openItems: ['one', 'two', 'three', 'four'] }
      const [follow] = sessionCapabilities(input({ plan })).capabilities
      expect(follow.description).toBe('Still open: one; two; three.')
    })
  })

  describe('inside an activity', () => {
    it('follows the activity and can leave it, nothing else', () => {
      const result = sessionCapabilities(
        input({
          deploymentMode: 'companion',
          plan: { title: 'Memory quiz', openItems: [] },
          activities: [{ id: 'quiz', title: 'Memory quiz' }, { id: 'walk', title: 'Walk' }],
          connectors: [weather],
          connectorToolModes: ['plan', 'companion'],
        }),
      )
      expect(result.mode).toBe('activity')
      expect(result.capabilities).toEqual([
        { id: 'follow_plan', kind: 'plan', title: 'Memory quiz', description: '' },
        {
          id: 'leave_activity',
          kind: 'action',
          title: 'Leave the activity',
          description: 'Stop "Memory quiz" and go back to the open conversation.',
        },
      ])
    })
  })

  describe('companion mode', () => {
    const activities = [
      { id: 'quiz', title: 'Memory quiz', description: 'Ten short questions' },
      { id: 'walk', title: 'Walk' },
    ]

    it('offers the activities and going to sleep', () => {
      const result = sessionCapabilities(input({ deploymentMode: 'companion', activities }))
      expect(result.mode).toBe('companion')
      expect(result.capabilities).toEqual([
        { id: 'activity.quiz', kind: 'activity', title: 'Memory quiz', description: 'Ten short questions' },
        { id: 'activity.walk', kind: 'activity', title: 'Walk', description: '' },
        {
          id: 'go_to_sleep',
          kind: 'action',
          title: 'Go to sleep',
          description: 'Say goodbye and go to sleep until woken again.',
        },
      ])
    })

    it('has no weather tool unless a bound connector has one and the agent calls tools here', () => {
      const ids = (over: Partial<CapabilityInput>) =>
        sessionCapabilities(input({ deploymentMode: 'companion', ...over })).capabilities.map((c) => c.id)

      expect(ids({})).toEqual(['go_to_sleep'])
      expect(ids({ connectors: [weather] })).toEqual(['go_to_sleep'])
      expect(ids({ connectors: [weather], connectorToolModes: ['plan'] })).toEqual(['go_to_sleep'])
      expect(ids({ connectors: [weather], connectorToolModes: ['companion'] })).toEqual([
        'go_to_sleep',
        'weather.forecast',
      ])
    })

    it('keeps outside text to one short line', () => {
      const long = { handle: 'x', name: 'X', tools: [{ name: 't', description: 'a'.repeat(1000) }] }
      const result = sessionCapabilities(
        input({ deploymentMode: 'companion', connectors: [weather, long], connectorToolModes: ['companion'] }),
      )
      const [, forecast, t] = result.capabilities
      expect(forecast.description).toBe('Forecast for a place and a day')
      expect(forecast.title).toBe('Weather: forecast')
      expect(t.description.length).toBe(CAPABILITY_DESCRIPTION_MAX)
      expect(t.description.endsWith('…')).toBe(true)
    })
  })
})
