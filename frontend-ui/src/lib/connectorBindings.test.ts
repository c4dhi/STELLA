import { describe, expect, it } from 'vitest'
import type { AvailableConnector, ConnectorSlot } from './api-types'
import { bindingsFromChoices, connectorsForSlot, extraCandidates, initialSlotChoices, missingTools, unboundRequiredSlots } from './connectorBindings'

const slot: ConnectorSlot = {
  slot: 'elias',
  kind: 'mcp',
  required: true,
  label: 'ELIAS',
  requiredTools: ['get_interview_guide', 'start_interview'],
}
const optional: ConnectorSlot = { slot: 'notes', kind: 'mcp', required: false, label: 'Notes', requiredTools: [] }

function connector(id: string, tools: string[] | null): AvailableConnector {
  return {
    id,
    name: id,
    handle: id,
    kind: 'mcp',
    url: `https://${id}.test/mcp`,
    status: tools ? 'ok' : 'untested',
    tools: tools?.map((name) => ({ name })) ?? null,
    owned: true,
    ownerName: null,
  }
}

const full = connector('elias', ['get_interview_guide', 'start_interview', 'end_interview'])
const partial = connector('half', ['get_interview_guide'])
const untested = connector('new', null)

describe('connector picker', () => {
  it('names the tools a connector lacks, and does not guess for an untested one', () => {
    expect(missingTools(slot, full)).toEqual([])
    expect(missingTools(slot, partial)).toEqual(['start_interview'])
    expect(missingTools(slot, untested)).toBeNull()
  })

  it('offers covering connectors first', () => {
    expect(connectorsForSlot(slot, [partial, untested, full]).map((c) => c.id)).toEqual(['elias', 'new', 'half'])
  })

  it('preselects the only covering connector and leaves the rest to the user', () => {
    expect(initialSlotChoices([slot, optional], [partial, full])).toEqual({ elias: 'elias', notes: '' })
    expect(initialSlotChoices([slot], [full, connector('elias2', ['get_interview_guide', 'start_interview'])])).toEqual({ elias: '' })
    expect(initialSlotChoices([slot], [untested])).toEqual({ elias: '' })
  })

  it('is complete once every required slot is bound', () => {
    expect(unboundRequiredSlots([slot, optional], { elias: '', notes: '' }).map((s) => s.slot)).toEqual(['elias'])
    expect(unboundRequiredSlots([slot, optional], { elias: 'x', notes: '' })).toEqual([])
    expect(bindingsFromChoices([slot, optional], { elias: 'x', notes: '' })).toEqual([{ connectorId: 'x', slot: 'elias' }])
  })

  it('offers the connectors no slot uses as extras and sends them without a slot', () => {
    expect(extraCandidates([full, partial, untested], { elias: 'elias' }).map((c) => c.id)).toEqual(['half', 'new'])
    expect(bindingsFromChoices([slot], { elias: 'elias' }, ['new', 'elias'])).toEqual([
      { connectorId: 'elias', slot: 'elias' },
      { connectorId: 'new' },
    ])
    expect(bindingsFromChoices([], {}, ['new'])).toEqual([{ connectorId: 'new' }])
  })
})
