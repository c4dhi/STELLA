/**
 * Shared utilities for converting SDK ProgressUpdateMessage → TodoList format.
 * Used by both live transport handlers (SessionView) and historical replay (store).
 */

import type { ProgressUpdateMessage, ProgressItem, TodoList } from './types'
import { StateType, StateStatus, TaskStatus, DeliverableStatus } from './types'

/**
 * Resolve state type from group metadata, with execution_mode fallback.
 * Handles legacy "strict"/"loose" values for migration compatibility.
 */
export function resolveStateType(group: { metadata?: Record<string, any>; execution_mode?: string }): StateType {
  const metaType = group.metadata?.state_type
  if (metaType === 'strict') return 'sequential' as StateType
  if (metaType === 'loose') return 'flexible' as StateType
  if (metaType === 'goal' || metaType === 'sequential' || metaType === 'flexible') {
    return metaType as StateType
  }
  return group.execution_mode === 'sequential' ? 'sequential' as StateType : 'flexible' as StateType
}

/**
 * Reconstruct tasks from flat progress items by grouping on task_id metadata.
 * Items without a task_id are assigned to a 'default_task'.
 */
export function reconstructTasksFromItems(items: ProgressItem[]) {
  if (!items || items.length === 0) return []

  const taskMap = new Map<string, {
    id: string
    description: string
    instruction: string
    deliverables: ProgressItem[]
  }>()

  for (const item of items) {
    const taskId = item.metadata?.task_id || 'default_task'
    const taskDescription = item.metadata?.task_description || item.description || 'Task'

    if (!taskMap.has(taskId)) {
      taskMap.set(taskId, {
        id: taskId,
        description: taskDescription,
        instruction: '',
        deliverables: []
      })
    }
    taskMap.get(taskId)!.deliverables.push(item)
  }

  return Array.from(taskMap.values()).map(task => {
    const isTaskItem = task.deliverables.length === 1 && task.deliverables[0].metadata?.is_task_item

    if (isTaskItem) {
      const item = task.deliverables[0]
      return {
        id: task.id,
        description: task.description,
        instruction: item.description || '',
        required: item.required,
        status: item.status as TaskStatus,
        deliverables: [],
      }
    }

    // Prefer the real task status from the state machine (#291): the backend
    // is the single source of truth for whether a task is done. Only fall back
    // to deriving status from deliverable fill when the agent didn't ship it
    // (older payloads), which previously caused "3/3 done" while the state was
    // actually stuck because a task hadn't been completed/skipped.
    const realStatus = task.deliverables
      .map(d => d.metadata?.task_status as TaskStatus | undefined)
      .find(s => s != null)

    const allCompleted = task.deliverables.every(d => d.status === 'completed' || d.status === 'skipped')
    const anyInProgress = task.deliverables.some(d => d.status === 'in_progress')
    const taskStatus: TaskStatus = realStatus ??
      (allCompleted ? TaskStatus.COMPLETED :
        anyInProgress ? TaskStatus.IN_PROGRESS : TaskStatus.PENDING)

    return {
      id: task.id,
      description: task.description,
      instruction: task.instruction,
      required: task.deliverables.some(d => d.required),
      status: taskStatus,
      deliverables: task.deliverables.map(item => ({
        key: item.id,
        description: item.label,
        type: item.metadata?.deliverable_type || 'string',
        required: item.required,
        status: item.status as DeliverableStatus,
        value: item.value,
        collected_at: item.collected_at,
        confidence: item.confidence,
        reasoning: item.metadata?.reasoning,
        acceptance_criteria: item.metadata?.acceptance_criteria,
        discovered: item.metadata?.discovered || false,
      }))
    }
  })
}

/**
 * Normalize raw transition metadata from a progress group into typed objects.
 */
function normalizeTransitions(group: { metadata?: Record<string, any> }) {
  const rawTransitions = group?.metadata?.transitions
  if (!Array.isArray(rawTransitions)) return []

  const toPriority = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
    return undefined
  }

  return rawTransitions
    .map((transition: any) => ({
      target_state_id: transition?.target_state_id || transition?.target || '',
      condition_type: transition?.condition_type || transition?.condition || 'all_tasks_complete',
      priority: toPriority(transition?.priority),
      condition_config: transition?.condition_config,
    }))
    .filter((transition: any) => transition.target_state_id)
}

/**
 * Convert a ProgressUpdateMessage into a TodoList.
 * This is the single source of truth for this conversion,
 * used by both live handlers and historical replay.
 */
export function progressUpdateToTodoList(data: ProgressUpdateMessage): TodoList {
  return {
    initialized: true,
    first_state_activated_at: data.started_at || new Date().toISOString(),
    total_states: data.groups?.length || 0,
    current_state_index: data.groups?.findIndex(g => g.id === data.current_group_id) ?? 0,
    completed_states: data.groups?.filter(g => g.status === 'completed').length || 0,
    remaining_states: data.groups?.filter(g => g.status !== 'completed').length || 0,
    progress_percentage: data.progress_percentage || 0,
    agentIcon: data.metadata?.agent_icon || '🤖',
    current_state: data.current_group_id ? (() => {
      const group = data.groups?.find(g => g.id === data.current_group_id)
      if (!group) return null
      return {
        id: group.id,
        title: group.label,
        type: resolveStateType(group),
        description: group.description || '',
        status: group.status as StateStatus,
        state_number: data.groups?.findIndex(g => g.id === data.current_group_id) + 1 || 1,
        is_complete: group.status === 'completed',
      }
    })() : null,
    current_task: null,
    states: data.groups?.map((group) => {
      const tasks = reconstructTasksFromItems(group.items)
      return {
        id: group.id,
        title: group.label,
        type: resolveStateType(group),
        description: group.description || '',
        status: group.status as StateStatus,
        is_current: group.is_current,
        completed_at: group.completed_at || undefined,
        transitions: normalizeTransitions(group),
        tasks: tasks,
      }
    }) || [],
    tasks_summary: {
      total_tasks: data.groups?.reduce((sum, g) => {
        const taskIds = new Set(g.items?.map(i => i.metadata?.task_id || 'default') || [])
        return sum + taskIds.size
      }, 0) || 0,
      completed_tasks: data.groups?.reduce((sum, g) => {
        const tasks = reconstructTasksFromItems(g.items)
        return sum + tasks.filter(t => t.status === 'completed').length
      }, 0) || 0,
      pending_tasks: data.groups?.reduce((sum, g) => {
        const tasks = reconstructTasksFromItems(g.items)
        return sum + tasks.filter(t => t.status === 'pending').length
      }, 0) || 0,
      current_tasks: data.groups?.reduce((sum, g) => {
        const tasks = reconstructTasksFromItems(g.items)
        return sum + tasks.filter(t => t.status === 'in_progress').length
      }, 0) || 0,
    },
    conversation_age_minutes: data.elapsed_minutes || 0,
    last_updated: data.last_updated || new Date().toISOString(),
    last_transition: data.metadata?.last_transition || null,
    // Only companion agents send this. Its presence is what tells the UI to ask
    // "is an activity running?" instead of assuming a plan is always there.
    companion: data.metadata?.companion,
  } as TodoList
}
