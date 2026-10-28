import { useState, useMemo } from 'react'
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
  type DragOverEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useThemeStore } from '../../store/themeStore'

interface ExpertOverride {
  enabled?: boolean
  priority?: number
  model?: string
  temperature?: number
  max_tokens?: number
  system_prompt?: string
}

interface CustomExpertDef {
  name: string
  description: string
  priority: number
  model: string
  temperature: number
  max_tokens: number
  system_prompt: string
  output_schema?: Record<string, unknown>
}

interface BuiltInExpert {
  name: string
  description: string
  defaultPriority: number
}

interface ExpertItem {
  id: string
  name: string
  description: string
  isCustom: boolean
  isAlwaysRun: boolean
  section: 'pool' | 'background'
}

interface BuiltInExpertDef {
  name: string
  description: string
  defaultSystemPrompt?: string
  defaultModel?: string
  defaultTemperature?: number
  defaultMaxTokens?: number
}

interface ExpertListEditorProps {
  builtInExperts: BuiltInExpertDef[]
  expertOverrides: Record<string, ExpertOverride>
  customExperts: Record<string, CustomExpertDef>
  alwaysRun: string[]
  backgroundExperts: string[]
  onExpertOverridesChange: (overrides: Record<string, ExpertOverride>) => void
  onCustomExpertsChange: (customs: Record<string, CustomExpertDef>) => void
  onAlwaysRunChange: (names: string[]) => void
  onBackgroundExpertsChange: (names: string[]) => void
}

// Default priorities for built-in experts (used for initial ordering)
const DEFAULT_PRIORITIES: Record<string, number> = {
  noise_detection: 100,
  medical: 95,
  legal: 90,
  task_extraction: 70,
  probing: 60,
  timekeeper: 50,
}

const DEFAULT_BACKGROUND = new Set(['task_extraction'])
const DEFAULT_ALWAYS_RUN = new Set(['task_extraction'])

