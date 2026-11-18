/**
 * runWhenSpeechSettled / setAgentSpeechSettled (#894): the queueing half of
 * holding a task-panel update until the agent's current turn has been heard.
 * The teleprompter side (when the signal flips) is covered by
 * useTeleprompter.speechSettled.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useStore } from './index'

beforeEach(() => {
  useStore.setState({ agentSpeechSettled: true, pendingTaskUpdates: [] })
})

describe('runWhenSpeechSettled', () => {
  it('runs immediately when nothing is pending', () => {
    const fn = vi.fn()
    useStore.getState().runWhenSpeechSettled(fn)
    expect(fn).toHaveBeenCalledOnce()
    expect(useStore.getState().pendingTaskUpdates).toHaveLength(0)
  })

  it('queues instead of running while speech is unsettled', () => {
    useStore.getState().setAgentSpeechSettled(false)
    const fn = vi.fn()
    useStore.getState().runWhenSpeechSettled(fn)

    expect(fn).not.toHaveBeenCalled()
    expect(useStore.getState().pendingTaskUpdates).toHaveLength(1)
  })

  it('flushes queued updates, in order, the moment speech settles', () => {
    useStore.getState().setAgentSpeechSettled(false)
    const calls: number[] = []
    useStore.getState().runWhenSpeechSettled(() => calls.push(1))
    useStore.getState().runWhenSpeechSettled(() => calls.push(2))
    expect(calls).toEqual([])

    useStore.getState().setAgentSpeechSettled(true)

    expect(calls).toEqual([1, 2])
    expect(useStore.getState().pendingTaskUpdates).toHaveLength(0)
  })

  it('a later update can observe what an earlier queued one set', () => {
    useStore.getState().setAgentSpeechSettled(false)
    useStore.getState().runWhenSpeechSettled(() => useStore.setState({ planProgress: 50 }))
    useStore.getState().runWhenSpeechSettled(() => useStore.setState({ planProgress: useStore.getState().planProgress + 1 }))

    useStore.getState().setAgentSpeechSettled(true)

    expect(useStore.getState().planProgress).toBe(51)
  })
})
