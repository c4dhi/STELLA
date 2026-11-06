import { Link } from 'react-router-dom'
import { useThemeStore } from '../../store/themeStore'
import type { AvailableConnector, ConnectorSlot } from '../../lib/api-types'
import { missingTools, type SlotChoices } from '../../lib/connectorBindings'
import { WIZARD_CARD_GRID } from './wizardLayout'
import { choiceCardClass } from './wizardChoice'
import { IconTile, toolCountLabel } from '../settings/connectors/connectorUi'

interface ConnectorsStepProps {
  slots: ConnectorSlot[]
  available: AvailableConnector[]
  loading: boolean
  loadError: string | null
  /** Ticked connector ids, in the order they were ticked. */
  selected: string[]
  onToggle: (connectorId: string, on: boolean) => void
  /** Which ticked connector fills each slot (assignSlots). */
  choices: SlotChoices
}

/**
 * One list of the connectors the user may bind here (their own and those
 * shared with the project), to tick. The slots the agent declares are filled
 * from the ticked ones; the line above the list says what the agent needs.
 */
export default function ConnectorsStep({ slots, available, loading, loadError, selected, onToggle, choices }: ConnectorsStepProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const muted = `text-sm font-light ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`
  const faint = isDark ? 'text-zinc-500' : 'text-neutral-500'

  if (loading) return <div className={muted}>Loading your connectors…</div>
  if (loadError) return <div className="text-sm text-rose-500">Could not load your connectors: {loadError}</div>

  const slotOf = new Map(Object.entries(choices).filter(([, id]) => id).map(([slot, id]) => [id, slot]))
  const slotLabel = (slot: string) => slots.find((s) => s.slot === slot)?.label ?? slot

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className={muted}>
          {slots.length === 0
            ? 'Optional. Choose the connectors this agent may use, if its code looks for them.'
            : 'Choose the connectors this agent may use.'}
        </p>
        {slots.map((slot) => {
          const filled = !!choices[slot.slot]
          return (
            <p
              key={slot.slot}
              className={`text-xs ${filled ? faint : slot.required ? 'text-rose-500' : faint}`}
            >
              {slot.label}
              {slot.required ? '' : ' (optional)'}
              {slot.requiredTools.length > 0 && <>: needs {slot.requiredTools.join(', ')}</>}
              {filled ? ` · uses ${available.find((c) => c.id === choices[slot.slot])?.name ?? 'the one you chose'}` : slot.required ? ' · choose one that has these' : ''}
            </p>
          )
        })}
      </div>

      {available.length === 0 ? (
        <p className={muted}>You have no connectors yet.</p>
      ) : (
        <div className={WIZARD_CARD_GRID}>
          {available.map((c) => {
            const on = selected.includes(c.id)
            const fills = slotOf.get(c.id)
            // What the card says about the agent's needs: it fills a slot, could
            // fill one, lacks tools, or is untested.
            const fitting = slots.find((s) => missingTools(s, c)?.length === 0)
            const lacking = slots.length > 0 && !fitting ? missingTools(slots[0], c) : null
            const note = fills
              ? { text: slots.length > 1 ? `Used for ${slotLabel(fills)}` : 'Has what the agent needs', tone: 'ok' as const }
              : !c.tools
                ? { text: 'Not tested yet', tone: 'warn' as const }
                : fitting
                  ? { text: 'Has what the agent needs', tone: 'ok' as const }
                  : lacking && lacking.length > 0
                    ? { text: `Missing ${lacking.join(', ')}`, tone: 'info' as const }
                    : null
            const toneClass = {
              ok: isDark ? 'text-emerald-400' : 'text-emerald-700',
              warn: 'text-amber-500',
              info: faint,
            }
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                onClick={() => onToggle(c.id, !on)}
                className={`relative min-h-[128px] p-3 rounded-xl text-left flex flex-col gap-1.5 transition-all duration-200 ${choiceCardClass(on, isDark)}`}
              >
                <span
                  aria-hidden="true"
                  className={`absolute top-2 right-2 w-4 h-4 rounded flex items-center justify-center ${
                    on ? (isDark ? 'bg-primary-500' : 'bg-neutral-900') : `border ${isDark ? 'border-zinc-600' : 'border-neutral-300'}`
                  }`}
                >
                  {on && (
                    <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <IconTile icon={c.icon} isDark={isDark} size="sm" />
                <span className={`text-sm font-medium pr-5 ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>{c.name}</span>
                {c.description && (
                  <span className={`text-xs font-light leading-relaxed line-clamp-2 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>{c.description}</span>
                )}
                <span className={`mt-auto pt-1 text-[11px] ${faint}`}>
                  {note && <span className={toneClass[note.tone]}>{note.text}</span>}
                  {[c.tools ? toolCountLabel(c.tools) : null, c.owned ? null : `shared by ${c.ownerName ?? 'a project member'}`]
                    .filter(Boolean)
                    .map((part, i) => (note || i > 0 ? ` · ${part}` : part))
                    .join('')}
                </span>
              </button>
            )
          })}
        </div>
      )}

      <Link
        to="/settings/connectors"
        className={`inline-block text-xs ${isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-neutral-500 hover:text-neutral-900'} underline-offset-2 hover:underline`}
      >
        Add or test connectors in Settings → Connectors →
      </Link>
    </div>
  )
}
