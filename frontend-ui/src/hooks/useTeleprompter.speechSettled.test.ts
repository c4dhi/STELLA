// @vitest-environment jsdom
/**
 * speechSettled (#894): the signal a consumer uses to hold a task-panel
 * update until the turn describing it has actually been heard, rather than
 * applying it the instant the transport event arrives.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTeleprompter } from './useTeleprompter'

function speaking(overrides: Partial<Parameters<ReturnType<typeof useTeleprompter>['applyProgress']>[0]> = {}) {
  return {
    transcript_id: 't1',
    state: 'speaking' as const,
    spoken_char: 0,
    target_char: 20,
    char_end: 20,
    delay_ms: 0,
    duration_ms: 500,
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('speechSettled', () => {
  it('starts settled — nothing to wait for before any speech', () => {
    const { result } = renderHook(() => useTeleprompter())
    expect(result.current.speechSettled).toBe(true)
  })

  it('goes false the moment a segment is scheduled, true once the quiet window passes', () => {
    const { result } = renderHook(() => useTeleprompter())

    act(() => result.current.applyProgress(speaking()))
    expect(result.current.speechSettled).toBe(false)

    // Audible at now+delay+LAG(60ms), playing for duration_ms(500ms): not done yet.
    act(() => vi.advanceTimersByTime(400))
    expect(result.current.speechSettled).toBe(false)

    // The schedule itself has run out (560ms), but the 500ms quiet window
    // hasn't — settling here would be the exact bug the review caught.
    act(() => vi.advanceTimersByTime(300))
    expect(result.current.speechSettled).toBe(false)

    act(() => vi.advanceTimersByTime(400))
    expect(result.current.speechSettled).toBe(true)
  })

  it('stays unsettled across chained ticks and only settles after the quiet window past the last one', () => {
    const { result } = renderHook(() => useTeleprompter())

    act(() => result.current.applyProgress(speaking({ duration_ms: 300 })))
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.speechSettled).toBe(false)

    // A second tick for the same transcript chains onto the first, pushing
    // the settle point further out rather than resolving early.
    act(() => result.current.applyProgress(speaking({ spoken_char: 20, target_char: 40, char_end: 40, duration_ms: 300 })))
    act(() => vi.advanceTimersByTime(250)) // past the first tick's own end, not the chained one
    expect(result.current.speechSettled).toBe(false)

    act(() => vi.advanceTimersByTime(720))
    expect(result.current.speechSettled).toBe(true)
  })

  it('a gap between sentences shorter than the quiet window does not settle mid-reply', () => {
    const { result } = renderHook(() => useTeleprompter())

    // Sentence 1: schedule runs out at 360ms (audible at 60, plays 300ms).
    act(() => result.current.applyProgress(speaking({ duration_ms: 300 })))
    expect(result.current.speechSettled).toBe(false)

    // 200ms into the gap after sentence 1 ends — shorter than the 500ms
    // window, and sentence 2's envelope hasn't arrived yet. This is the
    // audible pause between sentences while the next one is still being
    // synthesized; it must not read as "done".
    act(() => vi.advanceTimersByTime(560))
    expect(result.current.speechSettled).toBe(false)

    // Sentence 2 arrives inside the gap and chains on, re-arming the window.
    act(() => result.current.applyProgress(speaking({ spoken_char: 20, target_char: 40, char_end: 40, duration_ms: 300 })))
    expect(result.current.speechSettled).toBe(false)

    // Settles only once the quiet window has passed since sentence 2's own end.
    act(() => vi.advanceTimersByTime(900))
    expect(result.current.speechSettled).toBe(true)
  })

  it('settles immediately on a committed barge-in — nothing left to hear', () => {
    const { result } = renderHook(() => useTeleprompter())

    act(() => result.current.applyProgress(speaking()))
    expect(result.current.speechSettled).toBe(false)

    act(() => result.current.applyProgress({ ...speaking(), state: 'interrupted', spoken_char: 5 }))
    expect(result.current.speechSettled).toBe(true)
  })

  it('tracks the real audio duration even with prefers-reduced-motion, where the visual cursor jumps instantly', () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true })
    vi.stubGlobal('matchMedia', matchMedia)

    const { result } = renderHook(() => useTeleprompter())

    act(() => result.current.applyProgress(speaking()))
    // The highlight itself jumps straight to the target...
    expect(result.current.spokenChar).toBe(20)
    // ...but the task panel still waits for the audio to actually finish,
    // plus the quiet window.
    expect(result.current.speechSettled).toBe(false)

    act(() => vi.advanceTimersByTime(560))
    expect(result.current.speechSettled).toBe(false)

    act(() => vi.advanceTimersByTime(500))
    expect(result.current.speechSettled).toBe(true)

    vi.unstubAllGlobals()
  })
})
