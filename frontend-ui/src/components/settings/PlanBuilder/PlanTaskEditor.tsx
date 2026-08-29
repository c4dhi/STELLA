import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useThemeStore } from '../../../store/themeStore'
import type { PlanTask, PlanDeliverable, DeliverableType } from '../../../lib/api-types'
import { VariableTextArea } from '../../shared/VariableText'
import type { Persona } from '../../../lib/api-types'

interface PlanTaskEditorProps {
  task: PlanTask
  onChange: (task: PlanTask) => void
  createEmptyDeliverable: () => PlanDeliverable
  /** The author's personas, so {{persona.*}} can be offered and highlighted. */
  personas?: Persona[]
}

export default function PlanTaskEditor({
  task,
  onChange,
  createEmptyDeliverable,
  personas = [],
}: PlanTaskEditorProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const [editingDeliverableIndex, setEditingDeliverableIndex] = useState<number | null>(null)
  const [localInputs, setLocalInputs] = useState<{ [key: string]: string }>({})

  // Helper functions for managing local input state (allows typing commas)
  const getInputKey = (deliverableKey: string, field: 'enum_values') =>
    `${deliverableKey}-${field}`

  const getLocalValue = (deliverableKey: string, field: 'enum_values', arrayValue: string[] | undefined) => {
    const key = getInputKey(deliverableKey, field)
    return localInputs[key] ?? arrayValue?.join(', ') ?? ''
  }

  const setLocalValue = (deliverableKey: string, field: 'enum_values', value: string) => {
    setLocalInputs(prev => ({ ...prev, [getInputKey(deliverableKey, field)]: value }))
  }

  const clearLocalValue = (deliverableKey: string, field: 'enum_values') => {
    setLocalInputs(prev => {
      const { [getInputKey(deliverableKey, field)]: _, ...rest } = prev
      return rest
    })
  }

  const handleAddDeliverable = () => {
    const newDeliverable = createEmptyDeliverable()
    onChange({
      ...task,
      deliverables: [...task.deliverables, newDeliverable],
    })
    setEditingDeliverableIndex(task.deliverables.length)
  }

  const handleUpdateDeliverable = (index: number, updated: PlanDeliverable) => {
    onChange({
      ...task,
      deliverables: task.deliverables.map((d, i) => i === index ? updated : d),
    })
  }

  const handleDeleteDeliverable = (index: number) => {
    onChange({
      ...task,
      deliverables: task.deliverables.filter((_, i) => i !== index),
    })
    if (editingDeliverableIndex === index) {
      setEditingDeliverableIndex(null)
    }
  }

  return (
    <div className={`p-4 ${isDark ? 'bg-surface-dark/50' : 'bg-surface-secondary/50'}`}>
      {/* Task Fields */}
      <div className="space-y-4 mb-6">
        <div>
          <label className={`text-body-sm font-medium mb-1.5 block ${
            isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
          }`}>
            Task Name
          </label>
          <input
            type="text"
            value={task.description}
            onChange={(e) => onChange({ ...task, description: e.target.value })}
            placeholder="e.g., Collect patient information"
            className="input-field w-full"
          />
        </div>

        <div>
          <label className={`text-body-sm font-medium mb-1.5 block ${
            isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
          }`}>
            Instructions (optional)
          </label>
          <VariableTextArea
            value={task.instruction || ''}
            onChange={(v) => onChange({ ...task, instruction: v || undefined })}
            personas={personas}
            placeholder="Instructions or context for this task"
            rows={2}
          />
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id={`task-required-${task.id}`}
            checked={task.required}
            onChange={(e) => onChange({ ...task, required: e.target.checked })}
            className={`w-4 h-4 rounded ${isDark ? 'border-border-dark text-primary focus:ring-primary' : 'border-neutral-300 text-neutral-900 focus:ring-neutral-400'}`}
          />
          <label
            htmlFor={`task-required-${task.id}`}
            className={`text-body-sm ${isDark ? 'text-content-inverse' : 'text-content'}`}
          >
            Required task
          </label>
        </div>
      </div>

      {/* Deliverables Section */}
      <div className={`rounded-lg border ${
        isDark ? 'border-border-dark bg-surface-dark' : 'border-border bg-white'
      }`}>
        <div className={`px-4 py-3 border-b flex items-center justify-between ${
          isDark ? 'border-border-dark' : 'border-border'
        }`}>
          <h4 className={`text-body-sm font-medium ${
            isDark ? 'text-content-inverse' : 'text-content'
          }`}>
            Deliverables
          </h4>
          <button
            onClick={handleAddDeliverable}
            className={`text-caption flex items-center gap-1 transition-colors ${
              isDark
                ? 'text-primary hover:text-primary/80'
                : 'text-neutral-700 hover:text-neutral-900'
            }`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add
          </button>
        </div>

        {task.deliverables.length === 0 ? (
          <div className={`p-6 text-center text-caption ${
            isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
          }`}>
            No deliverables. Add data points to collect.
          </div>
        ) : (
          <div className="divide-y divide-border dark:divide-border-dark">
            <AnimatePresence>
              {task.deliverables.map((deliverable, index) => (
                <motion.div
                  key={deliverable.key}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="p-3"
                >
                  {editingDeliverableIndex === index ? (
                    // Editing Mode
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className={`text-caption font-medium mb-1 block ${
                            isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
                          }`}>
                            Description
                          </label>
                          <input
                            type="text"
                            value={deliverable.description}
                            onChange={(e) => handleUpdateDeliverable(index, { ...deliverable, description: e.target.value })}
                            placeholder="e.g., Patient Name"
                            className="input-field w-full text-body-sm"
                          />
                        </div>
                        <div>
                          <label className={`text-caption font-medium mb-1 block ${
                            isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
                          }`}>
                            Type
                          </label>
                          <select
                            value={deliverable.type}
                            onChange={(e) => handleUpdateDeliverable(index, {
                              ...deliverable,
                              type: e.target.value as DeliverableType,
                              enum_values: e.target.value === 'enum' ? deliverable.enum_values || [] : undefined,
                            })}
                            className="input-field w-full text-body-sm"
                          >
                            <option value="string">Text</option>
                            <option value="number">Number</option>
                            <option value="boolean">Yes/No</option>
                            <option value="enum">Options</option>
                          </select>
                        </div>
                      </div>

                      <div>
                        <label className={`text-caption font-medium mb-1 block ${
                          isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
                        }`}>
                          Acceptance Criteria
                        </label>
                        <VariableTextArea
                          value={deliverable.acceptance_criteria || ''}
                          onChange={(v) => handleUpdateDeliverable(index, {
                            ...deliverable,
                            acceptance_criteria: v || undefined,
                          })}
                          personas={personas}
                          placeholder="What constitutes a valid answer? Include examples of good and bad answers. e.g., A specific name or nickname. Accept 'Sarah', 'Dr. Johnson'. Reject 'nobody' or 'doesn't matter'."
                          rows={3}
                        />
                        <p className={`text-caption mt-1 ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
                          Describe what a valid answer looks like, with concrete examples
                        </p>
                      </div>

                      {deliverable.type === 'enum' && (
                        <div>
                          <label className={`text-caption font-medium mb-1 block ${
                            isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
                          }`}>
                            Options (comma-separated)
                          </label>
                          <input
                            type="text"
                            value={getLocalValue(deliverable.key, 'enum_values', deliverable.enum_values)}
                            onChange={(e) => setLocalValue(deliverable.key, 'enum_values', e.target.value)}
                            onBlur={(e) => {
                              const parsed = e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                              handleUpdateDeliverable(index, { ...deliverable, enum_values: parsed })
                              clearLocalValue(deliverable.key, 'enum_values')
                            }}
                            placeholder="e.g., Option 1, Option 2, Option 3"
                            className="input-field w-full text-body-sm"
                          />
                        </div>
                      )}

                      <div className="flex items-center justify-end">
                        <div className="flex gap-1">
                          <button
                            onClick={() => setEditingDeliverableIndex(null)}
                            className={`text-caption px-2 py-1 rounded transition-colors ${
                              isDark
                                ? 'text-content-inverse-secondary hover:text-content-inverse'
                                : 'text-content-secondary hover:text-content'
                            }`}
                          >
                            Done
                          </button>
                          <button
                            onClick={() => handleDeleteDeliverable(index)}
                            className={`text-caption px-2 py-1 rounded transition-colors ${
                              isDark
                                ? 'text-red-400 hover:bg-red-500/10'
                                : 'text-red-600 hover:bg-red-50'
                            }`}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    // Display Mode
                    <div
                      className="flex items-center gap-3 cursor-pointer"
                      onClick={() => setEditingDeliverableIndex(index)}
                    >
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                        isDark ? 'bg-surface-dark-secondary' : 'bg-surface-secondary'
                      }`}>
                        {deliverable.type === 'string' && (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}>
                            <path d="M4 7h16M4 12h16M4 17h10" />
                          </svg>
                        )}
                        {deliverable.type === 'number' && (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}>
                            <path d="M4 9h6M14 9h6M14 15h6M4 15h6" />
                          </svg>
                        )}
                        {deliverable.type === 'boolean' && (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}>
                            <path d="M9 11l3 3L22 4" />
                            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                          </svg>
                        )}
                        {deliverable.type === 'enum' && (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}>
                            <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                          </svg>
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className={`text-body-sm font-medium truncate ${
                          isDark ? 'text-content-inverse' : 'text-content'
                        }`}>
                          {deliverable.description || 'Unnamed deliverable'}
                        </div>
                        <div className={`text-caption ${
                          isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
                        }`}>
                          {deliverable.type}
                          {deliverable.type === 'enum' && deliverable.enum_values?.length
                            ? ` (${deliverable.enum_values.length} options)`
                            : ''}
                          {deliverable.acceptance_criteria
                            ? ` · ${deliverable.acceptance_criteria.slice(0, 60)}${deliverable.acceptance_criteria.length > 60 ? '...' : ''}`
                            : ''}
                        </div>
                      </div>

                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}>
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </div>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  )
}