export default function ExpertListEditor({
  builtInExperts,
  expertOverrides,
  customExperts,
  alwaysRun,
  backgroundExperts,
  onExpertOverridesChange,
  onCustomExpertsChange,
  onAlwaysRunChange,
  onBackgroundExpertsChange,
}: ExpertListEditorProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overSection, setOverSection] = useState<'pool' | 'background' | null>(null)
  const [expandedExpert, setExpandedExpert] = useState<string | null>(null)
  const [showAddCustom, setShowAddCustom] = useState(false)

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const backgroundSet = useMemo(() => new Set(backgroundExperts), [backgroundExperts])
  const alwaysRunSet = useMemo(() => new Set(alwaysRun), [alwaysRun])

  // Build ordered expert items
  // Pool experts: sorted by priority (position = priority)
  // Background experts: after pool
  const allExpertNames = useMemo(() => {
    const names = builtInExperts.map((e) => e.name)
    Object.keys(customExperts).forEach((n) => {
      if (!names.includes(n)) names.push(n)
    })
    return names
  }, [builtInExperts, customExperts])

  const poolExperts = useMemo(() => {
    return allExpertNames
      .filter((n) => !backgroundSet.has(n))
      .filter((n) => {
        const override = expertOverrides[n]
        return override?.enabled !== false
      })
      .sort((a, b) => {
        const pa = expertOverrides[a]?.priority ?? DEFAULT_PRIORITIES[a] ?? 50
        const pb = expertOverrides[b]?.priority ?? DEFAULT_PRIORITIES[b] ?? 50
        return pb - pa // Higher priority first
      })
  }, [allExpertNames, backgroundSet, expertOverrides])

  const backgroundExpertsList = useMemo(() => {
    return allExpertNames
      .filter((n) => backgroundSet.has(n))
      .filter((n) => {
        const override = expertOverrides[n]
        return override?.enabled !== false
      })
  }, [allExpertNames, backgroundSet, expertOverrides])

  const disabledExperts = useMemo(() => {
    return allExpertNames.filter((n) => {
      const override = expertOverrides[n]
      return override?.enabled === false
    })
  }, [allExpertNames, expertOverrides])

  const getExpertInfo = (name: string) => {
    const builtin = builtInExperts.find((e) => e.name === name)
    const custom = customExperts[name]
    return {
      description: builtin?.description || custom?.description || '',
      isCustom: !builtin && !!custom,
      defaultSystemPrompt: builtin?.defaultSystemPrompt,
      defaultModel: builtin?.defaultModel,
      defaultTemperature: builtin?.defaultTemperature,
      defaultMaxTokens: builtin?.defaultMaxTokens,
    }
  }

  // Priority derivation from position: top of pool = highest priority
  const derivePriorityFromPosition = (orderedPool: string[]) => {
    const updatedOverrides = { ...expertOverrides }
    orderedPool.forEach((name, index) => {
      const priority = 100 - index * 5 // 100, 95, 90, 85, ...
      const existing = updatedOverrides[name] || {}
      updatedOverrides[name] = { ...existing, priority }
    })
    return updatedOverrides
  }

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string)
  }

  const handleDragOver = (event: DragOverEvent) => {
    const { over } = event
    if (!over) { setOverSection(null); return }
    // Check if over a droppable container
    if (over.id === 'pool-droppable' || poolExperts.includes(over.id as string)) {
      setOverSection('pool')
    } else if (over.id === 'background-droppable' || backgroundExpertsList.includes(over.id as string)) {
      setOverSection('background')
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    setActiveId(null)
    setOverSection(null)

    if (!over || !active) return

    const draggedName = active.id as string
    const overId = over.id as string

    // Determine target section
    const isOverPool = overId === 'pool-droppable' || poolExperts.includes(overId)
    const isOverBackground = overId === 'background-droppable' || backgroundExpertsList.includes(overId)

    const wasInPool = poolExperts.includes(draggedName)
    const wasInBackground = backgroundExpertsList.includes(draggedName)

    if (isOverPool) {
      // Moving to or within pool
      let newPool = [...poolExperts]
      if (wasInBackground) {
        // Move from background to pool
        const newBg = backgroundExperts.filter((n) => n !== draggedName)
        onBackgroundExpertsChange(newBg)
        // Add to pool at drop position
        const overIndex = newPool.indexOf(overId)
        if (overIndex >= 0) {
          newPool.splice(overIndex, 0, draggedName)
        } else {
          newPool.push(draggedName)
        }
      } else if (wasInPool) {
        // Reorder within pool
        const oldIndex = newPool.indexOf(draggedName)
        const newIndex = newPool.indexOf(overId)
        if (oldIndex !== -1 && newIndex !== -1) {
          newPool = arrayMove(newPool, oldIndex, newIndex)
        }
      }
      // Derive priorities from new order
      const updatedOverrides = derivePriorityFromPosition(newPool)
      onExpertOverridesChange(updatedOverrides)
    } else if (isOverBackground) {
      // Moving to background
      if (wasInPool) {
        // Add to background list
        if (!backgroundExperts.includes(draggedName)) {
          onBackgroundExpertsChange([...backgroundExperts, draggedName])
        }
        // Re-derive pool priorities without this expert
        const newPool = poolExperts.filter((n) => n !== draggedName)
        const updatedOverrides = derivePriorityFromPosition(newPool)
        onExpertOverridesChange(updatedOverrides)
      }
    }
  }

  const toggleAlwaysRun = (name: string) => {
    if (alwaysRunSet.has(name)) {
      onAlwaysRunChange(alwaysRun.filter((n) => n !== name))
    } else {
      onAlwaysRunChange([...alwaysRun, name])
    }
  }

  const toggleEnabled = (name: string) => {
    const existing = expertOverrides[name] || {}
    const isCurrentlyEnabled = existing.enabled !== false
    onExpertOverridesChange({
      ...expertOverrides,
      [name]: { ...existing, enabled: !isCurrentlyEnabled },
    })
  }

  const addCustomExpert = (expert: CustomExpertDef) => {
    onCustomExpertsChange({ ...customExperts, [expert.name]: expert })
    setShowAddCustom(false)
  }

  const removeCustomExpert = (name: string) => {
    const updated = { ...customExperts }
    delete updated[name]
    onCustomExpertsChange(updated)
    // Also remove from background/always-run
    onBackgroundExpertsChange(backgroundExperts.filter((n) => n !== name))
    onAlwaysRunChange(alwaysRun.filter((n) => n !== name))
  }

  const activeExpertInfo = activeId ? getExpertInfo(activeId) : null

  const inputClass = `w-full px-2.5 py-1.5 rounded-lg text-xs font-light focus:outline-none transition-all ${
    isDark
      ? 'bg-zinc-700/50 border border-zinc-600 text-zinc-100 focus:border-zinc-500'
      : 'bg-neutral-50/50 border border-neutral-200/60 text-neutral-900 focus:border-neutral-400/60'
  }`

  return (
    <div className="space-y-4">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        {/* Expert Pool Section */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className={`w-2 h-2 rounded-full ${isDark ? 'bg-emerald-400' : 'bg-emerald-500'}`} />
            <span className={`text-[11px] font-semibold tracking-wide uppercase ${isDark ? 'text-zinc-300' : 'text-neutral-600'}`}>
              Expert Pool
            </span>
            <span className={`text-[10px] font-light ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
              — order = arbitration priority (top is highest)
            </span>
          </div>
          <div
            id="pool-droppable"
            className={`rounded-xl border-2 transition-colors min-h-[60px] ${
              overSection === 'pool' && activeId && !poolExperts.includes(activeId)
                ? isDark ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-emerald-400/40 bg-emerald-50/50'
                : isDark ? 'border-zinc-700/60 bg-zinc-800/30' : 'border-neutral-200/60 bg-neutral-50/30'
            }`}
          >
            <SortableContext items={poolExperts} strategy={verticalListSortingStrategy}>
              {poolExperts.length === 0 ? (
                <div className={`py-6 text-center text-[11px] font-light ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}>
                  Drag experts here to add them to the pool
                </div>
              ) : (
                <div className="p-1.5 space-y-1">
                  {poolExperts.map((name, index) => (
                    <SortableExpertCard
                      key={name}
                      id={name}
                      name={name}
                      info={getExpertInfo(name)}
                      index={index}
                      isAlwaysRun={alwaysRunSet.has(name)}
                      onToggleAlwaysRun={() => toggleAlwaysRun(name)}
                      isExpanded={expandedExpert === name}
                      onToggleExpand={() => setExpandedExpert(expandedExpert === name ? null : name)}
                      overrides={expertOverrides[name]}
                      onOverrideChange={(field, value) => {
                        const existing = expertOverrides[name] || {}
                        onExpertOverridesChange({ ...expertOverrides, [name]: { ...existing, [field]: value } })
                      }}
                      isCustom={getExpertInfo(name).isCustom}
                      onRemoveCustom={() => removeCustomExpert(name)}
                      isDark={isDark}
                      inputClass={inputClass}
                    />
                  ))}
                </div>
              )}
            </SortableContext>
          </div>
        </div>

        {/* Background Section */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className={`w-2 h-2 rounded-full ${isDark ? 'bg-blue-400' : 'bg-blue-500'}`} />
            <span className={`text-[11px] font-semibold tracking-wide uppercase ${isDark ? 'text-zinc-300' : 'text-neutral-600'}`}>
              Background
            </span>
            <span className={`text-[10px] font-light ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
              — non-blocking, results collected after response
            </span>
          </div>
          <div
            id="background-droppable"
            className={`rounded-xl border-2 transition-colors min-h-[60px] ${
              overSection === 'background' && activeId && !backgroundExpertsList.includes(activeId)
                ? isDark ? 'border-blue-500/40 bg-blue-500/5' : 'border-blue-400/40 bg-blue-50/50'
                : isDark ? 'border-zinc-700/60 bg-zinc-800/30' : 'border-neutral-200/60 bg-neutral-50/30'
            }`}
          >
            <SortableContext items={backgroundExpertsList} strategy={verticalListSortingStrategy}>
              {backgroundExpertsList.length === 0 ? (
                <div className={`py-6 text-center text-[11px] font-light ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}>
                  Drag experts here to run them in the background
                </div>
              ) : (
                <div className="p-1.5 space-y-1">
                  {backgroundExpertsList.map((name, index) => (
                    <SortableExpertCard
                      key={name}
                      id={name}
                      name={name}
                      info={getExpertInfo(name)}
                      index={index}
                      isAlwaysRun={alwaysRunSet.has(name)}
                      onToggleAlwaysRun={() => toggleAlwaysRun(name)}
                      isExpanded={expandedExpert === name}
                      onToggleExpand={() => setExpandedExpert(expandedExpert === name ? null : name)}
                      overrides={expertOverrides[name]}
                      onOverrideChange={(field, value) => {
                        const existing = expertOverrides[name] || {}
                        onExpertOverridesChange({ ...expertOverrides, [name]: { ...existing, [field]: value } })
                      }}
                      isCustom={getExpertInfo(name).isCustom}
                      onRemoveCustom={() => removeCustomExpert(name)}
                      isDark={isDark}
                      inputClass={inputClass}
                    />
                  ))}
                </div>
              )}
            </SortableContext>
          </div>
        </div>

        {/* Drag overlay */}
        <DragOverlay>
          {activeId && activeExpertInfo && (
            <div className={`px-3 py-2.5 rounded-xl border-2 shadow-lg ${
              isDark ? 'bg-zinc-800 border-primary-400/50' : 'bg-white border-primary-500/50 shadow-primary-500/10'
            }`}>
              <div className="flex items-center gap-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={isDark ? 'text-zinc-500' : 'text-neutral-400'}>
                  <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                </svg>
                <span className={`text-xs font-medium ${isDark ? 'text-zinc-200' : 'text-neutral-800'}`}>
                  {activeId}
                </span>
              </div>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {/* Disabled experts */}
      {disabledExperts.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className={`w-2 h-2 rounded-full ${isDark ? 'bg-zinc-600' : 'bg-neutral-300'}`} />
            <span className={`text-[11px] font-semibold tracking-wide uppercase ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
              Disabled
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {disabledExperts.map((name) => (
              <button
                key={name}
                onClick={() => toggleEnabled(name)}
                className={`px-2.5 py-1.5 rounded-lg text-[11px] font-light transition-colors ${
                  isDark ? 'bg-zinc-800/50 text-zinc-500 hover:text-zinc-300 border border-zinc-700/50' : 'bg-neutral-100/50 text-neutral-400 hover:text-neutral-600 border border-neutral-200/50'
                }`}
                title="Click to re-enable"
              >
                {name}
                <span className="ml-1.5 opacity-60">+</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Add custom expert */}
      <AnimatePresence>
        {showAddCustom ? (
          <AddCustomExpertForm
            isDark={isDark}
            inputClass={inputClass}
            onAdd={addCustomExpert}
            onCancel={() => setShowAddCustom(false)}
            existingNames={allExpertNames}
          />
        ) : (
          <button
            onClick={() => setShowAddCustom(true)}
            className={`w-full py-2 rounded-xl text-xs font-light border-2 border-dashed transition-colors ${
              isDark
                ? 'border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300'
                : 'border-neutral-200 text-neutral-400 hover:border-neutral-300 hover:text-neutral-600'
            }`}
          >
            + Add Custom Expert
          </button>
        )}
      </AnimatePresence>
    </div>
  )
}

// ------- Sortable Expert Card -------

function SortableExpertCard({
  id,
  name,
  info,
  index,
  isAlwaysRun,
  onToggleAlwaysRun,
  isExpanded,
  onToggleExpand,
  overrides,
  onOverrideChange,
  isCustom,
  onRemoveCustom,
  isDark,
  inputClass,
}: {
  id: string
  name: string
  info: { description: string; isCustom: boolean; defaultSystemPrompt?: string; defaultModel?: string; defaultTemperature?: number; defaultMaxTokens?: number }
  index: number
  isAlwaysRun: boolean
  onToggleAlwaysRun: () => void
  isExpanded: boolean
  onToggleExpand: () => void
  overrides?: ExpertOverride
  onOverrideChange: (field: string, value: unknown) => void
  isCustom: boolean
  onRemoveCustom: () => void
  isDark: boolean
  inputClass: string
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  return (
    <div ref={setNodeRef} style={style}>
      <div
        className={`rounded-xl border transition-all ${
          isCustom
            ? isDark ? 'border-violet-500/30 bg-violet-500/5' : 'border-violet-200 bg-violet-50/30'
            : isDark ? 'border-zinc-700/60 bg-zinc-800/50' : 'border-neutral-200/60 bg-white'
        }`}
      >
        <div className="flex items-center gap-2 px-3 py-2">
          {/* Drag handle */}
          <button
            {...attributes}
            {...listeners}
            style={{ touchAction: 'none' }}
            className={`cursor-grab active:cursor-grabbing p-0.5 rounded ${isDark ? 'text-zinc-600 hover:text-zinc-400' : 'text-neutral-300 hover:text-neutral-500'}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 6h.01M8 12h.01M8 18h.01M12 6h.01M12 12h.01M12 18h.01" />
            </svg>
          </button>

          {/* Priority badge */}
          <span className={`text-[9px] font-mono w-5 text-center ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}>
            {index + 1}
          </span>

          {/* Expert info */}
          <button
            onClick={onToggleExpand}
            className="flex-1 min-w-0 text-left"
          >
            <div className="flex items-center gap-1.5">
              <span className={`text-xs font-medium ${isCustom ? (isDark ? 'text-violet-300' : 'text-violet-700') : isDark ? 'text-zinc-200' : 'text-neutral-800'}`}>
                {name}
              </span>
              {isCustom && (
                <span className={`text-[8px] px-1 py-0.5 rounded ${isDark ? 'bg-violet-500/20 text-violet-400' : 'bg-violet-100 text-violet-600'}`}>
                  custom
                </span>
              )}
            </div>
            <p className={`text-[10px] font-light truncate ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
              {info.description}
            </p>
          </button>

          {/* Always run toggle */}
          <button
            onClick={onToggleAlwaysRun}
            title={isAlwaysRun ? 'Always runs (click to disable)' : 'Click to always run this expert'}
            className={`px-2 py-1 rounded-lg text-[9px] font-medium transition-all whitespace-nowrap ${
              isAlwaysRun
                ? isDark ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30' : 'bg-amber-50 text-amber-600 border border-amber-200'
                : isDark ? 'text-zinc-600 hover:text-zinc-400' : 'text-neutral-300 hover:text-neutral-500'
            }`}
          >
            {isAlwaysRun ? 'ALWAYS' : 'auto'}
          </button>

          {/* Remove (custom only) */}
          {isCustom && (
            <button
              onClick={onRemoveCustom}
              className={`p-1 rounded transition-colors ${isDark ? 'text-zinc-600 hover:text-red-400' : 'text-neutral-300 hover:text-red-500'}`}
              title="Remove custom expert"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}

          {/* Disable toggle */}
          {!isCustom && (
            <button
              onClick={() => onOverrideChange('enabled', false)}
              className={`p-1 rounded transition-colors ${isDark ? 'text-zinc-600 hover:text-red-400' : 'text-neutral-300 hover:text-red-500'}`}
              title="Disable expert"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="m4.93 4.93 14.14 14.14" />
              </svg>
            </button>
          )}

          {/* Expand arrow */}
          <span className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}>
            {isExpanded ? '▾' : '▸'}
          </span>
        </div>

        {/* Expanded settings */}
        <AnimatePresence>
          {isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className={`px-3 pb-3 pt-1 space-y-2 border-t ${isDark ? 'border-zinc-700/50' : 'border-neutral-200/50'}`}>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className={`text-[10px] font-medium ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>Model</label>
                    <select
                      value={overrides?.model ?? ''}
                      onChange={(e) => onOverrideChange('model', e.target.value || undefined)}
                      className={inputClass}
                    >
                      <option value="">{info.defaultModel ? `Default (${info.defaultModel})` : 'Default'}</option>
                      <option value="gpt-5.4-mini">gpt-5.4-mini</option>
                      <option value="gpt-4o-mini">gpt-4o-mini</option>
                      <option value="gpt-4o">gpt-4o</option>
                      <option value="gpt-4.1-mini">gpt-4.1-mini</option>
                      <option value="gpt-4.1-nano">gpt-4.1-nano</option>
                    </select>
                  </div>
                  <div>
                    <label className={`text-[10px] font-medium ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>Temperature</label>
                    <input
                      type="number"
                      value={overrides?.temperature ?? ''}
                      onChange={(e) => onOverrideChange('temperature', e.target.value ? parseFloat(e.target.value) : undefined)}
                      placeholder={info.defaultTemperature !== undefined ? String(info.defaultTemperature) : 'Default'}
                      min={0} max={1} step={0.1}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={`text-[10px] font-medium ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>Max Tokens</label>
                    <input
                      type="number"
                      value={overrides?.max_tokens ?? ''}
                      onChange={(e) => onOverrideChange('max_tokens', e.target.value ? parseInt(e.target.value) : undefined)}
                      placeholder={info.defaultMaxTokens !== undefined ? String(info.defaultMaxTokens) : 'Default'}
                      min={10} max={2000}
                      className={inputClass}
                    />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <label className={`text-[10px] font-medium ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                      System Prompt {overrides?.system_prompt !== undefined ? 'Override' : ''}
                    </label>
                    {overrides?.system_prompt === undefined && info.defaultSystemPrompt ? (
                      <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${
                        isDark ? 'bg-zinc-800 text-zinc-500' : 'bg-neutral-100 text-neutral-400'
                      }`}>
                        default
                      </span>
                    ) : overrides?.system_prompt !== undefined ? (
                      <button
                        onClick={() => onOverrideChange('system_prompt', undefined)}
                        className={`text-[9px] font-medium px-1.5 py-0.5 rounded transition-colors ${
                          isDark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700' : 'text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100'
                        }`}
                      >
                        Reset to default
                      </button>
                    ) : null}
                  </div>
                  {/* Single control. `undefined` = no override: the default renders as editable
                      dimmed text so the user can customize starting from it. Typing creates an
                      override; clearing to '' is kept as an explicit empty prompt — the default is
                      never auto-re-inserted. "Reset to default" inherits it again (#174). */}
                  <textarea
                    value={overrides?.system_prompt ?? info.defaultSystemPrompt ?? ''}
                    onChange={(e) => onOverrideChange('system_prompt', e.target.value)}
                    placeholder={
                      overrides?.system_prompt === ''
                        ? 'Empty — this expert will run with no system prompt'
                        : 'Override system prompt...'
                    }
                    rows={4}
                    className={`${inputClass} resize-y ${
                      overrides?.system_prompt === undefined && info.defaultSystemPrompt
                        ? isDark ? '!text-zinc-400' : '!text-neutral-400'
                        : ''
                    }`}
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

// ------- Add Custom Expert Form -------

function AddCustomExpertForm({
  isDark,
  inputClass,
  onAdd,
  onCancel,
  existingNames,
}: {
  isDark: boolean
  inputClass: string
  onAdd: (expert: CustomExpertDef) => void
  onCancel: () => void
  existingNames: string[]
}) {
  const [form, setForm] = useState<CustomExpertDef>({
    name: '',
    description: '',
    priority: 50,
    model: 'gpt-5.4-mini',
    temperature: 0.3,
    max_tokens: 200,
    system_prompt: '',
  })
  const [error, setError] = useState('')

  const handleAdd = () => {
    const name = form.name.trim().toLowerCase().replace(/\s+/g, '_')
    if (!name) return setError('Name is required')
    if (existingNames.includes(name)) return setError('Expert name already exists')
    if (!form.system_prompt.trim()) return setError('System prompt is required')
    onAdd({ ...form, name })
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className={`rounded-xl border p-3 space-y-2 ${
        isDark ? 'border-violet-500/30 bg-violet-500/5' : 'border-violet-200 bg-violet-50/30'
      }`}
    >
      <p className={`text-xs font-medium ${isDark ? 'text-violet-300' : 'text-violet-700'}`}>
        New Custom Expert
      </p>
      {error && <p className="text-[10px] text-red-500">{error}</p>}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={`text-[10px] font-medium ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>Name</label>
          <input type="text" value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); setError('') }} placeholder="e.g. sentiment_analysis" className={inputClass} />
        </div>
        <div>
          <label className={`text-[10px] font-medium ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>Description</label>
          <input type="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What does this expert do?" className={inputClass} />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className={`text-[10px] font-medium ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>Model</label>
          <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className={inputClass}>
            <option value="gpt-5.4-mini">gpt-5.4-mini</option>
            <option value="gpt-4o-mini">gpt-4o-mini</option>
            <option value="gpt-4o">gpt-4o</option>
            <option value="gpt-4.1-mini">gpt-4.1-mini</option>
            <option value="gpt-4.1-nano">gpt-4.1-nano</option>
          </select>
        </div>
        <div>
          <label className={`text-[10px] font-medium ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>Temperature</label>
          <input type="number" value={form.temperature} onChange={(e) => setForm({ ...form, temperature: parseFloat(e.target.value) || 0.3 })} min={0} max={1} step={0.1} className={inputClass} />
        </div>
        <div>
          <label className={`text-[10px] font-medium ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>Max Tokens</label>
          <input type="number" value={form.max_tokens} onChange={(e) => setForm({ ...form, max_tokens: parseInt(e.target.value) || 200 })} min={10} max={2000} className={inputClass} />
        </div>
      </div>
      <div>
        <label className={`text-[10px] font-medium ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>System Prompt</label>
        <textarea value={form.system_prompt} onChange={(e) => { setForm({ ...form, system_prompt: e.target.value }); setError('') }} placeholder="Expert system prompt..." rows={3} className={`${inputClass} resize-y`} />
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className={`px-3 py-1.5 rounded-lg text-xs font-light ${isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-neutral-500 hover:text-neutral-700'}`}>
          Cancel
        </button>
        <button onClick={handleAdd} className={`px-3 py-1.5 rounded-lg text-xs font-light ${isDark ? 'bg-violet-500/20 text-violet-300 hover:bg-violet-500/30' : 'bg-violet-100 text-violet-700 hover:bg-violet-200'}`}>
          Add Expert
        </button>
      </div>
    </motion.div>
  )
}
