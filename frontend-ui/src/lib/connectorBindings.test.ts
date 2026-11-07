import { describe, expect, it } from 'vitest'
import type { AvailableConnector, ConnectorSlot } from './api-types'
import { assignSlots, bindingsFromChoices, initialSelection, missingTools, unboundRequiredSlots } from './connectorBindings'

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
    icon: null,
    description: null,
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

  it('preselects the only covering connector and leaves the rest to the user', () => {
    expect(initialSelection([slot, optional], [partial, full])).toEqual(['elias'])
    expect(initialSelection([slot], [full, connector('elias2', ['get_interview_guide', 'start_interview'])])).toEqual([])
    expect(initialSelection([slot], [untested])).toEqual([])
  })

  it('fills each slot from the ticked connectors: covering first, in ticking order, then untested', () => {
    const second = connector('elias2', ['get_interview_guide', 'start_interview'])
    expect(assignSlots([slot], [full, second, partial], ['half', 'elias2', 'elias'])).toEqual({ elias: 'elias2' })
    expect(assignSlots([slot], [partial, untested], ['half', 'new'])).toEqual({ elias: 'new' })
    expect(assignSlots([slot], [partial], ['half'])).toEqual({ elias: '' })
    expect(assignSlots([slot], [full], [])).toEqual({ elias: '' })
  })

  it('never puts one connector in two slots', () => {
    const twin: typeof slot = { ...slot, slot: 'twin', label: 'Twin' }
    expect(assignSlots([slot, twin], [full], ['elias'])).toEqual({ elias: 'elias', twin: '' })
  })

  it('moves a connector that fits two slots to the one nothing else fits', () => {
    // X covers both slots, Y only the first. Ticked X then Y: Y takes the first
    // slot and X the second, so both are filled.
    const first: ConnectorSlot = { ...slot, slot: 'first', requiredTools: ['a'] }
    const second: ConnectorSlot = { ...slot, slot: 'second', requiredTools: ['b'] }
    const x = { ...full, id: 'x', tools: [{ name: 'a' }, { name: 'b' }] }
    const y = { ...full, id: 'y', tools: [{ name: 'a' }] }
    expect(assignSlots([first, second], [x, y], ['x', 'y'])).toEqual({ first: 'y', second: 'x' })
  })

  it('is complete once every required slot is bound', () => {
    expect(unboundRequiredSlots([slot, optional], { elias: '', notes: '' }).map((s) => s.slot)).toEqual(['elias'])
    expect(unboundRequiredSlots([slot, optional], { elias: 'x', notes: '' })).toEqual([])
    expect(bindingsFromChoices([slot, optional], { elias: 'x', notes: '' })).toEqual([{ connectorId: 'x', slot: 'elias' }])
  })

  it('sends the ticked connectors no slot uses without a slot', () => {
    expect(bindingsFromChoices([slot], { elias: 'elias' }, ['new', 'elias'])).toEqual([
      { connectorId: 'elias', slot: 'elias' },
      { connectorId: 'new' },
    ])
    expect(bindingsFromChoices([], {}, ['new'])).toEqual([{ connectorId: 'new' }])
  })
})
