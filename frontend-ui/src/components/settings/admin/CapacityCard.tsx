import { useThemeStore } from '../../../store/themeStore'
import type { CapacityMeasurement } from '../../../lib/api-types'

interface CapacityCardProps {
  measurements: CapacityMeasurement[]
  isLoading: boolean
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "26 Sep 2026", in UTC so the date does not shift with the viewer or the locale. */
export function formatMeasuredDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** The headline number, honest about a test that never found the limit. */
export function capacityHeadline(m: Pick<CapacityMeasurement, 'maxSessions' | 'reachedTopLevel'>): string {
  const n = m.maxSessions
  if (n === 0) return 'Not even one conversation stays fluent'
  const noun = n === 1 ? 'conversation' : 'conversations'
  return m.reachedTopLevel ? `at least ${n} simultaneous ${noun}` : `${n} simultaneous ${noun}`
}

/** What the number was measured with, so a bare figure is never read out of context. */
export function basisLine(m: Pick<CapacityMeasurement, 'sttProvider' | 'ttsProvider' | 'criteria'>): string {
  const parts: string[] = []
  if (m.ttsProvider) parts.push(`Voice engine: ${m.ttsProvider}`)
  if (m.sttProvider) parts.push(`speech recognition: ${m.sttProvider}`)
  if (m.criteria?.preroll_ms !== undefined) parts.push(`player pre-roll ${Math.round(m.criteria.preroll_ms)} ms`)
  if (m.criteria?.max_tts_starved_pct !== undefined) parts.push(`fails above ${m.criteria.max_tts_starved_pct}% voice starvation`)
  return parts.join(' · ')
}

const ms = (v: number | null) => (v === null || v === undefined ? '–' : `${Math.round(v)} ms`)
const pct = (v: number | null) => (v === null || v === undefined ? '–' : `${v.toFixed(1)}%`)

export default function CapacityCard({ measurements, isLoading }: CapacityCardProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const muted = isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
  const strong = isDark ? 'text-content-inverse' : 'text-content'
  const box = isDark ? 'bg-white/5 border-white/10' : 'bg-black/[0.02] border-black/5'

  return (
    <div className={`p-5 rounded-xl border ${box}`} data-testid="capacity-card">
      <h3 className={`text-body font-medium mb-1 ${strong}`}>Voice capacity</h3>
      <p className={`text-caption mb-4 ${muted}`}>
        How many conversations at once a server&apos;s GPU carries before speech recognition or the
        voice slows down or stutters. Measured with the load test, not estimated.
      </p>

      {isLoading ? (
        <p className={`text-body-sm ${muted}`}>Loading…</p>
      ) : measurements.length === 0 ? (
        <p className={`text-body-sm ${muted}`}>
          Not measured yet. Run <code>scripts/load-test/load_test.py</code> against a server; see
          the README next to it.
        </p>
      ) : (
        <div className="space-y-5">
          {measurements.map((m) => (
            <div key={m.id} data-testid="capacity-measurement">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className={`text-heading-sm font-semibold ${strong}`}>
                  {capacityHeadline(m)}
                </span>
                <span className={`text-body-sm ${muted}`}>
                  {m.gpuName}
                  {m.gpuMemoryMb ? ` (${Math.round(m.gpuMemoryMb / 1024)} GB)` : ''} · {m.environment}{' '}
                  · measured {formatMeasuredDate(m.measuredAt)}
                </span>
              </div>
              <p className={`text-caption mt-1 ${muted}`} data-testid="capacity-basis">
                {basisLine(m)}
              </p>
              {m.limitedBy.length > 0 && (
                <p className={`text-caption mt-1 ${muted}`}>
                  {m.maxSessions === 0 ? 'One session already failed' : 'Next level failed'}:{' '}
                  {m.limitedBy.join('; ')}
                </p>
              )}
              {m.reachedTopLevel && (
                <p className={`text-caption mt-1 ${muted}`}>
                  The test stopped at its highest level without finding the limit; run it with more
                  sessions.
                </p>
              )}
              <div className="overflow-x-auto mt-3">
                <table className="w-full text-caption tabular-nums">
                  <thead>
                    <tr className={muted}>
                      <th className="text-left font-medium pr-4 py-1">Sessions</th>
                      <th className="text-right font-medium px-4 py-1">Speech recognition (p95)</th>
                      <th className="text-right font-medium px-4 py-1">Voice first audio (p95)</th>
                      <th className="text-right font-medium px-4 py-1">Voice starved</th>
                      <th className="text-right font-medium pl-4 py-1">GPU peak</th>
                    </tr>
                  </thead>
                  <tbody className={strong}>
                    {m.levels.map((l) => (
                      <tr key={l.sessions} className={l.sessions === m.maxSessions ? 'font-semibold' : ''}>
                        <td className="pr-4 py-1">{l.sessions}</td>
                        <td className="text-right px-4 py-1">{ms(l.stt_final_p95_ms)}</td>
                        <td className="text-right px-4 py-1">{ms(l.tts_ttfa_p95_ms)}</td>
                        <td className="text-right px-4 py-1">{pct(l.tts_starved_pct)}</td>
                        <td className="text-right pl-4 py-1">
                          {l.gpu_util_max_pct === null || l.gpu_util_max_pct === undefined
                            ? '–'
                            : `${Math.round(l.gpu_util_max_pct)}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
