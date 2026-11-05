import { useThemeStore } from '../../store/themeStore'
import type { AvailableConnector, ConnectorSlot } from '../../lib/api-types'
import { connectorsForSlot, missingTools, type SlotChoices } from '../../lib/connectorBindings'

interface ConnectorsStepProps {
  slots: ConnectorSlot[]
  available: AvailableConnector[]
  loading: boolean
  loadError: string | null
  choices: SlotChoices
  onChoose: (slot: string, connectorId: string) => void
}

/**
 * One picker per connector slot the agent declares in agent.yaml. Offers the
 * user's own connectors and those shared with this project, and says which
 * tools a connector is missing for the slot.
 */
export default function ConnectorsStep({ slots, available, loading, loadError, choices, onChoose }: ConnectorsStepProps) {
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
    </div>
  )
}
