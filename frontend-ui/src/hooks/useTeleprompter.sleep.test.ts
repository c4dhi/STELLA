// @vitest-environment jsdom
/**
 * `[sleep]` must reach the face whatever interface the reply arrived in (#149).
 *
 * In the text interface the agent speaks nothing, so no progress envelope ever
 * arrives for that reply and the audio-driven cursor never moves. The text is
 * the progress there, exactly as in a session with TTS off.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useTeleprompter, type AgentEmotionCue } from './useTeleprompter'

// This file is the only one of the useTeleprompter suites that drives a
// spoken reply (speakVoiceReply, below), which starts the hook's
// requestAnimationFrame loop. Without unmounting, that loop is still
// scheduled on this file's jsdom window when vitest tears it down for the
// next file, which then throws "window is not defined" from an unrelated
// test (#987) — the hook's own unmount cleanup (useTeleprompter.ts) is
// correct, it just never ran. @testing-library/react's automatic cleanup
// needs `afterEach` as a real global, which this project doesn't set, so it
// has to be done explicitly here instead of relying on it.
afterEach(cleanup)

const GOODBYE = 'Schlaf gut, bis morgen.'
const sleepCue = { char: GOODBYE.length, tag: 'sleep', kind: 'state' } as unknown as AgentEmotionCue

/** A spoken voice reply, so the teleprompter is live for the session. */
function speakVoiceReply(t: ReturnType<typeof useTeleprompter>) {
  t.noteAgentText('tr-voice', 'Hallo.')
  t.applyProgress({ transcript_id: 'tr-voice', char_end: 6, target_char: 6, spoken_char: 0, state: 'speaking', delay_ms: 0, duration_ms: 0 } as never)
}

describe('the [sleep] state cue across interfaces (#149)', () => {
  it('fires for a goodbye typed back in the text interface after earlier voice turns', () => {
    const { result, rerender } = renderHook(({ mode }) => useTeleprompter({ interactionMode: mode }), {
      initialProps: { mode: 'voice' as 'voice' | 'text' },
    })
    act(() => speakVoiceReply(result.current))
    rerender({ mode: 'text' })
    act(() => {
      result.current.noteAgentText('tr-bye', GOODBYE)
      result.current.noteEmotionCues('tr-bye', [sleepCue])
    })
    expect(result.current.faceState?.tag).toBe('sleep')
  })

  it('fires when the cues envelope arrives before the text', () => {
    const { result, rerender } = renderHook(({ mode }) => useTeleprompter({ interactionMode: mode }), {
      initialProps: { mode: 'voice' as 'voice' | 'text' },
    })
    act(() => speakVoiceReply(result.current))
    rerender({ mode: 'text' })
    act(() => {
      result.current.noteEmotionCues('tr-bye', [sleepCue])
      result.current.noteAgentText('tr-bye', GOODBYE)
    })
    expect(result.current.faceState?.tag).toBe('sleep')
  })

  it('fires in a text-only session where nothing was ever spoken', () => {
    const { result } = renderHook(() => useTeleprompter({ interactionMode: 'text' }))
    act(() => {
      result.current.noteAgentText('tr-bye', GOODBYE)
      result.current.noteEmotionCues('tr-bye', [sleepCue])
    })
    expect(result.current.faceState?.tag).toBe('sleep')
  })

  it('in voice, does not fire the first reply\'s cues before its first progress arrives', () => {
    const { result } = renderHook(() => useTeleprompter({ interactionMode: 'voice' }))
    act(() => {
      result.current.noteAgentText('tr-bye', GOODBYE)
      result.current.noteEmotionCues('tr-bye', [sleepCue])
    })
    expect(result.current.faceState).toBeNull()
  })

  it('in voice, waits for the voice: no sleep before the playhead reaches the cue', () => {
    const { result } = renderHook(() => useTeleprompter({ interactionMode: 'voice' }))
    act(() => speakVoiceReply(result.current))
    act(() => {
      result.current.noteAgentText('tr-bye', GOODBYE)
      result.current.noteEmotionCues('tr-bye', [sleepCue])
    })
    expect(result.current.faceState).toBeNull()
  })
})
