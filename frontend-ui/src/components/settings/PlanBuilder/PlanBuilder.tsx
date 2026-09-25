import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useThemeStore } from '../../../store/themeStore'
import { useToastStore } from '../../../store/toastStore'
import { apiClient } from '../../../services/ApiClient'
import type {
  PlanTemplate,
  PlanContent,
  PlanMetadata,
  PlanCanvasMetadata,
  PlanCanvasPosition,
  PlanState,
  StateTransition,
  SessionContext,
  AgentSpawnMode,
  EndNodeConfig,
  PlanTask,
  PlanDeliverable,
} from '../../../lib/api-types'
import PlanStateEditor from './PlanStateEditor'
import PlanTransitionEditor from './PlanTransitionEditor'
import PlanStartEditor from './PlanStartEditor'
import PlanEndEditor from './PlanEndEditor'
import PlanJsonViewer from './PlanJsonViewer'
import PlanCanvas from './PlanCanvas'
import { getDefaultStatePosition } from './planCanvasLayout'
import {
  DEFAULT_JOIN_MESSAGE,
  DEFAULT_LEFT_MESSAGE,
  extractParticipantEventConfig,
} from './participantEventConfig'

interface PlanBuilderProps {
  template?: PlanTemplate
  onSave: (template: PlanTemplate) => void
  onCancel: () => void
  onBack?: () => void
  isFromGenerator?: boolean
  onContentChange?: () => void  // Called when content is modified
}

type PlanStateWithLegacyType = Omit<PlanState, 'type'> & {
  type?: PlanState['type'] | 'strict' | 'loose'
}

const createEmptyState = (): PlanState => ({
  id: crypto.randomUUID(),
  title: '',
  // Migration: UI now stores "flexible" instead of legacy "loose"
  type: 'flexible',
  tasks: [],
})

const normalizeStateType = (type: unknown): PlanState['type'] => {
  if (type === 'sequential' || type === 'goal' || type === 'flexible') return type
  if (type === 'strict') return 'sequential' // Backward compatibility for legacy plans
  if (type === 'loose') return 'flexible' // Backward compatibility for legacy plans
  return 'flexible'
}

const normalizeTransitionsForStateType = (state: PlanState): PlanState => {
  if (!state.transitions?.length) return state
  if (state.type === 'goal') {
    return {
      ...state,
      transitions: state.transitions.map((transition) =>
        transition.condition_type === 'all_tasks_complete'
          ? { ...transition, condition_type: 'goal_achieved', condition_config: undefined }
          : transition
      ),
    }
  }
  return {
    ...state,
    transitions: state.transitions.map((transition) =>
      transition.condition_type === 'goal_achieved'
        ? { ...transition, condition_type: 'all_tasks_complete', condition_config: undefined }
        : transition
    ),
  }
}

// Migration: normalize persisted/imported legacy state types for editor safety.
const normalizePlanStates = (inputStates: PlanStateWithLegacyType[]): PlanState[] =>
  inputStates.map((state) =>
    normalizeTransitionsForStateType({
      ...state,
      type: normalizeStateType(state.type),
    } as PlanState)
  )

const ensureEndTransitionsForCanvasConnections = (
  inputStates: PlanState[],
  metadata: PlanMetadata | undefined,
): PlanState[] => {
  const canvas = extractCanvasMetadata(metadata)
  const endStateIds = new Set(canvas.end_state_ids || [])
  if (endStateIds.size === 0) return inputStates

  return inputStates.map((state) => {
    if (!endStateIds.has(state.id)) return state
    const transitions = state.transitions || []
    const hasEndTransition = transitions.some((transition) => transition.target_state_id === '__end__')
    if (hasEndTransition) return state

    return {
      ...state,
      transitions: [
        ...transitions,
        {
          target_state_id: '__end__',
          condition_type: 'all_tasks_complete',
          priority: transitions.length,
        },
      ],
    }
  })
}

const createEmptyTask = (): PlanTask => ({
  id: crypto.randomUUID(),
  description: '',
  required: true,
  deliverables: [],
})

const createEmptyDeliverable = (): PlanDeliverable => ({
  key: `deliverable_${crypto.randomUUID().slice(0, 8)}`, // Keep short for readability
  description: '',
  type: 'string',
  required: true,
})

const parseNodePositions = (value: unknown): Record<string, PlanCanvasPosition> => {
  const parsed: Record<string, PlanCanvasPosition> = {}
  if (!value || typeof value !== 'object') return parsed

  for (const [stateId, position] of Object.entries(value)) {
    if (
      position &&
      typeof position === 'object' &&
      typeof (position as { x?: unknown }).x === 'number' &&
      typeof (position as { y?: unknown }).y === 'number'
    ) {
      parsed[stateId] = {
        x: (position as { x: number }).x,
        y: (position as { y: number }).y,
      }
    }
  }

  return parsed
}

const extractNodePositions = (metadata: PlanMetadata | undefined): Record<string, PlanCanvasPosition> =>
  parseNodePositions(metadata?.nodePositions)

const stripLegacyCanvasStatePositions = (canvas: unknown): Record<string, unknown> => {
  if (!canvas || typeof canvas !== 'object') return {}
  const { state_positions: _legacyStatePositions, ...rest } = canvas as Record<string, unknown>
  return rest
}

const extractCanvasMetadata = (metadata: PlanMetadata | undefined): PlanCanvasMetadata => {
  const planBuilder = metadata?.plan_builder
  if (!planBuilder || typeof planBuilder !== 'object') return {}

  const canvas = planBuilder.canvas
  if (!canvas || typeof canvas !== 'object') return {}

  const rawEndStateIds = canvas.end_state_ids
  const parsedEndStateIds = Array.isArray(rawEndStateIds)
    ? rawEndStateIds.filter((value): value is string => typeof value === 'string')
    : undefined

  const endNodePosition = canvas.end_node_position
  const parsedEndNodePosition =
    endNodePosition &&
    typeof endNodePosition === 'object' &&
    typeof (endNodePosition as { x?: unknown }).x === 'number' &&
    typeof (endNodePosition as { y?: unknown }).y === 'number'
      ? {
          x: (endNodePosition as { x: number }).x,
          y: (endNodePosition as { y: number }).y,
        }
      : undefined

  // Validate end_node_config shape to guard against stale/corrupted persisted values.
  const rawEndNodeConfig = canvas.end_node_config
  const parsedEndNodeConfig =
    rawEndNodeConfig && typeof rawEndNodeConfig === 'object'
      ? {
          farewell_message: typeof (rawEndNodeConfig as { farewell_message?: unknown }).farewell_message === 'string'
            ? (rawEndNodeConfig as { farewell_message: string }).farewell_message
            : undefined,
          summary_behavior: (['none', 'brief', 'full'] as const).includes(
            (rawEndNodeConfig as { summary_behavior?: unknown }).summary_behavior as 'none' | 'brief' | 'full'
          )
            ? (rawEndNodeConfig as { summary_behavior: 'none' | 'brief' | 'full' }).summary_behavior
            : undefined,
        }
      : undefined

  return {
    show_end_node: canvas.show_end_node === true,
    end_node_position: parsedEndNodePosition,
    end_state_ids: parsedEndStateIds,
    end_node_config: parsedEndNodeConfig,
  }
}

