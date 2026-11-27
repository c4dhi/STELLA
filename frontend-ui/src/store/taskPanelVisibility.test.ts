// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { agentActivityEnded, anyActivityActive, isNewActivityStarting, useStore } from './index'
import type { TodoList } from '../lib/types'

function planList(remaining_states: number, total_states = 5): TodoList {
  return { remaining_states, total_states } as unknown as TodoList
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

describe('agentActivityEnded: no groups at all', () => {
  it('a plan envelope with total_states 0 is not read as ended', () => {
    expect(agentActivityEnded(planList(0, 0))).toBe(false)
  })
})

// The predicates above are pure; these cover the store actions that use them,
// per sable's review of PR 979 — a predicate test alone wouldn't catch an
// action that computes it right but then gets overwritten, or ignores the pin.
describe('the task panel store actions', () => {
  beforeEach(() => {
    useStore.getState().clearTasks()
  })

  it('1. a plan agent reaching remaining_states 0 hides the panel', () => {
    useStore.getState().setAgentTaskList('a1', planList(2), 'Agent 1')
    expect(useStore.getState().showTaskPanel).toBe(true)

    useStore.getState().setAgentTaskList('a1', planList(0), 'Agent 1')
    useStore.getState().setTodoList(planList(0))

    expect(useStore.getState().showTaskPanel).toBe(false)
  })

  it('2. a companion whose active_activity goes to null hides the panel', () => {
    useStore.getState().setAgentTaskList('a1', companionList('chatting'), 'Agent 1')
    expect(useStore.getState().showTaskPanel).toBe(true)

    useStore.getState().setAgentTaskList('a1', companionList(null), 'Agent 1')
    useStore.getState().setTodoList(companionList(null))

    expect(useStore.getState().showTaskPanel).toBe(false)
  })

  it('3. with two agents, the panel stays shown until both have ended', () => {
    useStore.getState().setAgentTaskList('a1', planList(2), 'Agent 1')
    useStore.getState().setAgentTaskList('a2', planList(3), 'Agent 2')

    useStore.getState().setAgentTaskList('a1', planList(0), 'Agent 1')
    expect(useStore.getState().showTaskPanel).toBe(true)

    useStore.getState().setAgentTaskList('a2', planList(0), 'Agent 2')
    expect(useStore.getState().showTaskPanel).toBe(false)
  })

  it('4. pinning it back open keeps it shown through another ended update', () => {
    useStore.getState().setAgentTaskList('a1', planList(0), 'Agent 1')
    expect(useStore.getState().showTaskPanel).toBe(false)

    useStore.getState().setShowTaskPanel(true)
    expect(useStore.getState().showTaskPanel).toBe(true)

    useStore.getState().setAgentTaskList('a1', planList(0), 'Agent 1')
    expect(useStore.getState().showTaskPanel).toBe(true)
  })

  it('5. a new activity after the pin clears it, hiding the panel once that one ends too', () => {
    useStore.getState().setAgentTaskList('a1', planList(0), 'Agent 1')
    useStore.getState().setShowTaskPanel(true)

    useStore.getState().setAgentTaskList('a1', planList(2), 'Agent 1')
    expect(useStore.getState().taskPanelPinnedOpen).toBe(false)

    useStore.getState().setAgentTaskList('a1', planList(0), 'Agent 1')
    expect(useStore.getState().showTaskPanel).toBe(false)
  })

  it('6. a manual hide while active clears the pin too', () => {
    useStore.getState().setAgentTaskList('a1', planList(2), 'Agent 1')

    useStore.getState().setShowTaskPanel(false)

    expect(useStore.getState().showTaskPanel).toBe(false)
    expect(useStore.getState().taskPanelPinnedOpen).toBe(false)
  })
})

// #199: on reload/resume the page rebuilds the task state from the session's
// history. That used to open the panel whenever any task list was in the
// history, even an ended one, and the agent's first update then closed it
// again: the panel flashed when the user came back.
describe('the task panel after the history loads (#199)', () => {
  function historyUpdate(todoList: TodoList, timestamp: number) {
    return { timestamp, messageId: `m${timestamp}`, agentId: 'a1', agentName: 'Agent 1', todoList }
  }

  beforeEach(() => {
    useStore.getState().clearTasks()
    useStore.getState().clearTaskTimeline()
  })

  it('stays closed when the last activity in the history had ended', () => {
    useStore.setState({
      taskUpdateHistory: [historyUpdate(companionList('Gedächtnis-Quiz'), 1), historyUpdate(companionList(null), 2)],
    })
    useStore.getState().applyLatestTaskState()
    expect(useStore.getState().showTaskPanel).toBe(false)
  })

  it('stays closed for a companion that never started an activity', () => {
    useStore.setState({ taskUpdateHistory: [historyUpdate(companionList(null), 1)] })
    useStore.getState().applyLatestTaskState()
    expect(useStore.getState().showTaskPanel).toBe(false)
  })

  it('opens when an activity is still running', () => {
    useStore.setState({ taskUpdateHistory: [historyUpdate(companionList('Gedächtnis-Quiz'), 1)] })
    useStore.getState().applyLatestTaskState()
    expect(useStore.getState().showTaskPanel).toBe(true)
  })

  it('stays open when the user had pinned it', () => {
    useStore.setState({ taskUpdateHistory: [historyUpdate(planList(0), 1)] })
    useStore.getState().setShowTaskPanel(true)
    useStore.getState().applyLatestTaskState()
    expect(useStore.getState().showTaskPanel).toBe(true)
  })
})
