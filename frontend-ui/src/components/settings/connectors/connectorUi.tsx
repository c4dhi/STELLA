/**
 * Small pieces the connector page, its detail view, its editor and the deploy
 * wizard's Connectors step share: the default icon, the emojis offered, the
 * status pill and the icon tile.
 */
import type { ConnectorStatus } from '../../../lib/api-types'

export const DEFAULT_CONNECTOR_ICON = '🔌'

/** Emojis offered for a connector. */
export const CONNECTOR_EMOJIS = [
  '🔌', '🗂️', '📅', '📚', '🔎', '🧪', '🩺', '💊', '🏥', '📊',
  '📈', '🗄️', '🧾', '📝', '✉️', '📞', '🔔', '🗣️', '🌐', '🧠',
  '🤖', '⚙️', '🔐', '📦', '🧭', '🗺️', '❤️', '🎓', '💬', '🧩',
]

export function connectorIcon(icon: string | null | undefined): string {
  return icon?.trim() || DEFAULT_CONNECTOR_ICON
}

const STATUS_LABEL: Record<ConnectorStatus, string> = { ok: 'Connected', error: 'Failed', untested: 'Not tested' }

export function StatusPill({ status, isDark, title }: { status: ConnectorStatus; isDark: boolean; title?: string }) {
  const style = {
    ok: isDark ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-50 text-emerald-700',
    error: isDark ? 'bg-red-500/15 text-red-300' : 'bg-red-50 text-red-700',
    untested: isDark ? 'bg-zinc-700/60 text-zinc-300' : 'bg-neutral-100 text-neutral-600',
  }[status]
  return (
    <span title={title} className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-medium ${style}`}>
      {STATUS_LABEL[status]}
    </span>
  )
}

export function IconTile({ icon, isDark, size = 'md' }: { icon: string | null | undefined; isDark: boolean; size?: 'sm' | 'md' | 'lg' }) {
  const box = { sm: 'w-9 h-9 rounded-lg text-xl', md: 'w-11 h-11 rounded-xl text-2xl', lg: 'w-16 h-16 rounded-2xl text-4xl' }[size]
  return (
    <div aria-hidden="true" className={`${box} shrink-0 flex items-center justify-center ${isDark ? 'bg-zinc-700/50' : 'bg-neutral-100'}`}>
      {connectorIcon(icon)}
    </div>
  )
}

export const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function toolCountLabel(tools: { length: number } | null): string {
  if (!tools) return 'Tools unknown'
  return `${tools.length} tool${tools.length === 1 ? '' : 's'}`
}