const extractSpawnMode = (metadata: PlanMetadata | undefined): AgentSpawnMode => {
  const mode = metadata?.plan_builder?.start?.agent_spawn_mode
  return mode === 'on_demand' ? 'on_demand' : 'immediate'
}

interface SelectedTransition {
  sourceStateId: string
  transitionIndex: number
}

interface TransitionRef {
  sourceStateId: string
  transitionIndex: number
}

const normalizeTransitionValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    const values = value.filter((item): item is string | number | boolean =>
      typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
    )
    return `array:${values.map(String).sort().join(',')}`
  }
  if (typeof value === 'string') return `string:${value}`
  if (typeof value === 'number') return `number:${String(value)}`
  if (typeof value === 'boolean') return `boolean:${String(value)}`
  return 'undefined:'
}

const getConditionSignature = (transition: StateTransition): string => {
  const config = transition.condition_config || {}
  const key = typeof config.key === 'string' ? config.key : ''
  const valueSignature = normalizeTransitionValue((config as Record<string, unknown>).value)
  return `${transition.condition_type}|${key}|${valueSignature}`
}

const isTransitionConditionIncomplete = (transition: StateTransition): boolean => {
  const config = transition.condition_config || {}
  const key = typeof config.key === 'string' ? config.key.trim() : ''
  if (transition.condition_type === 'goal_achieved') {
    return false
  }
  if (transition.condition_type === 'deliverable_exists') {
    return key.length === 0
  }
  if (transition.condition_type === 'deliverable_value') {
    if (key.length === 0) return true
    const rawValue = (config as Record<string, unknown>).value
    if (Array.isArray(rawValue)) return rawValue.length === 0
    if (typeof rawValue === 'string') return rawValue.trim().length === 0
    if (typeof rawValue === 'number' || typeof rawValue === 'boolean') return false
    return true
  }
  return false
}

const getLayoutStateOrder = (states: PlanState[], initialStateId: string | null): string[] => {
  if (states.length === 0) return []

  const stateIds = new Set(states.map((state) => state.id))
  const adjacency = new Map<string, string[]>()
  const incomingCount = new Map<string, number>()

  for (const state of states) {
    incomingCount.set(state.id, 0)
  }

  for (const state of states) {
    const targets = (state.transitions || [])
      .map((transition) => transition.target_state_id)
      .filter((targetId) => stateIds.has(targetId))

    adjacency.set(state.id, targets)

    for (const targetId of targets) {
      incomingCount.set(targetId, (incomingCount.get(targetId) || 0) + 1)
    }
  }

  const queue: string[] = []
  const validInitial = initialStateId && stateIds.has(initialStateId) ? initialStateId : null
  if (validInitial) {
    queue.push(validInitial)
  } else {
    const noIncoming = states
      .filter((state) => (incomingCount.get(state.id) || 0) === 0)
      .map((state) => state.id)
    queue.push(noIncoming[0] || states[0].id)
  }

  const ordered: string[] = []
  const visited = new Set<string>()

  while (queue.length > 0) {
    const stateId = queue.shift()
    if (!stateId || visited.has(stateId)) continue
    visited.add(stateId)
    ordered.push(stateId)

    for (const targetId of adjacency.get(stateId) || []) {
      if (!visited.has(targetId)) queue.push(targetId)
    }
  }

  for (const state of states) {
    if (!visited.has(state.id)) ordered.push(state.id)
  }

  return ordered
}

const buildAutoLayoutPositions = (
  states: PlanState[],
  initialStateId: string | null
): Record<string, PlanCanvasPosition> => {
  const orderedStateIds = getLayoutStateOrder(states, initialStateId)
  return orderedStateIds.reduce<Record<string, PlanCanvasPosition>>((acc, stateId, index) => {
    acc[stateId] = getDefaultStatePosition(index)
    return acc
  }, {})
}

const resolveStatePositions = (
  states: PlanState[],
  initialStateId: string | null,
  explicitPositions: Record<string, PlanCanvasPosition>
): Record<string, PlanCanvasPosition> => {
  const autoPositions = buildAutoLayoutPositions(states, initialStateId)
  return states.reduce<Record<string, PlanCanvasPosition>>((acc, state) => {
    acc[state.id] = explicitPositions[state.id] || autoPositions[state.id] || getDefaultStatePosition(0)
    return acc
  }, {})
}

interface PlanImportValidationResult {
  errors: string[]
  warnings: string[]
  resolvedInitialStateId: string | null
}

