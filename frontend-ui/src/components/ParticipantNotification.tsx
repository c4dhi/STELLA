import { motion } from 'framer-motion'
import type { ParticipantEvent } from '../lib/types'
import { summarizeRun } from '../lib/participantEvents'
import { useThemeStore } from '../store/themeStore'

interface ParticipantNotificationProps {
  /** One or more join/leave events in a row; shown as one quiet line. */
  events: ParticipantEvent[]
}

export default function ParticipantNotification({ events }: ParticipantNotificationProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const outcome = summarizeRun(events)
  const name = isDark ? 'text-zinc-300' : 'text-neutral-600'

  // Every event stays readable on hover, in order.
  const detail = events
    .map((e) => `${e.participantName || e.participantId || 'Unknown'} ${e.type === 'joined' ? 'joined' : 'left'}`)
    .join('\n')

  return (
    <motion.div
      className="flex justify-center w-full my-2"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <div
        title={events.length > 1 ? detail : undefined}
        className={`
          max-w-[90%] px-3 py-1 rounded-full text-xs font-light text-center
          ${isDark ? 'text-zinc-500 bg-zinc-800/60' : 'text-neutral-500 bg-neutral-100'}
        `}
      >
        {outcome.map((o, i) => (
          <span key={o.name}>
            {i > 0 && <span className="mx-1.5">·</span>}
            <span className={`font-medium ${name}`}>{o.name}</span>{' '}
            {o.type === 'joined' ? (o.changes > 1 ? 'reconnected' : 'joined') : 'left'}
          </span>
        ))}
      </div>
    </motion.div>
  )
}
