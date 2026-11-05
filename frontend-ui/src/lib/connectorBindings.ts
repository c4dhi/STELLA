/**
 * The deploy wizard's "Connectors" step: which of the user's connectors may fill
 * each slot the agent declares (requirements.connectors), and the bindings sent
 * as `connectorBindings`. The server checks the bindings again on deploy; this
 * only decides what to offer and when the step is complete.
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

/** Connectors of the slot's kind, the ones known to cover its tools first. */
export function connectorsForSlot(slot: ConnectorSlot, available: AvailableConnector[]): AvailableConnector[] {
  const rank = (c: AvailableConnector) => {
    const missing = missingTools(slot, c)
    return missing === null ? 1 : missing.length === 0 ? 0 : 2
  }
  return available.filter((c) => c.kind === slot.kind).sort((a, b) => rank(a) - rank(b))
}

/** Preselect a slot's connector when exactly one is known to cover its tools. */
export function initialSlotChoices(slots: ConnectorSlot[], available: AvailableConnector[]): SlotChoices {
  const choices: SlotChoices = {}
  for (const slot of slots) {
    const covering = connectorsForSlot(slot, available).filter((c) => missingTools(slot, c)?.length === 0)
    choices[slot.slot] = covering.length === 1 ? covering[0].id : ''
  }
  return choices
}

/** Required slots still without a connector. */
export function unboundRequiredSlots(slots: ConnectorSlot[], choices: SlotChoices): ConnectorSlot[] {
  return slots.filter((slot) => slot.required && !choices[slot.slot])
}

/**
 * Connectors the user may offer on top of the declared slots: any not already
 * chosen for a slot. The agent finds them with `connectors.list()`.
 */
export function extraCandidates(available: AvailableConnector[], choices: SlotChoices): AvailableConnector[] {
  const chosen = new Set(Object.values(choices).filter(Boolean))
  return available.filter((c) => !chosen.has(c.id))
}

/** What the deploy request sends: the bound slots, then each extra connector without a slot. */
export function bindingsFromChoices(
  slots: ConnectorSlot[],
  choices: SlotChoices,
  extras: string[] = [],
): { connectorId: string; slot?: string }[] {
  const chosen = new Set<string>()
  const bindings: { connectorId: string; slot?: string }[] = []
  for (const slot of slots) {
    const id = choices[slot.slot]
    if (!id) continue
    chosen.add(id)
    bindings.push({ connectorId: id, slot: slot.slot })
  }
  for (const id of extras) {
    if (chosen.has(id)) continue
    chosen.add(id)
    bindings.push({ connectorId: id })
  }
  return bindings
}
