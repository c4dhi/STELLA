// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { agentActivityEnded, anyActivityActive, isNewActivityStarting } from './index'
import type { TodoList } from '../lib/types'

function planList(remaining_states: number): TodoList {
  return { remaining_states } as unknown as TodoList
}

function companionList(active_activity: string | null): TodoList {
  return { remaining_states: 0, companion: { active_activity, activities: [] } } as unknown as TodoList
}

describe('agentActivityEnded', () => {
  it('a plan agent has ended once no states remain', () => {
    expect(agentActivityEnded(planList(0))).toBe(true)
    expect(agentActivityEnded(planList(2))).toBe(false)
  })

  it('a companion has ended when it names no active activity, regardless of remaining_states', () => {
    expect(agentActivityEnded(companionList(null))).toBe(true)
    expect(agentActivityEnded(companionList('chatting'))).toBe(false)
  })
})

describe('anyActivityActive', () => {
  it('is false when every entry has ended', () => {
    expect(anyActivityActive([planList(0), companionList(null)])).toBe(false)
  })

  it('is true as soon as one entry is still active', () => {
    expect(anyActivityActive([planList(0), companionList('chatting')])).toBe(true)
  })

  it('is false for an empty list', () => {
    expect(anyActivityActive([])).toBe(false)
  })
})

describe('isNewActivityStarting', () => {
  it('is true for an agent with no previous entry that starts active', () => {
    expect(isNewActivityStarting(undefined, planList(3))).toBe(true)
  })

  it('is true when the agent\'s last activity had ended and this one is active', () => {
    expect(isNewActivityStarting(planList(0), planList(3))).toBe(true)
  })

  it('is false while an already-active agent just keeps going', () => {
    expect(isNewActivityStarting(planList(3), planList(2))).toBe(false)
  })

  it('is false when the agent is still ended', () => {
    expect(isNewActivityStarting(planList(0), planList(0))).toBe(false)
  })

  it('is false the moment an active agent ends', () => {
    expect(isNewActivityStarting(planList(2), planList(0))).toBe(false)
  })
})
