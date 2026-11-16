/**
 * The project setting for what happens to a session once everyone has left
 * (#162): keep it open, so the participant's invitation keeps working and the
 * agent can be restarted, or close it, which revokes the invitations.
 */
import { DoorOpen, Lock } from 'lucide-react'
import { choiceCardClass, SelectedBadge } from './wizardChoice'

const OPTIONS = [
  { closes: false, label: 'Keep the session open', text: 'Invitations keep working. If the agent stops, you can restart it.', Icon: DoorOpen },
  { closes: true, label: 'Close the session', text: 'Invitations stop working once everyone has left.', Icon: Lock },
] as const

export default function CloseWhenEmptySetting({
  closes,
  onChange,
  disabled,
  isDark,
}: {
  closes: boolean
  onChange: (closes: boolean) => void
  disabled?: boolean
  isDark: boolean
}) {
  const muted = isDark ? 'text-zinc-400' : 'text-neutral-500'
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <DoorOpen className={`w-4 h-4 ${muted}`} />
        <label className={`text-xs font-medium uppercase tracking-wider ${muted}`}>When everyone has left</label>
      </div>
      <p className={`text-sm mb-4 ${muted}`}>What happens to a session once the participant and the agent are both gone</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {OPTIONS.map(({ closes: value, label, text, Icon }) => {
          const selected = closes === value
          return (
            <button
              key={label}
              type="button"
              onClick={() => onChange(value)}
              disabled={disabled}
              aria-pressed={selected}
              className={`relative p-3 rounded-xl text-left transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed ${choiceCardClass(selected, isDark)}`}
            >
              {selected && <SelectedBadge isDark={isDark} className="absolute top-3 right-3" />}
              <div className="flex items-center gap-2 pr-6">
                <Icon className={`w-4 h-4 ${selected ? (isDark ? 'text-violet-400' : 'text-neutral-900') : muted}`} />
                <span className={`text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>{label}</span>
              </div>
              <p className={`text-xs mt-1 ${isDark ? 'text-zinc-500' : 'text-neutral-500'}`}>{text}</p>
            </button>
          )
        })}
      </div>
      <p className={`mt-3 text-xs ${isDark ? 'text-zinc-500' : 'text-neutral-500'}`}>
        Sessions in this project follow this unless you change it for one session under Edit Session.
        Closing a session yourself, or reaching its maximum length, still closes it.
      </p>
    </div>
  )
}
