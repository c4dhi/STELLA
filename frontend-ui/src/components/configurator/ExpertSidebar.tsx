/**
 * ExpertSidebar — always-visible right panel in the Pipeline Configurator.
 *
 * Contains:
 * 1. Task Extraction toggle + prompt editor
 * 2. Sortable expert list (drag to reorder = arbitration priority)
 * 3. Disabled experts chips
 * 4. Add Custom Expert button/form
 */

import { useState, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import ExpertCard from './ExpertCard'
import type { ExpertDefinition } from './useConfiguratorState'
import { PromptComposer, buildExpertBlocks } from './PromptComposer'
import { useConfiguratorStore } from '../../store/configuratorStore'

/** Experts that ARE a mode's mechanism rather than assessment. Each has its own
 *  section above, so neither belongs in the pool, background or disabled lists —
 *  showing one twice would imply it can be reordered or opted out of. */
const STRUCTURAL_EXPERT_NAMES = new Set(['task_extraction', 'companion_router'])

interface ExpertSidebarProps {
  experts: ExpertDefinition[]
  poolExperts: ExpertDefinition[]
  bgExperts: ExpertDefinition[]
  disabledExperts: ExpertDefinition[]
  taskExtractionEnabled: boolean
  /** Present only when the agent declares the `companion` capability. */
  companionRouter?: ExpertDefinition
  onUpdateExpert: (name: string, updates: Partial<ExpertDefinition>) => void
  onReorderExperts: (orderedNames: string[]) => void
  onAddCustomExpert: (expert: {
    name: string
    description: string
    model: string
    temperature: number
    maxTokens: number
    systemPrompt: string
    triggerCriteria?: string
    alwaysTriggered?: boolean
  }) => void
  onRemoveExpert: (name: string) => void
  onToggleTaskExtraction: (enabled: boolean) => void
  isDark: boolean
}

export default function ExpertSidebar({
  experts,
  poolExperts,
  bgExperts,
  disabledExperts,
  companionRouter,
  taskExtractionEnabled,
  onUpdateExpert,
  onReorderExperts,
  onAddCustomExpert,
  onRemoveExpert,
  onToggleTaskExtraction,
  isDark,
}: ExpertSidebarProps) {
  const [expandedExpert, setExpandedExpert] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showAddCustom, setShowAddCustom] = useState(false)
  const [taskExtractionExpanded, setTaskExtractionExpanded] = useState(false)
  const [companionRouterExpanded, setCompanionRouterExpanded] = useState(false)

  // Assessment pool (+ custom experts) is gated on the `experts` capability.
  // When capabilities aren't provided (older flow), show everything.
  const capabilities = useConfiguratorStore((s) => s.capabilities)
  const hasExperts = !capabilities || capabilities.includes('experts')

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const poolNames = useMemo(() => poolExperts.map((e) => e.name), [poolExperts])

  const taskExtraction = useMemo(
    () => experts.find((e) => e.name === 'task_extraction'),
    [experts],
  )

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string)
  }, [])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      setActiveId(null)
      if (!over || active.id === over.id) return

      const oldIndex = poolNames.indexOf(active.id as string)
      const newIndex = poolNames.indexOf(over.id as string)
      if (oldIndex === -1 || newIndex === -1) return

      const reordered = arrayMove(poolNames, oldIndex, newIndex)
      onReorderExperts(reordered)
    },
    [poolNames, onReorderExperts],
  )

  const existingNames = useMemo(() => experts.map((e) => e.name), [experts])

  const inputClass = `w-full px-3 py-2 rounded-lg text-[13px] font-light focus:outline-none transition-all ${
    isDark
      ? 'bg-zinc-800/80 border border-zinc-600/80 text-zinc-100 focus:border-zinc-400'
      : 'bg-white border border-neutral-200 text-neutral-900 focus:border-neutral-400'
  }`

  const labelClass = `text-xs font-medium mb-1.5 block ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`

  const CollapsibleModelSettings = ({ isDark: d, children }: { isDark: boolean; children: React.ReactNode }) => {
    const [open, setOpen] = useState(false)
    return (
      <div className={`rounded-lg border ${
        d ? 'bg-zinc-800/40 border-zinc-700/50' : 'bg-neutral-50/50 border-neutral-200/40'
      }`}>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors rounded-lg ${
            d ? 'hover:bg-zinc-700/40' : 'hover:bg-neutral-100/60'
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={d ? 'text-zinc-600' : 'text-neutral-400'}
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </svg>
          <span className={`flex-1 text-[10px] font-semibold tracking-wide uppercase ${d ? 'text-zinc-500' : 'text-neutral-400'}`}>
            Model Settings
          </span>
          <svg
            width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            className={`transition-transform duration-200 ${open ? 'rotate-90' : ''} ${d ? 'text-zinc-600' : 'text-neutral-400'}`}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="overflow-hidden"
            >
              <div className="grid grid-cols-2 gap-3 px-3 pb-3">
                {children}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    )
  }

  const SectionHeader = ({ color, title, subtitle }: { color: string; title: string; subtitle?: string }) => (
    <div className="flex items-center gap-2.5 mb-3">
      <div className={`w-2.5 h-2.5 rounded-full ${color}`} />
      <span className={`text-xs font-semibold tracking-wide uppercase ${isDark ? 'text-zinc-300' : 'text-neutral-600'}`}>
        {title}
      </span>
      {subtitle && (
        <span className={`text-[11px] font-light ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
          {subtitle}
        </span>
      )}
    </div>
  )

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className={`px-5 py-4 border-b shrink-0 ${isDark ? 'border-zinc-700/80' : 'border-neutral-200'}`}>
        <h3 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-neutral-800'}`}>
          Expert Module
        </h3>
        <p className={`text-[11px] font-light mt-1 ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
          Drag to set arbitration priority (top = highest) · expand an expert to wire verdict responses
        </p>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
        {/* Task Extraction Section — gated on `plans` (present iff a task_extraction default exists) */}
        {taskExtraction && (
        <div>
          <div className="flex items-center gap-2.5 mb-3">
            <div className={`w-2.5 h-2.5 rounded-full ${isDark ? 'bg-blue-400' : 'bg-blue-500'}`} />
            <span className={`text-xs font-semibold tracking-wide uppercase ${isDark ? 'text-zinc-300' : 'text-neutral-600'}`}>
              Task Extraction
            </span>
            <span className={`text-[11px] font-light ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
              — background
            </span>
            <div className="flex-1" />
            <button
              onClick={() => onToggleTaskExtraction(!taskExtractionEnabled)}
              className={`relative w-10 h-[22px] rounded-full transition-colors ${
                taskExtractionEnabled
                  ? 'bg-blue-500'
                  : isDark
                    ? 'bg-zinc-600'
                    : 'bg-neutral-300'
              }`}
            >
              <span
                className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform shadow-sm ${
                  taskExtractionEnabled ? 'translate-x-[18px]' : ''
                }`}
              />
            </button>
          </div>

          {taskExtraction && (
            <div
              className={`rounded-xl border transition-opacity ${
                taskExtractionEnabled ? 'opacity-100' : 'opacity-40 pointer-events-none'
              } ${isDark ? 'border-zinc-700/60 bg-zinc-800/30' : 'border-neutral-200/60 bg-neutral-50/30'}`}
            >
              <button
                onClick={() => setTaskExtractionExpanded(!taskExtractionExpanded)}
                className="w-full text-left px-4 py-3"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className={`text-[13px] font-medium ${isDark ? 'text-zinc-100' : 'text-neutral-800'}`}>
                      {taskExtraction.name}
                    </p>
                    <p className={`text-[11px] font-light mt-0.5 ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                      {taskExtraction.description}
                    </p>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-md font-mono ${
                        isDark ? 'bg-zinc-700 text-zinc-400' : 'bg-neutral-100 text-neutral-500'
                      }`}
                    >
                      {taskExtraction.model}
                    </span>
                    <svg
                      width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                      className={`transition-transform duration-200 ${taskExtractionExpanded ? 'rotate-90' : ''} ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </div>
                </div>
              </button>

              <AnimatePresence>
                {taskExtractionExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className={`px-4 pb-4 pt-3 space-y-5 border-t ${isDark ? 'border-zinc-700/50' : 'border-neutral-200/50'}`}>
                      <CollapsibleModelSettings isDark={isDark}>
                        <div>
                          <label className={labelClass}>Model</label>
                          <select
                            value={taskExtraction.model}
                            onChange={(e) => onUpdateExpert('task_extraction', { model: e.target.value })}
                            className={inputClass}
                          >
                            {['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1-nano'].map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className={labelClass}>Temperature</label>
                          <input
                            type="number"
                            value={taskExtraction.temperature}
                            onChange={(e) => onUpdateExpert('task_extraction', { temperature: parseFloat(e.target.value) || 0 })}
                            min={0} max={1} step={0.1}
                            className={inputClass}
                          />
                        </div>
                        <div>
                          <label className={labelClass}>Max Tokens</label>
                          <input
                            type="number"
                            value={taskExtraction.maxTokens}
                            onChange={(e) => onUpdateExpert('task_extraction', { maxTokens: parseInt(e.target.value) || 800 })}
                            min={100} max={4000}
                            className={inputClass}
                          />
                        </div>
                        <div>
                          <label className={labelClass}>Min Confidence</label>
                          <input
                            type="number"
                            value={taskExtraction.minConfidence}
                            onChange={(e) => onUpdateExpert('task_extraction', { minConfidence: parseFloat(e.target.value) || 0 })}
                            min={0} max={1} step={0.05}
                            className={inputClass}
                          />
                        </div>
                      </CollapsibleModelSettings>
                      {/* Prompt assembly view */}
                      <PromptComposer
                        blocks={buildExpertBlocks(taskExtraction, (updates) => onUpdateExpert('task_extraction', updates))}
                        isDark={isDark}
                        compact
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
        )}

        {/* Companion Router — gated on `companion`. Sits beside Task Extraction
            because it is the same KIND of thing: the mechanism a mode is made
            of, not an assessment expert. Deliberately has no enable toggle —
            the agent forces it on in companion mode and off otherwise, after
            this configuration is applied, so a toggle here would be a lie. */}
        {companionRouter && (
        <div>
          <div className="flex items-center gap-2.5 mb-3">
            <div className={`w-2.5 h-2.5 rounded-full ${isDark ? 'bg-primary-400' : 'bg-primary-500'}`} />
            <span className={`text-xs font-semibold tracking-wide uppercase ${isDark ? 'text-zinc-300' : 'text-neutral-600'}`}>
              Companion Router
            </span>
            <span className={`text-[11px] font-light ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
              — companion mode only
            </span>
          </div>

          <p className={`text-[11px] font-light leading-relaxed mb-3 ${isDark ? 'text-zinc-500' : 'text-neutral-500'}`}>
            Runs only when this agent is deployed in <strong>Companion</strong> mode, where it
            notices that the user wants to see, start or stop an activity. In Plan mode it never
            runs and costs nothing. There is no on/off here on purpose: the deploy mode decides,
            so the same configuration works for both. What you can tune is how it decides.
          </p>

          <div
            className={`rounded-xl border ${isDark ? 'border-zinc-700/60 bg-zinc-800/30' : 'border-neutral-200/60 bg-neutral-50/30'}`}
          >
            <button
              onClick={() => setCompanionRouterExpanded(!companionRouterExpanded)}
              className="w-full text-left px-4 py-3"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className={`text-[13px] font-medium ${isDark ? 'text-zinc-100' : 'text-neutral-800'}`}>
                    {companionRouter.name}
                  </p>
                  <p className={`text-[11px] font-light mt-0.5 ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                    {companionRouter.description}
                  </p>
                </div>
                <div className="flex items-center gap-2.5">
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-md font-mono ${
                      isDark ? 'bg-zinc-700 text-zinc-400' : 'bg-neutral-100 text-neutral-500'
                    }`}
                  >
                    {companionRouter.model}
                  </span>
                  <svg
                    width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    className={`transition-transform duration-200 ${companionRouterExpanded ? 'rotate-90' : ''} ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </div>
              </div>
            </button>

            <AnimatePresence>
              {companionRouterExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className={`px-4 pb-4 pt-3 space-y-5 border-t ${isDark ? 'border-zinc-700/50' : 'border-neutral-200/50'}`}>
                    <CollapsibleModelSettings isDark={isDark}>
                      <div>
                        <label className={labelClass}>Model</label>
                        <select
                          value={companionRouter.model}
                          onChange={(e) => onUpdateExpert('companion_router', { model: e.target.value })}
                          className={inputClass}
                        >
                          {['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1-nano'].map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className={labelClass}>Temperature</label>
                        <input
                          type="number"
                          value={companionRouter.temperature}
                          onChange={(e) => onUpdateExpert('companion_router', { temperature: parseFloat(e.target.value) || 0 })}
                          min={0} max={1} step={0.1}
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>Max Tokens</label>
                        <input
                          type="number"
                          value={companionRouter.maxTokens}
                          onChange={(e) => onUpdateExpert('companion_router', { maxTokens: parseInt(e.target.value) || 200 })}
                          min={50} max={2000}
                          className={inputClass}
                        />
                      </div>
                    </CollapsibleModelSettings>
                    <PromptComposer
                      blocks={buildExpertBlocks(companionRouter, (updates) => onUpdateExpert('companion_router', updates))}
                      isDark={isDark}
                      compact
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
        )}

        {/* Expert Pool Section — gated on `experts` */}
        {hasExperts && (
        <div>
          <SectionHeader
            color={isDark ? 'bg-emerald-400' : 'bg-emerald-500'}
            title="Experts"
            subtitle="— order = priority"
          />

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={poolNames} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {poolExperts.map((expert, index) => (
                  <ExpertCard
                    key={expert.name}
                    expert={expert}
                    index={index}
                    isExpanded={expandedExpert === expert.name}
                    onToggleExpand={() =>
                      setExpandedExpert(expandedExpert === expert.name ? null : expert.name)
                    }
                    onUpdate={(updates) => onUpdateExpert(expert.name, updates)}
                    onRemove={expert.isCustom ? () => onRemoveExpert(expert.name) : undefined}
                    isDark={isDark}
                  />
                ))}
              </div>
            </SortableContext>

            <DragOverlay>
              {activeId && (
                <div
                  className={`px-4 py-3 rounded-xl border-2 shadow-lg ${
                    isDark
                      ? 'bg-zinc-800 border-primary-400/50'
                      : 'bg-white border-primary-500/50 shadow-primary-500/10'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      className={isDark ? 'text-zinc-500' : 'text-neutral-400'}
                    >
                      <circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" />
                      <circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" />
                      <circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" />
                    </svg>
                    <span className={`text-[13px] font-medium ${isDark ? 'text-zinc-200' : 'text-neutral-800'}`}>
                      {activeId}
                    </span>
                  </div>
                </div>
              )}
            </DragOverlay>
          </DndContext>
        </div>
        )}

        {/* Background experts (if any non-task_extraction) */}
        {bgExperts.filter((e) => !STRUCTURAL_EXPERT_NAMES.has(e.name)).length > 0 && (
          <div>
            <SectionHeader
              color={isDark ? 'bg-indigo-400' : 'bg-indigo-500'}
              title="Background"
            />
            <div className="space-y-2">
              {bgExperts
                .filter((e) => !STRUCTURAL_EXPERT_NAMES.has(e.name))
                .map((expert, index) => (
                  <ExpertCard
                    key={expert.name}
                    expert={expert}
                    index={index}
                    isExpanded={expandedExpert === expert.name}
                    onToggleExpand={() =>
                      setExpandedExpert(expandedExpert === expert.name ? null : expert.name)
                    }
                    onUpdate={(updates) => onUpdateExpert(expert.name, updates)}
                    onRemove={expert.isCustom ? () => onRemoveExpert(expert.name) : undefined}
                    isDark={isDark}
                  />
                ))}
            </div>
          </div>
        )}

        {/* Disabled experts */}
        {disabledExperts.filter((e) => !STRUCTURAL_EXPERT_NAMES.has(e.name)).length > 0 && (
          <div>
            <SectionHeader
              color={isDark ? 'bg-zinc-600' : 'bg-neutral-300'}
              title="Disabled"
            />
            <div className="flex flex-wrap gap-2">
              {disabledExperts.filter((e) => !STRUCTURAL_EXPERT_NAMES.has(e.name)).map((expert) => (
                <button
                  key={expert.name}
                  onClick={() => onUpdateExpert(expert.name, { enabled: true })}
                  className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${
                    isDark
                      ? 'bg-zinc-800/50 text-zinc-500 hover:text-zinc-300 border border-zinc-700/50 hover:border-zinc-600'
                      : 'bg-neutral-100/50 text-neutral-400 hover:text-neutral-600 border border-neutral-200/50 hover:border-neutral-300'
                  }`}
                  title="Click to re-enable"
                >
                  {expert.name}
                  <span className="ml-2 opacity-60">+</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Add custom expert — gated on `experts` */}
        {hasExperts && (
        <AnimatePresence>
          {showAddCustom ? (
            <AddCustomExpertForm
              isDark={isDark}
              inputClass={inputClass}
              labelClass={labelClass}
              onAdd={(expert) => {
                onAddCustomExpert(expert)
                setShowAddCustom(false)
              }}
              onCancel={() => setShowAddCustom(false)}
              existingNames={existingNames}
            />
          ) : (
            <button
              onClick={() => setShowAddCustom(true)}
              className={`w-full py-2.5 rounded-xl text-xs font-medium border-2 border-dashed transition-colors ${
                isDark
                  ? 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-300'
                  : 'border-neutral-200 text-neutral-400 hover:border-neutral-300 hover:text-neutral-600'
              }`}
            >
              + Add Custom Expert
            </button>
          )}
        </AnimatePresence>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add Custom Expert Form
// ---------------------------------------------------------------------------

function AddCustomExpertForm({
  isDark,
  inputClass,
  labelClass,
  onAdd,
  onCancel,
  existingNames,
}: {
  isDark: boolean
  inputClass: string
  labelClass: string
  onAdd: (expert: {
    name: string
    description: string
    model: string
    temperature: number
    maxTokens: number
    systemPrompt: string
    triggerCriteria: string
    alwaysTriggered: boolean
  }) => void
  onCancel: () => void
  existingNames: string[]
}) {
  const [form, setForm] = useState({
    name: '',
    description: '',
    model: 'gpt-4o-mini',
    temperature: 0.3,
    maxTokens: 200,
    systemPrompt: '',
    triggerCriteria: '',
    alwaysTriggered: false,
  })
  const [error, setError] = useState('')

  const handleAdd = () => {
    const name = form.name.trim().toLowerCase().replace(/\s+/g, '_')
    if (!name) return setError('Name is required')
    if (existingNames.includes(name)) return setError('Expert name already exists')
    if (!form.systemPrompt.trim()) return setError('System prompt is required')
    onAdd({ ...form, name })
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className={`rounded-xl border p-4 space-y-4 ${
        isDark ? 'border-violet-500/30 bg-violet-500/5' : 'border-violet-200 bg-violet-50/30'
      }`}
    >
      <p className={`text-[13px] font-medium ${isDark ? 'text-violet-300' : 'text-violet-700'}`}>
        New Custom Expert
      </p>
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Name</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => { setForm({ ...form, name: e.target.value }); setError('') }}
            placeholder="e.g. sentiment_analysis"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Description</label>
          <input
            type="text"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="What does this expert do?"
            className={inputClass}
          />
        </div>
      </div>
      {/* Always Triggered toggle (#175) — when on, trigger criteria is irrelevant */}
      <div className={`flex items-center justify-between px-3.5 py-2.5 rounded-lg ${isDark ? 'bg-zinc-800/60' : 'bg-neutral-50'}`}>
        <div>
          <label className={`text-xs font-medium ${isDark ? 'text-zinc-300' : 'text-neutral-600'}`}>
            Always Triggered
          </label>
          <p className={`text-[10px] mt-0.5 ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
            Runs on every turn, regardless of the input gate
          </p>
        </div>
        <button
          type="button"
          onClick={() => setForm({ ...form, alwaysTriggered: !form.alwaysTriggered })}
          className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${
            form.alwaysTriggered ? 'bg-sky-500' : isDark ? 'bg-zinc-600' : 'bg-neutral-300'
          }`}
        >
          <span
            className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform shadow-sm ${
              form.alwaysTriggered ? 'translate-x-[18px]' : ''
            }`}
          />
        </button>
      </div>

      {!form.alwaysTriggered && (
        <div>
          <label className={labelClass}>Trigger Criteria</label>
          <textarea
            value={form.triggerCriteria}
            onChange={(e) => setForm({ ...form, triggerCriteria: e.target.value })}
            placeholder="When should the input gate select this expert?"
            rows={2}
            className={`${inputClass} resize-y`}
            style={{ fontSize: '12px', lineHeight: '1.6' }}
          />
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Model</label>
          <select
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
            className={inputClass}
          >
            {['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1-nano'].map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Temperature</label>
          <input
            type="number"
            value={form.temperature}
            onChange={(e) => setForm({ ...form, temperature: parseFloat(e.target.value) || 0.3 })}
            min={0} max={1} step={0.1}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Max Tokens</label>
          <input
            type="number"
            value={form.maxTokens}
            onChange={(e) => setForm({ ...form, maxTokens: parseInt(e.target.value) || 200 })}
            min={10} max={2000}
            className={inputClass}
          />
        </div>
      </div>
      {/* Unified prompt editor (#178) — same component as the edit view, so the
          create form gets variable insertion, highlighting, and maximize for free. */}
      <div>
        <label className={labelClass}>System Prompt</label>
        <PromptComposer
          isDark={isDark}
          compact
          blocks={[
            {
              id: 'custom_expert_prompt',
              type: 'editable',
              label: 'System Prompt',
              value: form.systemPrompt,
              onChange: (v) => { setForm({ ...form, systemPrompt: v }); setError('') },
              rows: 8,
              placeholder: 'Expert system prompt (supports {{variables}})…',
            },
          ]}
        />
      </div>
      <div className="flex gap-2.5 justify-end pt-1">
        <button
          onClick={onCancel}
          className={`px-4 py-2 rounded-lg text-xs font-medium ${
            isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-neutral-500 hover:text-neutral-700'
          }`}
        >
          Cancel
        </button>
        <button
          onClick={handleAdd}
          className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
            isDark
              ? 'bg-violet-500/20 text-violet-300 hover:bg-violet-500/30'
              : 'bg-violet-100 text-violet-700 hover:bg-violet-200'
          }`}
        >
          Add Expert
        </button>
      </div>
    </motion.div>
  )
}
