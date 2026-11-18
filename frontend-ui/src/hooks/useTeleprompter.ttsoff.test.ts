// @vitest-environment jsdom
/**
 * A session whose agent runs with TTS off (#180). Nothing is spoken, so no
 * progress envelope ever arrives; the agent says so with `stella.speech`
 * `{enabled: false}`, and the reply's cues fire once its text is in, the same
 * as in the text interface (#149).
 */
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTeleprompter, type AgentEmotionCue } from './useTeleprompter'

const GOODBYE = 'Schlaf gut, bis morgen.'
const sleepCue = { char: GOODBYE.length, tag: 'sleep', kind: 'state' } as unknown as AgentEmotionCue

describe('state cues with TTS off (#180)', () => {
  it('fire at the end of the text in a voice session whose agent does not speak', () => {
    const { result } = renderHook(() => useTeleprompter({ interactionMode: 'voice', speaks: false }))
    act(() => {
      result.current.noteAgentText('tr-bye', GOODBYE)
      result.current.noteEmotionCues('tr-bye', [sleepCue])
    })
    expect(result.current.faceState?.tag).toBe('sleep')
  })

  it('fire when the agent says it stopped speaking mid-session', () => {
    const { result, rerender } = renderHook(({ speaks }) => useTeleprompter({ interactionMode: 'voice', speaks }), {
      initialProps: { speaks: true },
    })
    rerender({ speaks: false })
    act(() => {
      result.current.noteEmotionCues('tr-bye', [sleepCue])
      result.current.noteAgentText('tr-bye', GOODBYE)
    })
    expect(result.current.faceState?.tag).toBe('sleep')
  })

  it('wait for the voice when the agent speaks (the default)', () => {
    const { result } = renderHook(() => useTeleprompter({ interactionMode: 'voice', speaks: true }))
    act(() => {
      result.current.noteAgentText('tr-bye', GOODBYE)
      result.current.noteEmotionCues('tr-bye', [sleepCue])
    })
    expect(result.current.faceState).toBeNull()
  })
})
