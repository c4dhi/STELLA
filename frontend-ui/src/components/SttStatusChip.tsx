/**
 * The researcher's view of speech recognition warming up (#564): a chip for
 * the session header with a running timer, and a line for the agent card.
 * Nothing shows while listening works.
 */
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useSttPhase } from '../hooks/useSttPhase'
import { RESEARCHER_COPY } from '../lib/sttStatus'

export function SttStatusChip({ isDark }: { isDark: boolean }) {
  const { phase, seconds } = useSttPhase()
  if (!phase) return null
  const copy = RESEARCHER_COPY[phase]
  const cls = phase === 'failed'
    ? isDark ? 'border-red-500/30 bg-red-500/15 text-red-300' : 'border-red-200 bg-red-50 text-red-700'
    : phase === 'slow'
      ? isDark ? 'border-amber-400/40 bg-amber-500/20 text-amber-200' : 'border-amber-300 bg-amber-100 text-amber-900'
      : isDark ? 'border-amber-500/30 bg-amber-500/15 text-amber-300' : 'border-amber-200 bg-amber-50 text-amber-800'
  return (
    <div role="status" title={copy.note} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${cls}`}>
      <div className={`status-dot ${phase === 'failed' ? 'status-dot-error' : 'status-dot-warning animate-pulse'}`} />
      <span className="text-label uppercase">{copy.chip}</span>
      {phase !== 'failed' && <span className="text-label tabular-nums">{seconds} s</span>}
    </div>
  )
}

export function SttStatusLine({ isDark }: { isDark: boolean }) {
  const { phase } = useSttPhase()
  if (!phase) return null
  const copy = RESEARCHER_COPY[phase]
  const failed = phase === 'failed'
  return (
    <div
      title={copy.note}
      className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs mb-3 ${
        failed
          ? isDark ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-red-200 bg-red-50 text-red-700'
          : isDark ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-amber-200 bg-amber-50 text-amber-800'
      }`}
    >
      {failed
        ? <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        : <Loader2 className="w-3.5 h-3.5 mt-0.5 animate-spin shrink-0" />}
      <span>{copy.card}</span>
    </div>
  )
}
