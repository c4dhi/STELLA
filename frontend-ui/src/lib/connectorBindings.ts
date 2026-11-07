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
 * Which ticked connector fills each slot, one connector per slot at most.
 * Connectors that cover a slot's tools are matched first, so that as many slots
 * as possible get one that covers them: a connector that fits two slots moves
 * to the one nothing else fits (a maximum matching, trying candidates in the
 * order they were ticked). Slots still empty then take a ticked connector whose
 * tools are unknown (never tested). A slot nothing fits stays ''.
 */
export function assignSlots(slots: ConnectorSlot[], available: AvailableConnector[], selected: string[]): SlotChoices {
  const byId = new Map(available.map((c) => [c.id, c]))
  const ticked = selected.map((id) => byId.get(id)).filter((c): c is AvailableConnector => !!c)
  const covering = slots.map((slot) => ticked.filter((c) => covers(slot, c)))
  const holder = new Map<string, number>()  // connector id → index of the slot it fills

  const place = (slotIndex: number, seen: Set<string>): boolean => {
    for (const c of covering[slotIndex]) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      const other = holder.get(c.id)
      if (other === undefined || place(other, seen)) {
        holder.set(c.id, slotIndex)
        return true
      }
    }
    return false
  }
  slots.forEach((_, i) => place(i, new Set()))

  const choices: SlotChoices = Object.fromEntries(slots.map((slot) => [slot.slot, '']))
  for (const [id, i] of holder) choices[slots[i].slot] = id
  slots.forEach((slot) => {
    if (choices[slot.slot]) return
    const untested = ticked.find((c) => !holder.has(c.id) && c.kind === slot.kind && missingTools(slot, c) === null)
    if (untested) {
      choices[slot.slot] = untested.id
      holder.set(untested.id, -1)
    }
  })
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
