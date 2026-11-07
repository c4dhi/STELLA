import type { Connector } from '../../../lib/api-types'
import { IconTile, StatusPill, formatDateTime, toolCountLabel } from './connectorUi'

interface ConnectorCardProps {
  connector: Connector
  isDark: boolean
  onOpen: () => void
}

/** One connector in the Settings grid. Opens its detail view. */
export default function ConnectorCard({ connector: c, isDark, onOpen }: ConnectorCardProps) {
  const failed = c.status === 'error'
  const shared = c.sharedWith.length
    ? c.sharedWith.length === 1
      ? `Shared with ${c.sharedWith[0].projectName}`
      : `Shared with ${c.sharedWith.length} projects`
    : 'Only your agents'
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group w-full min-h-[188px] p-5 rounded-2xl border text-left flex flex-col gap-2.5 transition-colors ${
        isDark
          ? `bg-surface-dark-secondary ${failed ? 'border-red-500/40' : 'border-border-dark'} hover:border-zinc-500`
          : `bg-white shadow-sm ${failed ? 'border-red-200' : 'border-neutral-200/60'} hover:border-neutral-400`
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <IconTile icon={c.icon} isDark={isDark} />
        <StatusPill
          status={c.status}
          isDark={isDark}
          title={c.lastCheckedAt ? `Checked ${formatDateTime(c.lastCheckedAt)}` : undefined}
        />
      </div>
      <div className={`text-body font-semibold truncate ${isDark ? 'text-content-inverse' : 'text-content'}`}>{c.name}</div>
      <p
        className={`text-body-sm leading-relaxed line-clamp-2 ${
          c.description
            ? isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
            : isDark ? 'text-content-inverse-tertiary italic' : 'text-content-tertiary italic'
        }`}
      >
        {c.description || 'No description yet.'}
      </p>
      {failed && c.lastError ? (
        <div className={`mt-auto text-caption truncate ${isDark ? 'text-red-300' : 'text-red-600'}`} title={c.lastError}>
          {c.lastError}
        </div>
      ) : (
        <div className={`mt-auto flex justify-between gap-3 text-caption ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
          <span>{toolCountLabel(c.tools)}</span>
          <span className="truncate" title={c.sharedWith.map((s) => s.projectName).join(', ') || undefined}>{shared}</span>
        </div>
      )}
    </button>
  )
}
