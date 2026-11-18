// @vitest-environment jsdom
/**
 * A face that mounts AFTER the agent's `[sleep]` (#149).
 *
 * Switching from the text interface back to the face mounts a fresh
 * StellaFace. The command arrived while it was gone, so the face has to learn
 * about it from what is still pending — not from a seq change it never saw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useSleepState } from './useSleepState'

const quiet = {
  isPresent: false,
  isUserSpeaking: false,
  isRemoteSpeaking: false,
  cameraActive: true,
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('a face mounted after the [sleep] command (#149)', () => {
  it('goes to sleep when the command is still pending', () => {
    const onSleepHandled = vi.fn<() => void>()
    const { result } = renderHook(() =>
      useSleepState({ ...quiet, sleepCommandSeq: 3, sleepPending: true, onSleepHandled })
    )
    act(() => { vi.advanceTimersByTime(400) })
    expect(result.current.phase).toBe('asleep')
    expect(onSleepHandled).toHaveBeenCalled()
  })

  it('stays awake when that command was already honoured or cancelled', () => {
    const { result } = renderHook(() =>
      useSleepState({ ...quiet, sleepCommandSeq: 3, sleepPending: false })
    )
    act(() => { vi.advanceTimersByTime(1000) })
    expect(result.current.phase).toBe('awake')
  })

  it('reports a pending sleep dropped by the user speaking as handled', () => {
    const onSleepHandled = vi.fn<() => void>()
    const { result } = renderHook(() =>
      useSleepState({ ...quiet, isUserSpeaking: true, sleepCommandSeq: 3, sleepPending: true, onSleepHandled })
    )
    act(() => { vi.advanceTimersByTime(400) })
    expect(result.current.phase).toBe('awake')
    expect(onSleepHandled).toHaveBeenCalled()
  })

  it('reports a sleep it honours the same tick the command arrives as handled', () => {
    // On screen and quiet: the command and the honour land in one step.
    const onSleepHandled = vi.fn<() => void>()
    const { result, rerender } = renderHook(
      (p: { seq: number; pending: boolean }) =>
        useSleepState({ ...quiet, sleepCommandSeq: p.seq, sleepPending: p.pending, onSleepHandled }),
      { initialProps: { seq: 0, pending: false } }
    )
    rerender({ seq: 1, pending: true })
    act(() => { vi.advanceTimersByTime(400) })
    expect(result.current.phase).toBe('asleep')
    expect(onSleepHandled).toHaveBeenCalled()
  })
})
