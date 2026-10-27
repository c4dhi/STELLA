import { useState } from 'react'
import type { FitColour, HardwareFit, TtsPlaybackMode } from '../../lib/api-types'

const colourInfo: Record<FitColour, { label: string; text: string; dot: string; soft: string }> = {
  green: {
    label: 'Smooth streaming',
    text: 'The voice is generated faster than it is spoken, so streaming plays without breaks.',
    dot: 'bg-emerald-500',
    soft: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
  yellow: {
    label: 'Sentence by sentence only',
    text: 'The voice is generated about as fast as it is spoken. Streaming would break off mid-word, so sessions play each sentence once it is ready.',
    dot: 'bg-amber-400',
    soft: 'bg-amber-400/15 text-amber-700 dark:text-amber-300',
  },
  red: {
    label: 'Too slow even sentence by sentence',
    text: 'The voice takes much longer to generate than to speak, so there are long silences before each sentence.',
    dot: 'bg-red-500',
    soft: 'bg-red-500/10 text-red-700 dark:text-red-300',
  },
}

function Light({ colour, isDark }: { colour: FitColour | null; isDark: boolean }) {
  const off = isDark ? 'bg-neutral-700' : 'bg-neutral-200'
  return (
    <span
      className={`flex flex-col gap-1 p-1.5 rounded-full flex-shrink-0 ${isDark ? 'bg-surface-dark' : 'bg-neutral-800'}`}
      aria-hidden
    >
      {(['red', 'yellow', 'green'] as FitColour[]).map(c => (
        <span key={c} className={`w-3.5 h-3.5 rounded-full ${colour === c ? colourInfo[c].dot : off}`} />
      ))}
    </span>
  )
}

export function rangeText(fit: HardwareFit): string[] {
  const out: string[] = []
  const plural = (n: number) => `${n} session${n === 1 ? '' : 's'}`
  if (fit.greenUpTo) out.push(`Smooth streaming up to ${plural(fit.greenUpTo)} at once`)
  const from = (fit.greenUpTo ?? 0) + 1
  if (fit.yellowUpTo && fit.yellowUpTo >= from) {
    out.push(`Sentence by sentence ${from === fit.yellowUpTo ? `at ${plural(from)}` : `from ${from} to ${fit.yellowUpTo} sessions`}`)
  }
  if (fit.redFrom) out.push(`Too slow from ${plural(fit.redFrom)}`)
  return out
}

export default function HardwareFitPanel({
  fit,
  mode,
  isDark,
}: {
  fit: HardwareFit
  mode: TtsPlaybackMode
  isDark: boolean
}) {
  const [open, setOpen] = useState(false)
  const info = fit.colour ? colourInfo[fit.colour] : null
  const muted = isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
  const body = isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
  const strong = isDark ? 'text-content-inverse' : 'text-content'
  const maxSessions = Math.max(...fit.buckets.map(b => b.sessions), 1)

  return (
    <div className={`mb-6 p-4 rounded-xl ${isDark ? 'bg-surface-dark-tertiary' : 'bg-surface-secondary'}`}>
      <div className="flex items-start gap-4">
        <Light colour={fit.colour} isDark={isDark} />
        <div className="flex-1 min-w-0">
          <p className={`text-caption ${muted}`}>
            How well the voice fits this server
            {fit.ttsModel && fit.gpu ? ` · ${fit.ttsModel} on ${fit.gpu}` : fit.gpu ? ` · ${fit.gpu}` : ''}
          </p>
          <p className={`text-body-sm font-semibold mt-0.5 ${strong}`}>
            {info ? info.label : 'Not enough data yet'}
            {info && fit.usualSessions !== null && (
              <span className={`font-normal ${body}`}> at the usual {fit.usualSessions} session{fit.usualSessions === 1 ? '' : 's'} at once</span>
            )}
          </p>
          <p className={`text-caption mt-1 ${body}`}>
            {info
              ? info.text
              : `It needs ${fit.sentencesNeeded} spoken sentences from real sessions; it has ${fit.sentencesSeen} so far. Until then nothing is judged.`}
          </p>
        </div>
      </div>

      {/* How many sessions at once each colour holds for */}
      {fit.colour && (
        <div className="mt-4">
          <div className="flex gap-0.5" role="img" aria-label={rangeText(fit).join('; ')}>
            {Array.from({ length: maxSessions }, (_, i) => i + 1).map(n => {
              const bucket = fit.buckets.find(b => b.sessions === n)
              const c = bucket?.colour
              return (
                <span
                  key={n}
                  className={`flex-1 h-2 first:rounded-l-full last:rounded-r-full ${
                    c ? colourInfo[c].dot : isDark ? 'bg-neutral-700' : 'bg-neutral-200'
                  } ${bucket?.source === 'load test' ? 'opacity-60' : ''}`}
                />
              )
            })}
          </div>
          <div className={`flex justify-between text-[11px] mt-1 ${muted}`}>
            <span>1 session</span>
            <span>{maxSessions} at once</span>
          </div>
          <ul className={`mt-2 space-y-0.5 text-caption ${body}`}>
            {rangeText(fit).map(line => <li key={line}>{line}</li>)}
          </ul>
        </div>
      )}

      {mode === 'stream' && (fit.colour === 'yellow' || fit.colour === 'red') && (
        <p className={`mt-4 px-3 py-2 rounded-lg text-caption ${colourInfo[fit.colour].soft}`}>
          Streaming is selected, but this server can’t stream smoothly at its usual load: the voice may break off mid-word. Automatic switches by itself.
        </p>
      )}

      <p className={`mt-4 text-caption ${muted}`}>
        A session that switches to sentence by sentence stays there until it ends, so after a busy spell this can read yellow for a while.
      </p>

      <button
        onClick={() => setOpen(v => !v)}
        className={`mt-3 flex items-center gap-1 text-caption font-medium ${body}`}
      >
        How this is measured
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
          className={`transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="mt-2 overflow-x-auto">
          <table className={`w-full text-caption ${body}`}>
            <thead>
              <tr className={muted}>
                <th className="text-left font-medium py-1 pr-2 sm:pr-3">At once</th>
                <th className="text-right font-medium py-1 px-2 sm:px-3">Sentences</th>
                <th className="text-right font-medium py-1 px-2 sm:px-3">Speed (p90)</th>
                <th className="text-right font-medium py-1 px-2 sm:px-3">Switched</th>
                <th className="text-right font-medium py-1 pl-2 sm:pl-3"><span className="sr-only sm:not-sr-only">Reading</span></th>
              </tr>
            </thead>
            <tbody>
              {fit.buckets.map(b => (
                <tr key={b.sessions}>
                  <td className="py-1 pr-3">{b.sessions}</td>
                  <td className="text-right py-1 px-2 sm:px-3">{b.source === 'live' ? b.sentences : 'load test'}</td>
                  <td className="text-right py-1 px-2 sm:px-3">{b.rtfP90 !== null ? `${b.rtfP90.toFixed(2)}×` : '–'}</td>
                  <td className="text-right py-1 px-2 sm:px-3">{b.switchedShare !== null ? `${Math.round(b.switchedShare * 100)}%` : '–'}</td>
                  <td className="text-right py-1 pl-3">
                    {b.colour ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full ${colourInfo[b.colour].dot}`} />
                        <span className="hidden sm:inline">{b.colour}</span>
                      </span>
                    ) : 'too few'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={`mt-2 text-caption ${muted}`}>
            Speed is the time to generate a sentence divided by its length, from real sessions over the last {fit.windowDays} days,
            grouped by how many sessions were running at the time. Session counts with too few sentences fall back to the last load test.
          </p>
        </div>
      )}
    </div>
  )
}
