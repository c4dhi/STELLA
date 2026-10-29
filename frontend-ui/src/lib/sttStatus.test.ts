import { describe, expect, it } from 'vitest'
import { nextSttStatus, participantLanguage, sttPhase, SLOW_AFTER_MS } from './sttStatus'

describe('stt status', () => {
  it('dates warming from the browser clock, counting back what the agent has already waited', () => {
    expect(nextSttStatus({ state: 'warming', elapsed_ms: 4_000, language: 'DE' }, 100_000)).toEqual({
      state: 'warming',
      since: 96_000,
      language: 'de',
    })
  })

  it('clears once ready, and on anything it does not know', () => {
    expect(nextSttStatus({ state: 'ready' })).toBeNull()
    expect(nextSttStatus({ state: 'cold' })).toBeNull()
  })

  it('turns slow at 30 s and stays failed once failed', () => {
    const warming = nextSttStatus({ state: 'warming', elapsed_ms: 0 }, 0)!
    expect(sttPhase(warming, SLOW_AFTER_MS - 1)).toBe('warming')
    expect(sttPhase(warming, SLOW_AFTER_MS)).toBe('slow')
    expect(sttPhase(nextSttStatus({ state: 'failed' }, 0)!, 0)).toBe('failed')
  })

  it("speaks the session's language, else the browser's, else English", () => {
    const status = (language: string) => nextSttStatus({ state: 'warming', language })!
    expect(participantLanguage(status('de'), 'en-US')).toBe('de')
    expect(participantLanguage(status('en'), 'de-CH')).toBe('en')
    expect(participantLanguage(status(''), 'de-CH')).toBe('de')
    expect(participantLanguage(status('fr'), 'de-CH')).toBe('en')
  })
})
