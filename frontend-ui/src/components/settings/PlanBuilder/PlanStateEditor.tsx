import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useThemeStore } from '../../../store/themeStore'
import type { PlanState, PlanTask, PlanDeliverable, StateType, StateGoal } from '../../../lib/api-types'
import PlanTaskEditor from './PlanTaskEditor'
import { VariableTextArea } from '../../shared/VariableText'
import type { Persona } from '../../../lib/api-types'

interface PlanStateEditorProps {
  state: PlanState
  onChange: (state: PlanState) => void
  onDelete: () => void
  createEmptyTask: () => PlanTask
  createEmptyDeliverable: () => PlanDeliverable
  /** The author's personas, so {{persona.*}} can be offered and highlighted. */
  personas?: Persona[]
}

export default function PlanStateEditor({
  state,
  onChange,
  onDelete,
  createEmptyTask,
  createEmptyDeliverable,
  personas = [],
}: PlanStateEditorProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const [expandedTaskIndex, setExpandedTaskIndex] = useState<number | null>(null)

  const handleAddTask = () => {
    const newTask = createEmptyTask()
    onChange({
      ...state,
      tasks: [...state.tasks, newTask],
    })
    setExpandedTaskIndex(state.tasks.length)
  }

  const handleUpdateTask = (index: number, updated: PlanTask) => {
    onChange({
      ...state,
      tasks: state.tasks.map((t, i) => i === index ? updated : t),
    })
  }

  const handleDeleteTask = (index: number) => {
    onChange({
      ...state,
      tasks: state.tasks.filter((_, i) => i !== index),
    })
    if (expandedTaskIndex === index) {
      setExpandedTaskIndex(null)
    } else if (expandedTaskIndex !== null && expandedTaskIndex > index) {
      setExpandedTaskIndex(expandedTaskIndex - 1)
    }
  }

  const handleMoveTask = (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1
    if (newIndex < 0 || newIndex >= state.tasks.length) return

    const newTasks = [...state.tasks]
    const [removed] = newTasks.splice(index, 1)
    newTasks.splice(newIndex, 0, removed)
    onChange({ ...state, tasks: newTasks })

    if (expandedTaskIndex === index) {
      setExpandedTaskIndex(newIndex)
    } else if (expandedTaskIndex === newIndex) {
      setExpandedTaskIndex(index)
    }
  }

  return (
    <div className="p-6 w-full min-w-0 overflow-x-hidden">
      {/* State Header */}
      <div className="mb-6 w-full min-w-0">
        <div className="space-y-4 min-w-0">
          <div className="flex items-center gap-2 w-full min-w-0">
            <input
              type="text"
              value={state.title}
              onChange={(e) => onChange({ ...state, title: e.target.value })}
              placeholder="State name"
              className="input-field w-full min-w-0 text-heading font-semibold"
            />
            <button
              onClick={onDelete}
              className={`p-2 rounded-lg transition-colors shrink-0 ${
                isDark
                  ? 'text-red-400 hover:bg-red-500/10'
                  : 'text-red-600 hover:bg-red-50'
              }`}
              title="Delete state"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </div>
          <VariableTextArea
            value={state.description || ''}
            onChange={(v) => onChange({ ...state, description: v || undefined })}
            personas={personas}
            placeholder="State description (optional)"
            rows={2}
            className="min-w-0"
          />
          <div>
            <label className={`text-body-sm font-medium mb-2 block ${
              isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
            }`}>
              Conversation Mode
            </label>
            <select
              value={state.type}
              onChange={(e) => {
                const newType = e.target.value as StateType
                const updates: Partial<PlanState> = { type: newType }
                if (newType === 'goal' && !state.goal) {
                  updates.goal = { objective: '' }
                }
                if (newType !== 'goal') {
                  updates.goal = undefined
                }
                onChange({ ...state, ...updates })
              }}
              className="input-field w-full max-w-xs"
            >
              {/* Migration: value renamed from "loose" to "flexible" */}
              <option value="flexible">Flexible (agent decides order)</option>
              {/* Migration: value renamed from "strict" to "sequential" */}
              <option value="sequential">Sequential (tasks in order)</option>
              <option value="goal">Goal-oriented (natural conversation)</option>
            </select>
            <p className={`text-caption mt-1.5 ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
              {state.type === 'sequential' && 'Tasks are completed one at a time in order. Best for games, tutorials, guided flows.'}
              {state.type === 'flexible' && 'Agent decides which task to address next. Best for surveys and intake forms.'}
              {state.type === 'goal' && 'Agent has a natural conversation toward the goal. Tasks are invisible — it sees information gaps instead.'}
            </p>
          </div>

          {/* Goal Editor (only for goal-type states) */}
          {state.type === 'goal' && (
            <div className={`rounded-xl border p-4 space-y-3 ${
              isDark ? 'border-violet-500/30 bg-violet-500/5' : 'border-neutral-300 bg-neutral-50'
            }`}>
              <h4 className={`text-body-sm font-semibold flex items-center gap-2 ${
                isDark ? 'text-violet-400' : 'text-neutral-800'
              }`}>
                <span className="text-sm">🎯</span>
                Goal Context
              </h4>
              <div>
                <label className={`text-caption font-medium mb-1 block ${
                  isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
                }`}>
                  Objective *
                </label>
                <VariableTextArea
                  value={state.goal?.objective || ''}
                  onChange={(v) => onChange({ ...state, goal: { ...state.goal, objective: v } as StateGoal })}
                  personas={personas}
                  placeholder="What should the conversation achieve? e.g., Understand the user's current exercise routine in enough detail to recommend a program"
                  rows={2}
                />
              </div>
              <div>
                <label className={`text-caption font-medium mb-1 block ${
                  isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
                }`}>
                  Context
                </label>
                <textarea
                  value={state.goal?.context || ''}
                  onChange={(e) => onChange({ ...state, goal: { ...state.goal!, context: e.target.value || undefined } })}
                  placeholder="Background the AI needs. e.g., This is a first consultation. The user may be a beginner or experienced."
                  rows={2}
                  className="input-field w-full resize-none"
                />
              </div>
              <div>
                <label className={`text-caption font-medium mb-1 block ${
                  isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
                }`}>
                  Depth Guidance
                </label>
                <textarea
                  value={state.goal?.depth_guidance || ''}
                  onChange={(e) => onChange({ ...state, goal: { ...state.goal!, depth_guidance: e.target.value || undefined } })}
                  placeholder="How deep should the AI probe? e.g., Don't accept vague answers. If they say 'I work out sometimes', pin down specifics."
                  rows={2}
                  className="input-field w-full resize-none"
                />
              </div>
              <div>
                <label className={`text-caption font-medium mb-1 block ${
                  isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
                }`}>
                  Boundaries
                </label>
                <textarea
                  value={state.goal?.boundaries || ''}
                  onChange={(e) => onChange({ ...state, goal: { ...state.goal!, boundaries: e.target.value || undefined } })}
                  placeholder="What NOT to discuss. e.g., Don't discuss nutrition — that's covered in a later state."
                  rows={2}
                  className="input-field w-full resize-none"
                />
              </div>
              <div>
                <label className={`text-caption font-medium mb-1 block ${
                  isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
                }`}>
                  Success Description
                </label>
                <textarea
                  value={state.goal?.success_description || ''}
                  onChange={(e) => onChange({ ...state, goal: { ...state.goal!, success_description: e.target.value || undefined } })}
                  placeholder="What 'done well' looks like. e.g., You can picture their weekly routine: what they do, how often, how long."
                  rows={2}
                  className="input-field w-full resize-none"
                />
              </div>

              {/* Goal Deliverables */}
              <div className="pt-2">
                <div className="flex items-center justify-between mb-2">
                  <label className={`text-caption font-medium ${
                    isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
                  }`}>
                    Deliverables
                  </label>
                  <button
                    onClick={() => {
                      const newDel = createEmptyDeliverable()
                      onChange({
                        ...state,
                        goal: {
                          ...state.goal!,
                          deliverables: [...(state.goal?.deliverables || []), newDel],
                        },
                      })
                    }}
                    className={`text-caption flex items-center gap-1 transition-colors ${
                      isDark ? 'text-violet-400 hover:text-violet-300' : 'text-violet-600 hover:text-violet-800'
                    }`}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                    Add
                  </button>
                </div>
                {(state.goal?.deliverables || []).length === 0 ? (
                  <p className={`text-caption italic ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
                    No deliverables yet. These define what information the agent should gather.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {(state.goal?.deliverables || []).map((del, i) => (
                      <div key={del.key} className={`rounded-lg border p-3 space-y-2 ${
                        isDark ? 'border-neutral-700 bg-neutral-800/50' : 'border-neutral-200 bg-white'
                      }`}>
                        <div className="flex items-start justify-between gap-2 min-w-0">
                          <div className="flex-1 space-y-2 min-w-0">
                            <textarea
                              value={del.description}
                              onChange={(e) => {
                                const updated = [...(state.goal?.deliverables || [])]
                                updated[i] = { ...updated[i], description: e.target.value }
                                onChange({ ...state, goal: { ...state.goal!, deliverables: updated } })
                              }}
                              placeholder="What to collect (e.g., User's primary fitness goal)"
                              rows={2}
                              className="input-field w-full min-w-0 text-body-sm resize-none"
                            />
                            <div className="flex flex-wrap gap-2 items-center min-w-0">
                              <input
                                type="text"
                                value={del.key}
                                onChange={(e) => {
                                  const updated = [...(state.goal?.deliverables || [])]
                                  updated[i] = { ...updated[i], key: e.target.value }
                                  onChange({ ...state, goal: { ...state.goal!, deliverables: updated } })
                                }}
                                placeholder="key_name"
                                className="input-field w-32 shrink-0 text-caption font-mono"
                              />
                              <select
                                value={del.type}
                                onChange={(e) => {
                                  const updated = [...(state.goal?.deliverables || [])]
                                  updated[i] = { ...updated[i], type: e.target.value as any }
                                  onChange({ ...state, goal: { ...state.goal!, deliverables: updated } })
                                }}
                                className="input-field text-caption w-24 shrink-0"
                              >
                                <option value="string">String</option>
                                <option value="number">Number</option>
                                <option value="boolean">Boolean</option>
                                <option value="enum">Enum</option>
                              </select>
                              <label className="flex items-center gap-1 text-caption shrink-0 whitespace-nowrap">
                                <input
                                  type="checkbox"
                                  checked={del.required}
                                  onChange={(e) => {
                                    const updated = [...(state.goal?.deliverables || [])]
                                    updated[i] = { ...updated[i], required: e.target.checked }
                                    onChange({ ...state, goal: { ...state.goal!, deliverables: updated } })
                                  }}
                                  className="rounded"
                                />
                                Required
                              </label>
                            </div>
                          </div>
                          <button
                            onClick={() => {
                              const updated = (state.goal?.deliverables || []).filter((_, idx) => idx !== i)
                              onChange({ ...state, goal: { ...state.goal!, deliverables: updated } })
                            }}
                            className={`p-1 rounded ${isDark ? 'text-red-400 hover:bg-red-500/10' : 'text-red-600 hover:bg-red-50'}`}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                              <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Tasks Section — hidden for goal states (deliverables are on the goal) */}
      {state.type !== 'goal' && <div className={`rounded-xl border ${
        isDark ? 'border-border-dark bg-surface-dark-secondary' : 'border-border bg-white'
      }`}>
        <div className={`p-4 border-b flex items-center justify-between ${
          isDark ? 'border-border-dark' : 'border-border'
        }`}>
          <h3 className={`text-heading-sm font-semibold ${
            isDark ? 'text-content-inverse' : 'text-content'
          }`}>
            Tasks
          </h3>
          <button
            onClick={handleAddTask}
            className={`text-body-sm flex items-center gap-1 transition-colors ${
              isDark
                ? 'text-primary hover:text-primary/80'
                : 'text-neutral-700 hover:text-neutral-900'
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add Task
          </button>
        </div>

        {state.tasks.length === 0 ? (
          <div className={`p-8 text-center text-body-sm ${
            isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
          }`}>
            No tasks yet. Click "Add Task" to create one.
          </div>
        ) : (
          <div className="divide-y divide-border dark:divide-border-dark">
            <AnimatePresence>
              {state.tasks.map((task, index) => (
                <motion.div
                  key={task.id}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  {/* Task Header */}
                  <div
                    className={`flex items-center gap-3 p-4 cursor-pointer transition-colors ${
                      isDark ? 'hover:bg-surface-dark-tertiary' : 'hover:bg-surface-secondary'
                    }`}
                    onClick={() => setExpandedTaskIndex(expandedTaskIndex === index ? null : index)}
                  >
                    {/* Expand/Collapse Icon */}
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className={`transform transition-transform ${
                        expandedTaskIndex === index ? 'rotate-90' : ''
                      } ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}
                    >
                      <path d="M9 18l6-6-6-6" />
                    </svg>

                    {/* Task Info */}
                    <div className="flex-1 min-w-0">
                      <div className={`text-body-sm font-medium truncate ${
                        isDark ? 'text-content-inverse' : 'text-content'
                      }`}>
                        {task.description || `Task ${index + 1}`}
                      </div>
                      <div className={`text-caption ${
                        isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
                      }`}>
                        {task.deliverables.length} {task.deliverables.length === 1 ? 'deliverable' : 'deliverables'}
                        {!task.required && ' (optional)'}
                      </div>
                    </div>

                    {/* Reorder/Delete */}
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => handleMoveTask(index, 'up')}
                        disabled={index === 0}
                        className={`p-1 rounded ${
                          index === 0
                            ? 'opacity-30 cursor-not-allowed'
                            : isDark
                              ? 'hover:bg-surface-dark-tertiary'
                              : 'hover:bg-surface-tertiary'
                        }`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M18 15l-6-6-6 6" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleMoveTask(index, 'down')}
                        disabled={index === state.tasks.length - 1}
                        className={`p-1 rounded ${
                          index === state.tasks.length - 1
                            ? 'opacity-30 cursor-not-allowed'
                            : isDark
                              ? 'hover:bg-surface-dark-tertiary'
                              : 'hover:bg-surface-tertiary'
                        }`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleDeleteTask(index)}
                        className={`p-1 rounded ${
                          isDark
                            ? 'text-red-400 hover:bg-red-500/10'
                            : 'text-red-600 hover:bg-red-50'
                        }`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Expanded Task Editor */}
                  <AnimatePresence>
                    {expandedTaskIndex === index && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className={`border-t ${isDark ? 'border-border-dark' : 'border-border'}`}
                      >
                        <PlanTaskEditor
                            personas={personas}
                          task={task}
                          onChange={(updated) => handleUpdateTask(index, updated)}
                          createEmptyDeliverable={createEmptyDeliverable}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>}
    </div>
  )
}
