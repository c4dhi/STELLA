import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import { apiClient } from '../../services/ApiClient'
import { usePlanBuilderStore } from '../../store/planBuilderStore'
import type { PlanTemplate } from '../../lib/api-types'

interface PlanSelectionStepProps {
  selectedPlan: PlanTemplate | null
  onSelectPlan: (plan: PlanTemplate | null) => void
  planTemplates?: PlanTemplate[]
  onPlanTemplatesChange?: (templates: PlanTemplate[]) => void
}

// Generate gradient colors for plan cards
const getPlanCardStyle = (index: number) => {
  const gradients = [
    'from-blue-500/20 to-indigo-500/20',
    'from-purple-500/20 to-pink-500/20',
    'from-emerald-500/20 to-teal-500/20',
    'from-orange-500/20 to-amber-500/20',
    'from-cyan-500/20 to-blue-500/20',
  ]
  const iconColors = [
    'text-blue-500',
    'text-purple-500',
    'text-emerald-500',
    'text-orange-500',
    'text-cyan-500',
  ]
  const colorIndex = index % 5
  return { gradient: gradients[colorIndex], iconColor: iconColors[colorIndex] }
}

export default function PlanSelectionStep({
  selectedPlan,
  onSelectPlan,
  planTemplates: externalPlanTemplates,
  onPlanTemplatesChange,
}: PlanSelectionStepProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const { openModal: openPlanBuilder } = usePlanBuilderStore()

  const [internalPlanTemplates, setInternalPlanTemplates] = useState<PlanTemplate[]>([])
  const [isLoadingPlans, setIsLoadingPlans] = useState(false)
  const [hasFetched, setHasFetched] = useState(false)

  // Use external plan templates if provided, otherwise manage internally
  const planTemplates = externalPlanTemplates ?? internalPlanTemplates
  const setPlanTemplates = onPlanTemplatesChange ?? setInternalPlanTemplates

  // Fetch plan templates on mount (only once)
  useEffect(() => {
    if (!hasFetched) {
      setHasFetched(true)
      setIsLoadingPlans(true)
      apiClient.listPlanTemplates()
        .then((templates) => {
          setPlanTemplates(templates)
        })
        .catch((err) => console.error('Failed to fetch plan templates:', err))
        .finally(() => setIsLoadingPlans(false))
    }
  }, [hasFetched, setPlanTemplates])

  const handleCreateNewPlan = () => {
    openPlanBuilder(undefined, (newTemplate: PlanTemplate) => {
      setPlanTemplates([newTemplate, ...planTemplates])
      onSelectPlan(newTemplate)
    }, true)
  }

  const handleEditPlan = (plan: PlanTemplate, e: React.MouseEvent) => {
    e.stopPropagation()
    openPlanBuilder(plan, (updatedTemplate: PlanTemplate) => {
      setPlanTemplates(planTemplates.map(p => p.id === updatedTemplate.id ? updatedTemplate : p))
      if (selectedPlan?.id === updatedTemplate.id) {
        onSelectPlan(updatedTemplate)
      }
    }, true)
  }

  if (isLoadingPlans) {
    return (
      <div className={`h-48 flex items-center justify-center text-sm ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
          Loading plan templates...
        </div>
      </div>
    )
  }

  if (planTemplates.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center py-8">
        <svg className={`w-16 h-16 mb-4 ${isDark ? 'text-zinc-600' : 'text-neutral-300'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <polygon points="12 2 2 7 12 12 22 7 12 2" strokeWidth={1.5} />
          <polyline points="2 17 12 22 22 17" strokeWidth={1.5} />
          <polyline points="2 12 12 17 22 12" strokeWidth={1.5} />
        </svg>
        <p className={`text-sm font-medium mb-1 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
          No plan templates yet
        </p>
        <p className={`text-xs mb-4 ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
          Create your first plan to get started
        </p>
        <motion.button
          type="button"
          onClick={handleCreateNewPlan}
          whileTap={{ scale: 0.98 }}
          className={`
            inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium
            transition-all duration-200
            ${isDark
              ? 'bg-primary-500 text-white hover:bg-primary-400'
              : 'bg-neutral-900 text-white hover:bg-neutral-800'
            }
          `}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Create New Plan
        </motion.button>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3 max-h-[350px] overflow-y-auto overflow-x-visible pr-2 pt-1 -mt-1">
      {planTemplates.map((plan, index) => {
        const style = getPlanCardStyle(index)
        const stateCount = plan.content.states?.length || 0
        const taskCount = plan.content.states?.reduce((acc, s) => acc + (s.tasks?.length || 0), 0) || 0

        return (
          <motion.button
            key={plan.id}
            type="button"
            onClick={() => onSelectPlan(plan)}
            whileHover={{ y: -2 }}
            className={`
              group/card relative p-4 rounded-xl text-left transition-all duration-200
              ${selectedPlan?.id === plan.id
                ? isDark
                  ? 'bg-primary-500/20 border-2 border-primary-500 shadow-lg shadow-primary-500/20'
                  : 'bg-neutral-100 border-2 border-neutral-900 shadow-lg shadow-neutral-900/10'
                : isDark
                  ? 'bg-zinc-700/50 border border-zinc-600 hover:border-zinc-500 hover:bg-zinc-700/80'
                  : 'bg-white border border-neutral-200 hover:border-neutral-300 hover:shadow-md'
              }
            `}
          >
            {/* Top-right actions: Edit button + Selection checkmark */}
            <div className="absolute top-3 right-3 flex items-center gap-1.5">
              {/* Edit button - shows on hover */}
              <motion.div
                onClick={(e) => handleEditPlan(plan, e)}
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
                className={`
                  p-1.5 rounded-lg cursor-pointer
                  opacity-0 group-hover/card:opacity-100 transition-opacity duration-200
                  ${isDark
                    ? 'hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200'
                    : 'hover:bg-neutral-100 text-neutral-400 hover:text-neutral-600'
                  }
                `}
                title="Edit plan"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </motion.div>
              {/* Selection checkmark */}
              {selectedPlan?.id === plan.id && (
                <svg className={`w-5 h-5 ${isDark ? 'text-primary-400' : 'text-neutral-900'}`} fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
              )}
            </div>

            {/* Icon */}
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 bg-gradient-to-br ${style.gradient}`}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={style.iconColor}>
                <polygon points="12 2 2 7 12 12 22 7 12 2" />
                <polyline points="2 17 12 22 22 17" />
                <polyline points="2 12 12 17 22 12" />
              </svg>
            </div>

            {/* Title */}
            <h3 className={`text-sm font-semibold truncate mb-1 ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
              {plan.name}
            </h3>

            {/* Description */}
            {plan.description && (
              <p className={`text-xs line-clamp-2 mb-3 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                {plan.description}
              </p>
            )}

            {/* Stats */}
            <div className="flex flex-wrap gap-1.5">
              <span className={`
                inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs
                ${isDark ? 'bg-zinc-600/50 text-zinc-300' : 'bg-neutral-100 text-neutral-600'}
              `}>
                {stateCount} states
              </span>
              <span className={`
                inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs
                ${isDark ? 'bg-zinc-600/50 text-zinc-300' : 'bg-neutral-100 text-neutral-600'}
              `}>
                {taskCount} tasks
              </span>
            </div>
          </motion.button>
        )
      })}

      {/* Create New Plan Card - at the end */}
      <motion.button
        type="button"
        onClick={handleCreateNewPlan}
        whileHover={{ y: -2 }}
        className={`
          p-4 rounded-xl text-left transition-all duration-200
          border-2 border-dashed hover:border-solid
          ${isDark
            ? 'border-zinc-600 hover:border-primary-500 bg-zinc-800/30 hover:bg-zinc-700/50'
            : 'border-neutral-300 hover:border-neutral-900 bg-neutral-50/50 hover:bg-neutral-100'
          }
        `}
      >
        {/* Icon */}
        <div className={`
          w-10 h-10 rounded-xl flex items-center justify-center mb-3
          ${isDark ? 'bg-zinc-700' : 'bg-neutral-100'}
        `}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className={isDark ? 'text-zinc-400' : 'text-neutral-500'}
          >
            <path d="M12 5v14M5 12h14" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        {/* Title */}
        <h3 className={`text-sm font-semibold mb-1 ${isDark ? 'text-zinc-200' : 'text-neutral-700'}`}>
          Create New Plan
        </h3>

        {/* Description */}
        <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
          Build a custom conversation plan with AI assistance
        </p>
      </motion.button>
    </div>
  )
}
