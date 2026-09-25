import { describe, it, expect } from 'vitest'
import { progressUpdateToTodoList } from './progressConversion'
import type { ProgressUpdateMessage } from './types'

function message(overrides: Partial<ProgressUpdateMessage> = {}): ProgressUpdateMessage {
  return {
    groups: [],
    progress_percentage: 0,
    update_trigger: 'turn_completion',
    metadata: {},
    ...overrides,
  } as ProgressUpdateMessage
}

describe('companion state on progress updates', () => {
  it('carries the running activity through to the todo list', () => {
    const todo = progressUpdateToTodoList(message({
      metadata: {
        companion: {
          active_activity: 'Memory Game',
          activities: [{ id: 'memory', title: 'Memory Game' }],
        },
      },
    }))

    expect(todo.companion?.active_activity).toBe('Memory Game')
  })

  it('carries the options when nothing is running', () => {
    // The whole point of the idle payload: with no plan there are no groups, so
    // this is the ONLY thing distinguishing "companion waiting to be asked" from
    // "agent that has published nothing yet".
    const todo = progressUpdateToTodoList(message({
      metadata: {
        companion: {
          active_activity: null,
          activities: [{ title: 'Memory Game' }, { title: 'Fitness Check-in' }],
        },
      },
    }))

    expect(todo.companion?.active_activity).toBeNull()
    expect(todo.companion?.activities.map(a => a.title)).toEqual([
      'Memory Game',
      'Fitness Check-in',
    ])
    expect(todo.states).toEqual([])
  })

  it('leaves companion undefined for plan-following agents', () => {
    // Its ABSENCE is load-bearing: the sidebar reads it to decide whether to
    // show the deployed plan or ask what is running right now.
    expect(progressUpdateToTodoList(message()).companion).toBeUndefined()
  })
})