const validateImportedPlan = (
  states: PlanState[],
  initialStateId: string | null,
  endStateIds: Set<string> = new Set()
): PlanImportValidationResult => {
  const errors: string[] = []
  const warnings: string[] = []

  if (states.length === 0) {
    errors.push('Plan has no states.')
    return { errors, warnings, resolvedInitialStateId: null }
  }

  const seenStateIds = new Set<string>()
  for (const state of states) {
    if (!state.id || typeof state.id !== 'string') {
      errors.push('Every state must have a valid string id.')
      continue
    }
    if (seenStateIds.has(state.id)) {
      errors.push(`Duplicate state id "${state.id}".`)
      continue
    }
    seenStateIds.add(state.id)
  }

  const resolvedInitialStateId =
    initialStateId && seenStateIds.has(initialStateId) ? initialStateId : states[0]?.id || null

  if (initialStateId && !seenStateIds.has(initialStateId)) {
    warnings.push(`Initial state "${initialStateId}" was not found. Start was reset to "${resolvedInitialStateId}".`)
  }

  for (const endStateId of endStateIds) {
    if (!seenStateIds.has(endStateId)) {
      errors.push(`End node connection references missing state "${endStateId}".`)
    }
  }

  const adjacency = new Map<string, string[]>()
  const incomingCount = new Map<string, number>()
  for (const state of states) incomingCount.set(state.id, 0)

  for (const state of states) {
    const transitions = state.transitions || []
    if (!Array.isArray(transitions)) {
      errors.push(`State "${state.id}" has an invalid transitions value.`)
      continue
    }
    if (transitions.length === 0 && !endStateIds.has(state.id)) {
      warnings.push(`State "${state.id}" has no outgoing transitions.`)
    }

    const targets: string[] = []
    transitions.forEach((transition, index) => {
      if (!transition || typeof transition !== 'object') {
        errors.push(`State "${state.id}" has an invalid transition at index ${index}.`)
        return
      }
      if (!transition.target_state_id || typeof transition.target_state_id !== 'string') {
        errors.push(`State "${state.id}" has a transition missing "target_state_id" at index ${index}.`)
        return
      }
      if (!transition.condition_type || typeof transition.condition_type !== 'string') {
        errors.push(`State "${state.id}" has a transition missing "condition_type" at index ${index}.`)
      }
      if (!seenStateIds.has(transition.target_state_id)) {
        errors.push(
          `State "${state.id}" transitions to missing state "${transition.target_state_id}" at index ${index}.`
        )
        return
      }
      targets.push(transition.target_state_id)
      incomingCount.set(
        transition.target_state_id,
        (incomingCount.get(transition.target_state_id) || 0) + 1
      )
    })
    adjacency.set(state.id, targets)
  }

  const orphanStates = states
    .map((state) => state.id)
    .filter((stateId) => stateId !== resolvedInitialStateId && (incomingCount.get(stateId) || 0) === 0)
  if (orphanStates.length > 0) {
    warnings.push(`Orphaned state(s) with no incoming transitions: ${orphanStates.join(', ')}.`)
  }

  const reachable = new Set<string>()
  const queue: string[] = resolvedInitialStateId ? [resolvedInitialStateId] : []
  while (queue.length > 0) {
    const stateId = queue.shift()
    if (!stateId || reachable.has(stateId)) continue
    reachable.add(stateId)
    for (const targetId of adjacency.get(stateId) || []) {
      if (!reachable.has(targetId)) queue.push(targetId)
    }
  }

  const unreachableStates = states
    .map((state) => state.id)
    .filter((stateId) => !reachable.has(stateId))
  if (unreachableStates.length > 0) {
    warnings.push(`Unreachable state(s) from start: ${unreachableStates.join(', ')}.`)
  }

  return { errors, warnings, resolvedInitialStateId }
}

