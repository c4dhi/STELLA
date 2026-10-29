/**
 * Whether speech recognition is ready to listen (#564).
 *
 * After a quiet spell the STT model is cold and takes up to ~30 s to warm up
 * when a session starts. The agent says so in an `stt_status` envelope:
 * `warming` (with how long it has been warming, `elapsed_ms`), then `ready`
 * or `failed`. A model that is still warm sends nothing at all.
 *
 * `elapsed_ms` is a duration, not a timestamp: the warmup's start is worked
 * out against this browser's clock, since the agent's and the browser's
 * clocks need not agree.
 */

export interface SttStatusEnvelope {
  state?: string
  elapsed_ms?: number
  /** The session's language, when the agent knows it. */
  language?: string
}

export interface SttStatus {
  state: 'warming' | 'failed'
  /** When warming started, on this browser's clock (ms). */
  since: number
  language: string
}

/** Past this, the screens say "taking longer than usual". */
export const SLOW_AFTER_MS = 30_000

/** The status to keep after an envelope; null once listening works. */
export function nextSttStatus(data: SttStatusEnvelope, now: number = Date.now()): SttStatus | null {
  const language = (data.language || '').toLowerCase()
  if (data.state === 'warming') return { state: 'warming', since: now - Math.max(0, data.elapsed_ms ?? 0), language }
  if (data.state === 'failed') return { state: 'failed', since: now, language }
  return null
}

export type SttPhase = 'warming' | 'slow' | 'failed'

export function sttPhase(status: SttStatus, now: number = Date.now()): SttPhase {
  if (status.state === 'failed') return 'failed'
  return now - status.since >= SLOW_AFTER_MS ? 'slow' : 'warming'
}

/** The session's language if the agent sent one, else this browser's. */
export function participantLanguage(status: SttStatus, browser: string = navigator.language): 'de' | 'en' {
  const lang = status.language || browser.toLowerCase()
  return lang.startsWith('de') ? 'de' : 'en'
}

/** What the participant reads. Formal "Sie" in German. */
export const PARTICIPANT_COPY: Record<'de' | 'en', Record<SttPhase, { title: string; body: string }>> = {
  en: {
    warming: { title: 'Getting ready to listen…', body: 'Stella can hear you in a moment.' },
    slow: { title: 'Still getting ready…', body: 'This is taking longer than usual. Please wait a moment.' },
    failed: { title: "Stella can't hear you right now", body: 'Please let the study team know.' },
  },
  de: {
    warming: { title: 'Gleich bereit zum Zuhören…', body: 'In einem Moment kann Stella Sie hören.' },
    slow: { title: 'Noch einen Moment…', body: 'Das dauert länger als sonst. Bitte warten Sie kurz.' },
    failed: { title: 'Stella kann Sie gerade nicht hören', body: 'Bitte geben Sie dem Studienteam Bescheid.' },
  },
}

/** What the researcher reads. */
export const RESEARCHER_COPY: Record<SttPhase, { chip: string; card: string; note: string }> = {
  warming: {
    chip: 'STT warming up',
    card: 'Getting ready to listen',
    note: 'Speech recognition is getting ready after a quiet spell (usually up to 30 s). The participant sees "Getting ready to listen…".',
  },
  slow: {
    chip: 'STT warming up',
    card: 'Getting ready to listen · slower than usual',
    note: 'Taking longer than usual. The participant is asked to wait. If it does not finish, check the STT service logs.',
  },
  failed: {
    chip: 'STT not ready',
    card: "Can't hear the participant",
    note: 'Speech recognition did not get ready. The participant cannot be heard and is asked to tell the study team. Restart the agent, or check the STT service.',
  },
}
