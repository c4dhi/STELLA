import { useThemeStore } from '../../store/themeStore'
import type { AvailableConnector, ConnectorSlot } from '../../lib/api-types'
import { connectorsForSlot, extraCandidates, missingTools, type SlotChoices } from '../../lib/connectorBindings'

interface ConnectorsStepProps {
  slots: ConnectorSlot[]
  available: AvailableConnector[]
  loading: boolean
  loadError: string | null
  choices: SlotChoices
  onChoose: (slot: string, connectorId: string) => void
  /** Extra connectors offered on top of the slots, by id. */
  extras: string[]
  onToggleExtra: (connectorId: string, on: boolean) => void
}

/**
 * One picker per connector slot the agent declares in agent.yaml. Offers the
 * user's own connectors and those shared with this project, and says which
 * tools a connector is missing for the slot. Below, any other connector can be
 * offered too; the agent finds those with `connectors.list()`.
 */
export default function ConnectorsStep({ slots, available, loading, loadError, choices, onChoose, extras, onToggleExtra }: ConnectorsStepProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const selectClass = `
    w-full px-4 py-2.5 rounded-xl text-sm font-light appearance-none cursor-pointer border transition-colors
    focus:outline-none focus:ring-2 focus:ring-primary-500/40
    ${isDark ? 'bg-zinc-900 border-zinc-700 text-zinc-100' : 'bg-white border-neutral-300 text-neutral-900'}
  `
  const labelClass = `block text-sm font-medium mb-1.5 ${isDark ? 'text-zinc-200' : 'text-neutral-800'}`
  const hintClass = `text-xs font-light mt-1.5 ${isDark ? 'text-zinc-500' : 'text-neutral-500'}`
  const muted = `text-sm font-light ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`

  if (loading) return <div className={muted}>Loading your connectors…</div>
  if (loadError) return <div className="text-sm text-rose-500">Could not load your connectors: {loadError}</div>

  const others = extraCandidates(available, choices)

  return (
    <div className="space-y-5">
      {slots.map((slot) => {
        const options = connectorsForSlot(slot, available)
        const chosen = options.find((c) => c.id === choices[slot.slot])
        const missing = chosen ? missingTools(slot, chosen) : null
        const id = `connector-${slot.slot}`
        return (
          <div key={slot.slot}>
            <label htmlFor={id} className={labelClass}>
              {slot.label}
              {slot.required && <span className="text-rose-500"> *</span>}
            </label>
            {options.length === 0 ? (
              <p className={muted}>
                You have no connector for this yet. Add one under Settings → Connectors, test it, then come back.
              </p>
            ) : (
              <select id={id} value={choices[slot.slot] ?? ''} onChange={(e) => onChoose(slot.slot, e.target.value)} className={selectClass}>
                <option value="">{slot.required ? 'Choose a connector…' : 'None'}</option>
                {options.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.owned ? '' : ` (shared by ${c.ownerName ?? 'a project member'})`}
                  </option>
                ))}
              </select>
            )}
            {slot.description && <p className={hintClass}>{slot.description}</p>}
            {chosen && missing === null && (
              <p className="text-xs mt-1.5 text-amber-500">This connector has not been tested yet, so its tools are unknown.</p>
            )}
            {chosen && missing && missing.length > 0 && (
              <p className="text-xs mt-1.5 text-rose-500">Missing tools: {missing.join(', ')}</p>
            )}
          </div>
        )
      })}
      {others.length > 0 && (
        <div>
          <p className={labelClass}>{slots.length > 0 ? 'Other connectors' : 'Connectors'}</p>
          <p className={`${hintClass} mt-0 mb-2`}>
            {slots.length > 0
              ? 'Optional. The agent can also use these, if its code looks for them.'
              : 'Optional. This agent asks for no connector, but it can use one you offer, if its code looks for it.'}
          </p>
          <div className="space-y-2">
            {others.map((c) => {
              const id = `connector-extra-${c.id}`
              return (
                <label key={c.id} htmlFor={id} className="flex items-start gap-3 cursor-pointer">
                  <input
                    id={id}
                    type="checkbox"
                    checked={extras.includes(c.id)}
                    onChange={(e) => onToggleExtra(c.id, e.target.checked)}
                    className="mt-1 h-4 w-4 rounded accent-primary-500"
                  />
                  <span className={muted}>
                    {c.name} <span className="opacity-70">({c.handle})</span>
                    {c.owned ? '' : ` · shared by ${c.ownerName ?? 'a project member'}`}
                    {c.tools ? ` · ${c.tools.length} tools` : ' · not tested yet'}
                  </span>
                </label>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