export default function PlanBuilder({ template, onSave, onCancel, onBack, isFromGenerator, onContentChange }: PlanBuilderProps) {
  const { resolvedTheme } = useThemeStore()
  const { addToast } = useToastStore()
  const isDark = resolvedTheme === 'dark'
  const fileInputRef = useRef<HTMLInputElement>(null)
  const initialMetadata = template?.content.metadata || {}
  const initialStates = ensureEndTransitionsForCanvasConnections(
    normalizePlanStates(template?.content.states || []),
    initialMetadata,
  )

  const [name, setName] = useState(template?.name || '')
  const [description, setDescription] = useState(template?.description || '')
  const [systemPrompt, setSystemPrompt] = useState(template?.content.system_prompt || '')
  const [planLanguage, setPlanLanguage] = useState(template?.content.language || '')
  const [sessionContext, setSessionContext] = useState<SessionContext>(template?.content.session_context || { fields: [] })
  const [agentSpawnMode, setAgentSpawnMode] = useState<AgentSpawnMode>(extractSpawnMode(template?.content.metadata))
  const [onParticipantJoin, setOnParticipantJoin] = useState(
    extractParticipantEventConfig(template?.content.metadata?.plan_builder?.start?.on_participant_join, 'on_participant_join')
  )
  const [onParticipantLeft, setOnParticipantLeft] = useState(
    extractParticipantEventConfig(template?.content.metadata?.plan_builder?.start?.on_participant_left, 'on_participant_left')
  )
  const [states, setStates] = useState<PlanState[]>(initialStates)
  const [initialStateId, setInitialStateId] = useState<string | null>(
    template?.content.initial_state_id || template?.content.states?.[0]?.id || null
  )
  const [metadata, setMetadata] = useState<PlanMetadata>(initialMetadata)
  const [selectedStateIndex, setSelectedStateIndex] = useState<number | null>(
    template?.content.states?.length ? 0 : null
  )
  const [selectedTransition, setSelectedTransition] = useState<SelectedTransition | null>(null)
  const [selectedStartNode, setSelectedStartNode] = useState(false)
  const [selectedEndNode, setSelectedEndNode] = useState(false)
  const [xRayMode, setXRayMode] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [autoFitKey, setAutoFitKey] = useState(0)

  const isEditing = !!template?.id

  // Helper to mark content as changed
  const markChanged = () => {
    onContentChange?.()
  }

  const updateCanvasMetadata = (updater: (current: PlanCanvasMetadata) => PlanCanvasMetadata) => {
    setMetadata((prev) => {
      const currentCanvas = extractCanvasMetadata(prev)
      const nextCanvas = updater(currentCanvas)
      return {
        ...prev,
        plan_builder: {
          ...(prev.plan_builder || {}),
          canvas: nextCanvas,
        },
      }
    })
  }

  const updateNodePositions = (
    updater: (current: Record<string, PlanCanvasPosition>) => Record<string, PlanCanvasPosition>
  ) => {
    setMetadata((prev) => ({
      ...prev,
      nodePositions: updater(extractNodePositions(prev)),
    }))
  }

  const canvasMetadata = extractCanvasMetadata(metadata)
  const statePositions = extractNodePositions(metadata)
  const resolvedStatePositions = useMemo(
    () => resolveStatePositions(states, initialStateId, statePositions),
    [states, initialStateId, statePositions]
  )
  const showEndNode = canvasMetadata.show_end_node === true
  const endNodePosition = canvasMetadata.end_node_position
  const endNodeConfig: EndNodeConfig = canvasMetadata.end_node_config || {}
  const endTransitionStateIds = useMemo(
    () =>
      states
        .filter((state) => (state.transitions || []).some((transition) => transition.target_state_id === '__end__'))
        .map((state) => state.id),
    [states]
  )
  const ambiguousTransitionRefs = useMemo<TransitionRef[]>(() => {
    const refs: TransitionRef[] = []
    for (const state of states) {
      const groups = new Map<string, number[]>()
      ;(state.transitions || []).forEach((transition, transitionIndex) => {
        const signature = getConditionSignature(transition)
        const indices = groups.get(signature) || []
        indices.push(transitionIndex)
        groups.set(signature, indices)
      })
      for (const indices of groups.values()) {
        if (indices.length < 2) continue
        for (const transitionIndex of indices) {
          refs.push({ sourceStateId: state.id, transitionIndex })
        }
      }
    }
    return refs
  }, [states])
  const ambiguousTransitionIdSet = useMemo(
    () => new Set(ambiguousTransitionRefs.map((ref) => `${ref.sourceStateId}__${ref.transitionIndex}`)),
    [ambiguousTransitionRefs]
  )
  const incompleteTransitionRefs = useMemo<TransitionRef[]>(() => {
    const refs: TransitionRef[] = []
    for (const state of states) {
      ;(state.transitions || []).forEach((transition, transitionIndex) => {
        if (isTransitionConditionIncomplete(transition)) {
          refs.push({ sourceStateId: state.id, transitionIndex })
        }
      })
    }
    return refs
  }, [states])
  const incompleteTransitionIdSet = useMemo(
    () => new Set(incompleteTransitionRefs.map((ref) => `${ref.sourceStateId}__${ref.transitionIndex}`)),
    [incompleteTransitionRefs]
  )
  const transitionIssueIdSet = useMemo(() => {
    const ids = new Set<string>(ambiguousTransitionIdSet)
    for (const id of incompleteTransitionIdSet) ids.add(id)
    return ids
  }, [ambiguousTransitionIdSet, incompleteTransitionIdSet])
  const buildContent = (): PlanContent => ({
    states: states.map((state) => normalizeTransitionsForStateType(state)),
    ...(initialStateId ? { initial_state_id: initialStateId } : {}),
    ...(sessionContext.fields.length > 0 ? { session_context: sessionContext } : {}),
    metadata: {
      ...metadata,
      nodePositions: resolvedStatePositions,
      plan_builder: {
        ...(metadata.plan_builder || {}),
        start: {
          ...(metadata.plan_builder?.start || {}),
          agent_spawn_mode: agentSpawnMode,
          on_participant_join: onParticipantJoin,
          on_participant_left: onParticipantLeft,
        },
        canvas: {
          ...stripLegacyCanvasStatePositions(metadata.plan_builder?.canvas),
          ...canvasMetadata,
          end_state_ids: endTransitionStateIds,
        },
      },
    },
    ...(systemPrompt.trim() ? { system_prompt: systemPrompt.trim() } : {}),
    ...(planLanguage.trim() ? { language: planLanguage.trim().toLowerCase() } : {}),
  })

  const handleAddState = () => {
    const newState = createEmptyState()
    const newIndex = states.length

    setStates((prev) => [...prev, newState])
    setSelectedStateIndex(newIndex)
    setSelectedTransition(null)
    setSelectedStartNode(false)
    setInitialStateId((current) => current || newState.id)

    updateNodePositions((current) => ({
      ...current,
      [newState.id]: getDefaultStatePosition(newIndex),
    }))

    setAutoFitKey((prev) => prev + 1)
    markChanged()
  }

  const handleUpdateState = (index: number, updated: PlanState) => {
    const normalized = normalizeTransitionsForStateType(updated)
    setStates((prev) => prev.map((s, i) => (i === index ? normalized : s)))
    markChanged()
  }

  const handleDeleteState = (index: number) => {
    const stateToDelete = states[index]
    if (!stateToDelete) return

    const nextStates = states
      .filter((_, i) => i !== index)
      .map((state) => ({
        ...state,
        transitions: state.transitions?.filter((transition) => transition.target_state_id !== stateToDelete.id),
      }))

    setStates(nextStates)
    if (initialStateId === stateToDelete.id) {
      setInitialStateId(nextStates[0]?.id || null)
    }

    if (selectedStateIndex === index) {
      setSelectedStateIndex(states.length > 1 ? Math.max(0, index - 1) : null)
    } else if (selectedStateIndex !== null && selectedStateIndex > index) {
      setSelectedStateIndex(selectedStateIndex - 1)
    }

    updateNodePositions((current) => {
      const nextPositions = { ...current }
      delete nextPositions[stateToDelete.id]
      return nextPositions
    })
    updateCanvasMetadata((current) => ({
      ...current,
      end_state_ids: (current.end_state_ids || []).filter((stateId) => stateId !== stateToDelete.id),
    }))

    setSelectedTransition((current) => {
      if (!current) return current
      if (current.sourceStateId === stateToDelete.id) return null
      const sourceState = nextStates.find((state) => state.id === current.sourceStateId)
      if (!sourceState) return null
      const stillExists = sourceState.transitions?.[current.transitionIndex]
      return stillExists ? current : null
    })

    markChanged()
  }

  const handleDeleteStateById = (stateId: string) => {
    const index = states.findIndex((state) => state.id === stateId)
    if (index >= 0) {
      handleDeleteState(index)
    }
  }

  const handleSelectStateById = (stateId: string) => {
    const index = states.findIndex((state) => state.id === stateId)
    setSelectedStateIndex(index >= 0 ? index : null)
    setSelectedTransition(null)
    setSelectedStartNode(false)
    setSelectedEndNode(false)
  }

  const handleCreateTransition = (sourceStateId: string, targetStateId: string) => {
    const sourceState = states.find((state) => state.id === sourceStateId)
    if (!sourceState) return
    const defaultConditionType = sourceState.type === 'goal' ? 'goal_achieved' : 'all_tasks_complete'
    const createsAmbiguousDefault = (sourceState.transitions || []).some(
      (transition) => transition.condition_type === defaultConditionType
    )

    const nextTransition: StateTransition = {
      target_state_id: targetStateId,
      condition_type: defaultConditionType,
      priority: sourceState.transitions?.length ?? 0,
    }

    setStates((prev) =>
      prev.map((state) =>
        state.id === sourceStateId
          ? { ...state, transitions: [...(state.transitions || []), nextTransition] }
          : state
      )
    )

    setSelectedStateIndex(null)
    setSelectedTransition({
      sourceStateId,
      transitionIndex: sourceState.transitions?.length ?? 0,
    })
    if (createsAmbiguousDefault) {
      addToast({
        message: `Ambiguous route: "${sourceState.title || 'Untitled state'}" has multiple "${defaultConditionType.replace(/_/g, ' ')}" transitions.`,
        type: 'info',
      })
    }
    markChanged()
  }

  const handleSelectTransition = (sourceStateId: string, transitionIndex: number) => {
    setSelectedStateIndex(null)
    setSelectedTransition({ sourceStateId, transitionIndex })
    setSelectedStartNode(false)
    setSelectedEndNode(false)
  }

  const handleSelectStartNode = () => {
    setSelectedStateIndex(null)
    setSelectedTransition(null)
    setSelectedStartNode(true)
    setSelectedEndNode(false)
  }

  // Selects the End node, deselecting everything else so the sidebar shows PlanEndEditor.
  const handleSelectEndNode = () => {
    setSelectedStateIndex(null)
    setSelectedTransition(null)
    setSelectedStartNode(false)
    setSelectedEndNode(true)
  }

  const handleEndNodeConfigChange = (config: EndNodeConfig) => {
    updateCanvasMetadata((current) => ({ ...current, end_node_config: config }))
    markChanged()
  }

  const handleInitialStateChange = (stateId: string) => {
    const exists = states.some((state) => state.id === stateId)
    if (!exists) return
    setInitialStateId(stateId)
    markChanged()
  }

  const handleConnectEndState = (sourceStateId: string) => {
    const sourceState = states.find((state) => state.id === sourceStateId)
    if (!sourceState) return

    // Record in canvas metadata so the End node edge is rendered
    updateCanvasMetadata((current) => {
      const existing = current.end_state_ids || []
      if (existing.includes(sourceStateId)) return current
      return {
        ...current,
        end_state_ids: [...existing, sourceStateId],
      }
    })

    // Also write the actual transition into the plan so the backend can act on it.
    // Without this the connection is purely cosmetic — the state machine never sees __end__.
    setStates((prev) =>
      prev.map((state) =>
        state.id === sourceStateId
          ? {
              ...state,
              transitions: [
                ...(state.transitions || []),
                {
                  target_state_id: '__end__',
                  condition_type: 'all_tasks_complete' as const,
                  priority: state.transitions?.length ?? 0,
                },
              ],
            }
          : state
      )
    )

    markChanged()
  }

  const handleDeleteTransitions = (transitionRefs: TransitionRef[]) => {
    if (transitionRefs.length === 0) return

    const grouped = transitionRefs.reduce<Record<string, number[]>>((acc, ref) => {
      if (!acc[ref.sourceStateId]) acc[ref.sourceStateId] = []
      acc[ref.sourceStateId].push(ref.transitionIndex)
      return acc
    }, {})

    Object.values(grouped).forEach((indices) => indices.sort((a, b) => b - a))

    setStates((prev) =>
      prev.map((state) => {
        const indices = grouped[state.id]
        if (!indices || indices.length === 0) return state

        const transitions = [...(state.transitions || [])]
        for (const index of indices) {
          if (index >= 0 && index < transitions.length) {
            transitions.splice(index, 1)
          }
        }
        return { ...state, transitions }
      })
    )

    setSelectedTransition((current) => {
      if (!current) return current
      const deleted = transitionRefs.some(
        (ref) =>
          ref.sourceStateId === current.sourceStateId &&
          ref.transitionIndex === current.transitionIndex
      )
      return deleted ? null : current
    })

    markChanged()
  }

  const handleUpdateTransition = (updatedTransition: StateTransition) => {
    if (!selectedTransition) return
    setStates((prev) =>
      prev.map((state) => {
        if (state.id !== selectedTransition.sourceStateId) return state
        const transitions = [...(state.transitions || [])]
        if (!transitions[selectedTransition.transitionIndex]) return state
        transitions[selectedTransition.transitionIndex] = updatedTransition
        return { ...state, transitions }
      })
    )
    markChanged()
  }

  const handleDeleteTransition = () => {
    if (!selectedTransition) return

    setStates((prev) =>
      prev.map((state) => {
        if (state.id !== selectedTransition.sourceStateId) return state
        return {
          ...state,
          transitions: (state.transitions || []).filter((_, index) => index !== selectedTransition.transitionIndex),
        }
      })
    )
    setSelectedTransition(null)
    markChanged()
  }

  const handleStatePositionChange = (stateId: string, position: PlanCanvasPosition) => {
    updateNodePositions((current) => ({
      ...current,
      [stateId]: position,
    }))
    markChanged()
  }

  const handleEndNodePositionChange = (position: PlanCanvasPosition) => {
    updateCanvasMetadata((current) => ({
      ...current,
      end_node_position: position,
    }))
    markChanged()
  }

  const handleToggleEndNode = () => {
    updateCanvasMetadata((current) => ({
      ...current,
      show_end_node: !showEndNode,
    }))
    if (showEndNode) setSelectedEndNode(false)
    setAutoFitKey((prev) => prev + 1)
    markChanged()
  }

  const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const content = JSON.parse(e.target?.result as string) as PlanContent
        if (!content.states || !Array.isArray(content.states)) {
          throw new Error('Invalid plan structure')
        }

        const importedMetadata = (content.metadata as PlanMetadata) || {}
        const normalizedStates = ensureEndTransitionsForCanvasConnections(
          normalizePlanStates(content.states as PlanStateWithLegacyType[]),
          importedMetadata,
        )
        const importedCanvasMetadata = extractCanvasMetadata(importedMetadata)
        const importedEndStateIdSet = new Set(importedCanvasMetadata.end_state_ids || [])
        const importInitialStateId = content.initial_state_id || normalizedStates[0]?.id || null
        const validation = validateImportedPlan(
          normalizedStates,
          importInitialStateId,
          importedEndStateIdSet
        )
        if (validation.errors.length > 0) {
          addToast({ message: validation.errors[0], type: 'error' })
          if (validation.errors.length > 1) {
            addToast({
              message: `Import failed with ${validation.errors.length} validation errors.`,
              type: 'error',
            })
          }
          return
        }

        const importedPositions = extractNodePositions(importedMetadata)
        const hadExplicitPositions = Object.keys(importedPositions).length > 0
        const nextStatePositions = resolveStatePositions(
          normalizedStates,
          validation.resolvedInitialStateId,
          importedPositions
        )
        const nextMetadata: PlanMetadata = {
          ...importedMetadata,
          nodePositions: nextStatePositions,
          plan_builder: {
            ...(importedMetadata.plan_builder || {}),
            canvas: {
              ...stripLegacyCanvasStatePositions(importedMetadata.plan_builder?.canvas),
              ...importedCanvasMetadata,
            },
          },
        }


        setStates(normalizedStates)
        setSelectedStateIndex(normalizedStates.length > 0 ? 0 : null)
        setSelectedTransition(null)
        setSelectedStartNode(false)
        setInitialStateId(validation.resolvedInitialStateId)
        setSystemPrompt(content.system_prompt || '')
        setPlanLanguage(content.language || '')
        setSessionContext(content.session_context || { fields: [] })
        setAgentSpawnMode(extractSpawnMode(importedMetadata))
        setOnParticipantJoin(extractParticipantEventConfig(
          importedMetadata?.plan_builder?.start?.on_participant_join,
          'on_participant_join',
        ))
        setOnParticipantLeft(extractParticipantEventConfig(
          importedMetadata?.plan_builder?.start?.on_participant_left,
          'on_participant_left',
        ))
        setMetadata(nextMetadata)
        setAutoFitKey((prev) => prev + 1)

        if (!hadExplicitPositions) {
          addToast({ message: 'No node positions found. Auto-layout applied.', type: 'info' })
        }
        if (validation.warnings.length > 0) {
          addToast({
            message: `Imported with ${validation.warnings.length} warning(s): ${validation.warnings[0]}`,
            type: 'info',
          })
        }
        markChanged()
        addToast({ message: 'Plan imported successfully', type: 'success' })
      } catch {
        addToast({ message: 'Failed to parse JSON file', type: 'error' })
      }
    }
    reader.readAsText(file)
    event.target.value = ''
  }

  const handleExport = () => {
    const content = buildContent()
    const json = JSON.stringify(content, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name || 'plan'}-template.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleSave = async () => {
    if (!name.trim()) {
      addToast({ message: 'Please enter a plan name', type: 'error' })
      return
    }

    if (states.length === 0) {
      addToast({ message: 'Please add at least one state', type: 'error' })
      return
    }

    const startConnected = !!initialStateId && states.some((state) => state.id === initialStateId)
    if (!startConnected) {
      addToast({ message: 'Please connect Start to a state', type: 'error' })
      return
    }

    if (transitionIssueIdSet.size > 0) {
      addToast({
        message: `Please resolve ${transitionIssueIdSet.size} transition condition issue(s) before saving.`,
        type: 'error',
      })
      return
    }

    const endConnectedSet = new Set(showEndNode ? endTransitionStateIds : [])
    const statesWithoutOutgoing = states.filter(
      (state) => (state.transitions?.length ?? 0) === 0 && !endConnectedSet.has(state.id)
    )
    if (statesWithoutOutgoing.length > 0) {
      const sampleTitles = statesWithoutOutgoing
        .slice(0, 3)
        .map((state) => state.title || 'Untitled state')
        .join(', ')
      const suffix = statesWithoutOutgoing.length > 3 ? ', ...' : ''
      addToast({
        message: `${statesWithoutOutgoing.length} state(s) have no outgoing transition and will end the conversation (${sampleTitles}${suffix}).`,
        type: 'info',
      })
    }

    setIsSaving(true)
    try {
      const content = buildContent()
      let saved: PlanTemplate

      if (isEditing) {
        saved = await apiClient.updatePlanTemplate(template!.id, {
          name: name.trim(),
          description: description.trim() || undefined,
          content,
        })
        addToast({ message: 'Plan template updated', type: 'success' })
      } else {
        saved = await apiClient.createPlanTemplate({
          name: name.trim(),
          description: description.trim() || undefined,
          content,
        })
        addToast({ message: 'Plan template created', type: 'success' })
      }

      onSave(saved)
    } catch (err) {
      addToast({
        message: err instanceof Error ? err.message : 'Failed to save template',
        type: 'error',
      })
    } finally {
      setIsSaving(false)
    }
  }

  useEffect(() => {
    if (states.length === 0) {
      setInitialStateId(null)
      return
    }
    if (!initialStateId || !states.some((state) => state.id === initialStateId)) {
      setInitialStateId(states[0].id)
    }
  }, [states, initialStateId])

  useEffect(() => {
    if (!selectedTransition) return
    const sourceState = states.find((state) => state.id === selectedTransition.sourceStateId)
    if (!sourceState) {
      setSelectedTransition(null)
      return
    }
    if (!sourceState.transitions?.[selectedTransition.transitionIndex]) {
      setSelectedTransition(null)
    }
  }, [selectedTransition, states])

  const selectedTransitionState = selectedTransition
    ? states.find((state) => state.id === selectedTransition.sourceStateId)
    : null
  const selectedTransitionData = selectedTransitionState?.transitions?.[selectedTransition?.transitionIndex ?? -1]
  const selectedTransitionTarget = selectedTransitionData
    ? states.find((state) => state.id === selectedTransitionData.target_state_id)
    : null
  const selectedTransitionTargetTitle = selectedTransitionData?.target_state_id === '__end__'
    ? 'End'
    : selectedTransitionTarget?.title || 'Unknown state'
  const selectedTransitionDeliverables = selectedTransitionState
    ? selectedTransitionState.type === 'goal'
      ? selectedTransitionState.goal?.deliverables || []
      : selectedTransitionState.tasks.flatMap((task) => task.deliverables)
    : []

  return (
    <div className="h-full flex flex-col">
      <div className={`px-4 py-3 border-b flex items-center gap-3 ${isDark ? 'border-zinc-700/80 bg-surface-dark' : 'border-neutral-200 bg-white'}`}>
        {onBack ? (
          <motion.button
            onClick={onBack}
            className={`p-2 rounded-xl transition-colors ${
              isDark
                ? 'text-content-inverse-secondary hover:text-content-inverse hover:bg-surface-dark-secondary'
                : 'text-content-secondary hover:text-content hover:bg-surface-secondary'
            }`}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            title="Back to AI Generator"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </motion.button>
        ) : (
          <motion.button
            onClick={onCancel}
            className={`p-2 rounded-xl transition-colors ${
              isDark
                ? 'text-content-inverse-secondary hover:text-content-inverse hover:bg-surface-dark-secondary'
                : 'text-content-secondary hover:text-content hover:bg-surface-secondary'
            }`}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </motion.button>
        )}

        <div className="flex items-center gap-3">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isDark ? 'bg-primary-500/10' : 'bg-primary-50'}`}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={isDark ? 'text-primary-400' : 'text-primary-600'}>
              <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
            </svg>
          </div>
          <div>
            <h2 className={`text-body-sm font-semibold ${isDark ? 'text-content-inverse' : 'text-content'}`}>
              Plan Builder
            </h2>
            <p className={`text-caption ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
              {states.length} {states.length === 1 ? 'state' : 'states'} configured
            </p>
          </div>
        </div>

        <div className="flex-1 flex gap-2.5 ml-3">
          <input
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); markChanged() }}
            placeholder="Plan name..."
            className={`flex-1 max-w-[220px] px-3 py-1.5 rounded-lg text-body-sm focus:outline-none transition-all ${
              isDark
                ? 'bg-surface-dark-secondary border border-border-dark text-content-inverse placeholder:text-content-inverse-tertiary focus:border-border-dark-secondary'
                : 'bg-surface-secondary border border-border text-content placeholder:text-content-tertiary focus:border-border-secondary'
            }`}
          />
          <input
            type="text"
            value={description}
            onChange={(e) => { setDescription(e.target.value); markChanged() }}
            placeholder="Description (optional)"
            className={`flex-1 max-w-[280px] px-3 py-1.5 rounded-lg text-body-sm focus:outline-none transition-all ${
              isDark
                ? 'bg-surface-dark-secondary border border-border-dark text-content-inverse placeholder:text-content-inverse-tertiary focus:border-border-dark-secondary'
                : 'bg-surface-secondary border border-border text-content placeholder:text-content-tertiary focus:border-border-secondary'
            }`}
          />
        </div>

        <div className="flex items-center gap-2">
          <motion.button
            onClick={() => setXRayMode(!xRayMode)}
            className={`px-3 py-1.5 rounded-lg text-body-sm font-medium transition-all ${
              xRayMode
                ? isDark ? 'bg-primary text-white' : 'bg-neutral-900 text-white'
                : isDark
                  ? 'bg-surface-dark-secondary text-content-inverse hover:bg-surface-dark-tertiary'
                  : 'bg-surface-secondary text-content hover:bg-surface-tertiary'
            }`}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            X-ray
          </motion.button>

          {/* Save Button */}
          <motion.button
            onClick={handleSave}
            disabled={isSaving}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-body-sm font-medium transition-all ${
              isDark
                ? 'bg-primary text-white shadow-lg shadow-primary/20 hover:bg-primary/90'
                : 'bg-neutral-900 text-white shadow-lg shadow-neutral-900/20 hover:bg-neutral-800'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
            whileHover={{ scale: 1.02, y: -1 }}
            whileTap={{ scale: 0.98 }}
          >
            {isSaving ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Plan'}
          </motion.button>
        </div>
      </div>

      {/* AI-Generated Banner */}
      {isFromGenerator && (
        <div className={`mx-4 mt-3 px-4 py-2.5 rounded-xl flex items-center gap-3 ${
          isDark
            ? 'bg-violet-500/10 border border-violet-500/20'
            : 'bg-neutral-100 border border-neutral-200'
          }`}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={isDark ? 'text-violet-500' : 'text-neutral-600'}>
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
          <span className={`text-body-sm ${isDark ? 'text-violet-400' : 'text-neutral-700'}`}>
            AI-generated plan — review and customize as needed
          </span>
        </div>
      )}

      <div className={`flex-1 flex overflow-hidden ${isFromGenerator ? 'mt-3' : ''}`}>
        <div className="flex-1 min-w-0">
          {xRayMode ? (
            <PlanJsonViewer content={buildContent()} />
          ) : (
            <div className="h-full flex flex-col">
              <div className={`px-6 py-3 border-b flex items-center justify-between ${
                isDark ? 'border-zinc-700/80 bg-surface-dark' : 'border-neutral-200 bg-surface'
              }`}>
                <span className={`text-[11px] font-medium tracking-wide uppercase ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                  Conversation Flow
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleToggleEndNode}
                    className={`px-2.5 py-1.5 rounded-lg text-caption font-medium transition-colors ${
                      showEndNode
                        ? isDark
                          ? 'bg-primary/20 text-primary'
                          : 'bg-neutral-200 text-neutral-900'
                        : isDark
                          ? 'bg-surface-dark-secondary text-content-inverse-secondary hover:text-content-inverse'
                          : 'bg-surface-secondary text-content-secondary hover:text-content'
                    }`}
                  >
                    {showEndNode ? 'Hide End' : 'Show End'}
                  </button>
                  <button
                    onClick={handleAddState}
                    className={`px-2.5 py-1.5 rounded-lg text-caption font-medium transition-colors ${
                      isDark
                        ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                        : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
                    }`}
                  >
                    Add State
                  </button>
                  {transitionIssueIdSet.size > 0 && (
                    <div className={`px-2.5 py-1.5 rounded-lg text-caption font-medium ${
                      isDark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-800'
                    }`}>
                      Transition issues: {transitionIssueIdSet.size}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex-1 min-h-0">
                <PlanCanvas
                  states={states}
                  initialStateId={initialStateId}
                  agentSpawnMode={agentSpawnMode}
                  selectedStateId={selectedStateIndex !== null ? states[selectedStateIndex]?.id || null : null}
                  selectedStartNode={selectedStartNode}
                  selectedEndNode={selectedEndNode}
                  selectedTransition={selectedTransition}
                  statePositions={resolvedStatePositions}
                  endNodePosition={endNodePosition}
                  showEndNode={showEndNode}
                  autoFitKey={autoFitKey}
                  isDark={isDark}
                  onSelectStart={handleSelectStartNode}
                  onSelectEnd={handleSelectEndNode}
                  onSelectState={handleSelectStateById}
                  onSelectTransition={handleSelectTransition}
                  onCreateTransition={handleCreateTransition}
                  onConnectEndState={handleConnectEndState}
                  onDeleteTransitions={handleDeleteTransitions}
                  onDeleteState={handleDeleteStateById}
                  onStatePositionChange={handleStatePositionChange}
                  onEndNodePositionChange={handleEndNodePositionChange}
                  onCanvasClick={() => {
                    setSelectedStateIndex(null)
                    setSelectedTransition(null)
                    setSelectedStartNode(false)
                    setSelectedEndNode(false)
                  }}
                />
              </div>
              <div className={`p-4 border-t shrink-0 ${isDark ? 'border-zinc-700/80 bg-surface-dark' : 'border-neutral-200 bg-surface'}`}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleImport}
                  className="hidden"
                />
                <div className="flex gap-2">
                  <motion.button
                    onClick={() => fileInputRef.current?.click()}
                    className={`flex-1 px-3 py-2 rounded-xl text-caption font-medium flex items-center justify-center gap-2 transition-colors ${
                      isDark
                        ? 'bg-surface-dark-secondary text-content-inverse-secondary hover:bg-surface-dark-tertiary hover:text-content-inverse'
                        : 'bg-surface-secondary text-content-secondary hover:bg-surface-tertiary hover:text-content'
                    }`}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    Import
                  </motion.button>
                  <motion.button
                    onClick={handleExport}
                    className={`flex-1 px-3 py-2 rounded-xl text-caption font-medium flex items-center justify-center gap-2 transition-colors ${
                      isDark
                        ? 'bg-surface-dark-secondary text-content-inverse-secondary hover:bg-surface-dark-tertiary hover:text-content-inverse'
                        : 'bg-surface-secondary text-content-secondary hover:bg-surface-tertiary hover:text-content'
                    }`}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    Export
                  </motion.button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className={`w-[440px] shrink-0 border-l overflow-hidden ${isDark ? 'border-zinc-700' : 'border-neutral-200'}`}>
          <div className="h-full flex flex-col overflow-hidden">
            <div className={`px-5 py-4 border-b shrink-0 ${isDark ? 'border-zinc-700/80' : 'border-neutral-200'}`}>
              <h3 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-neutral-800'}`}>
                {selectedStartNode ? 'Start Node' : selectedEndNode ? 'End Node' : selectedTransitionData ? 'Transition Editor' : 'State Editor'}
              </h3>
              <p className={`text-[11px] font-light mt-1 ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                {selectedStartNode
                  ? 'Configure session start settings'
                  : selectedEndNode
                  ? 'Configure conversation end behavior'
                  : selectedTransitionData
                  ? 'Click an edge to edit condition and priority'
                  : 'Click a state node to edit details'}
              </p>
            </div>

            <div className={`px-5 py-4 border-b shrink-0 ${isDark ? 'border-zinc-700/70 bg-zinc-900/20' : 'border-neutral-200 bg-neutral-50/50'}`}>
              <label className={`block text-caption font-medium mb-2 ${
                isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
              }`}>
                System Prompt
              </label>
              <textarea
                value={systemPrompt}
                onChange={(e) => { setSystemPrompt(e.target.value); markChanged() }}
                placeholder="Agent personality and high-level instructions..."
                rows={5}
                className={`w-full px-3 py-2.5 rounded-lg text-[13px] border resize-none transition-colors ${
                  isDark
                    ? 'bg-zinc-800 border-zinc-700 text-zinc-100 placeholder:text-zinc-500'
                    : 'bg-white border-neutral-200 text-neutral-900 placeholder:text-neutral-400'
                } focus:outline-none`}
              />

              <label className={`block text-caption font-medium mt-4 mb-2 ${
                isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
              }`}>
                Language
              </label>
              <input
                type="text"
                list="plan-language-suggestions"
                value={planLanguage}
                onChange={(e) => { setPlanLanguage(e.target.value); markChanged() }}
                placeholder="Auto-detect — or an ISO code, e.g. de"
                className={`w-full px-3 py-2.5 rounded-lg text-[13px] border transition-colors ${
                  isDark
                    ? 'bg-zinc-800 border-zinc-700 text-zinc-100 placeholder:text-zinc-500'
                    : 'bg-white border-neutral-200 text-neutral-900 placeholder:text-neutral-400'
                } focus:outline-none`}
              />
              {/* Suggestions only — any ISO 639-1 code Whisper supports works,
                  so this must not become a closed list that silently rejects
                  the language someone actually needs. */}
              <datalist id="plan-language-suggestions">
                <option value="de">German</option>
                <option value="en">English</option>
                <option value="fr">French</option>
                <option value="it">Italian</option>
                <option value="es">Spanish</option>
              </datalist>
              <p className={`text-[11px] font-light mt-1.5 ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                Set this whenever you know it. Left blank, the language is
                detected per utterance from a very short window — and a wrong
                guess makes Whisper translate rather than transcribe.
              </p>
            </div>

            <div className="flex-1 overflow-y-auto overflow-x-hidden">
              <AnimatePresence mode="wait">
                {selectedEndNode ? (
                  <motion.div
                    key="end-node"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.2 }}
                    className="h-full"
                  >
                    <PlanEndEditor
                      config={endNodeConfig}
                      onChange={handleEndNodeConfigChange}
                    />
                  </motion.div>
                ) : selectedStartNode ? (
                  <motion.div
                    key="start-node"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.2 }}
                    className="h-full"
                  >
                    <PlanStartEditor
                      states={states}
                      initialStateId={initialStateId}
                      spawnMode={agentSpawnMode}
                      sessionContext={sessionContext}
                      onParticipantJoin={onParticipantJoin}
                      onParticipantLeft={onParticipantLeft}
                      onInitialStateChange={handleInitialStateChange}
                      onSpawnModeChange={(mode) => { setAgentSpawnMode(mode); markChanged() }}
                      onSessionContextChange={(context) => { setSessionContext(context); markChanged() }}
                      onParticipantJoinChange={(config) => { setOnParticipantJoin(config); markChanged() }}
                      onParticipantLeftChange={(config) => { setOnParticipantLeft(config); markChanged() }}
                    />
                  </motion.div>
                ) : selectedTransitionData && selectedTransitionState ? (
                  <motion.div
                    key={`transition-${selectedTransitionState.id}-${selectedTransition?.transitionIndex ?? 0}`}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.2 }}
                    className="h-full"
                  >
                    <PlanTransitionEditor
                      sourceStateTitle={selectedTransitionState.title || 'Untitled state'}
                      sourceStateType={selectedTransitionState.type}
                      targetStateTitle={selectedTransitionTargetTitle}
                      transition={selectedTransitionData}
                      availableDeliverables={selectedTransitionDeliverables}
                      isAmbiguous={
                        !!selectedTransition &&
                        ambiguousTransitionIdSet.has(
                          `${selectedTransition.sourceStateId}__${selectedTransition.transitionIndex}`
                        )
                      }
                      isConditionIncomplete={
                        !!selectedTransition &&
                        incompleteTransitionIdSet.has(
                          `${selectedTransition.sourceStateId}__${selectedTransition.transitionIndex}`
                        )
                      }
                      onChange={handleUpdateTransition}
                      onDelete={handleDeleteTransition}
                    />
                  </motion.div>
                ) : selectedStateIndex !== null && states[selectedStateIndex] ? (
                  <motion.div
                    key={`state-${selectedStateIndex}`}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.2 }}
                    className="h-full"
                  >
                    <PlanStateEditor
                      state={states[selectedStateIndex]}
                      onChange={(updated) => handleUpdateState(selectedStateIndex, updated)}
                      onDelete={() => handleDeleteState(selectedStateIndex)}
                      createEmptyTask={createEmptyTask}
                      createEmptyDeliverable={createEmptyDeliverable}
                    />
                  </motion.div>
                ) : (
                  <motion.div
                    key="empty"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className={`h-full flex items-center justify-center text-center px-6 ${
                      isDark ? 'text-zinc-500' : 'text-neutral-400'
                    }`}
                  >
                    Select a state or transition from the canvas to edit it.
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

          </div>
        </div>
      </div>
    </div>
  )
}