/**
 * The deploy wizard's "Connectors" step: one list of the user's connectors to
 * tick. Each slot the agent declares (requirements.connectors) is filled from
 * the ticked ones, and the bindings are sent as `connectorBindings`. The server
 * checks the bindings again on deploy; this only decides what is bound and
 * when the step is complete.
 */
import type { AvailableConnector, ConnectorSlot } from './api-types'

/** Chosen connector id by slot. '' = none chosen. */
export type SlotChoices = Record<string, string>

/**
 * Tools the slot needs that the connector does not list. Null when the
 * connector has never been tested, so its tools are unknown.
 */
export function missingTools(slot: ConnectorSlot, connector: AvailableConnector): string[] | null {
  if (!connector.tools) return null
  const offered = new Set(connector.tools.map((t) => t.name))
  return slot.requiredTools.filter((tool) => !offered.has(tool))
}

function covers(slot: ConnectorSlot, c: AvailableConnector): boolean {
  return c.kind === slot.kind && missingTools(slot, c)?.length === 0
}

/** Preselect, for each slot, the one connector known to cover its tools, if exactly one does. */
export function initialSelection(slots: ConnectorSlot[], available: AvailableConnector[]): string[] {
  const picked: string[] = []
  for (const slot of slots) {
    const covering = available.filter((c) => covers(slot, c))
    if (covering.length === 1 && !picked.includes(covering[0].id)) picked.push(covering[0].id)
  }
  return picked
}

/**
 * Which ticked connector fills each slot. A slot takes the first ticked
 * connector, in the order they were ticked, that covers its tools and fills no
 * other slot; failing that, one whose tools are unknown (never tested). A slot
 * nothing fits stays ''.
 */
export function assignSlots(slots: ConnectorSlot[], available: AvailableConnector[], selected: string[]): SlotChoices {
  const byId = new Map(available.map((c) => [c.id, c]))
  const ticked = selected.map((id) => byId.get(id)).filter((c): c is AvailableConnector => !!c)
  const used = new Set<string>()
  const choices: SlotChoices = {}
  for (const slot of slots) {
    const free = ticked.filter((c) => !used.has(c.id) && c.kind === slot.kind)
    const pick = free.find((c) => covers(slot, c)) ?? free.find((c) => missingTools(slot, c) === null)
    choices[slot.slot] = pick?.id ?? ''
    if (pick) used.add(pick.id)
  }
  return choices
}

/** Required slots still without a connector. */
export function unboundRequiredSlots(slots: ConnectorSlot[], choices: SlotChoices): ConnectorSlot[] {
  return slots.filter((slot) => slot.required && !choices[slot.slot])
}

/** What the deploy request sends: the bound slots, then every other ticked connector without a slot. */
export function bindingsFromChoices(
  slots: ConnectorSlot[],
  choices: SlotChoices,
  selected: string[] = [],
): { connectorId: string; slot?: string }[] {
  const chosen = new Set<string>()
  const bindings: { connectorId: string; slot?: string }[] = []
  for (const slot of slots) {
    const id = choices[slot.slot]
    if (!id) continue
    chosen.add(id)
    bindings.push({ connectorId: id, slot: slot.slot })
  }
  for (const id of selected) {
    if (chosen.has(id)) continue
    chosen.add(id)
    bindings.push({ connectorId: id })
  }
  return bindings
}
