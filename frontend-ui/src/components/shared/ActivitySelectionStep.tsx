import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import { apiClient } from '../../services/ApiClient'
import type { PlanTemplate } from '../../lib/api-types'

interface ActivitySelectionStepProps {
  selectedPlanIds: string[]
  onChange: (ids: string[]) => void
}

/**
 * Which plans a companion may offer.
 *
 * Multi-select, unlike the plan-following step: a companion's whole point is
 * that the user chooses in the moment, so the operator picks the menu rather
 * than the dish.
 */
export default function ActivitySelectionStep({
  selectedPlanIds,
  onChange,
}: ActivitySelectionStepProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  const [plans, setPlans] = useState<PlanTemplate[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    apiClient
      .listPlanTemplates()
      .then(setPlans)
      .catch((err) => console.error('Failed to fetch plans:', err))
      .finally(() => setIsLoading(false))
  }, [])

  const toggle = (id: string) =>
    onChange(
      selectedPlanIds.includes(id)
        ? selectedPlanIds.filter((x) => x !== id)
        : [...selectedPlanIds, id],
    )

  if (isLoading) {
    return (
      <div className={`h-48 flex items-center justify-center text-sm ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
          Loading plans...
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
        {selectedPlanIds.length === 0
          ? 'Pick nothing and the companion will just talk — it will say it has no activities if asked.'
          : `${selectedPlanIds.length} activit${selectedPlanIds.length === 1 ? 'y' : 'ies'} the user can choose from.`}
      </p>

      <div className="grid grid-cols-2 gap-3 max-h-[320px] overflow-y-auto pr-2 pt-1">
        {plans.map((plan) => {
          const selected = selectedPlanIds.includes(plan.id)
          const stateCount = plan.content.states?.length || 0
          return (
            <motion.button
              key={plan.id}
              type="button"
              onClick={() => toggle(plan.id)}
              whileHover={{ y: -2 }}
              className={`
                relative p-4 rounded-xl text-left transition-all duration-200
                ${selected
                  ? isDark
                    ? 'bg-primary-500/20 border-2 border-primary-500'
                    : 'bg-neutral-100 border-2 border-neutral-900'
                  : isDark
                    ? 'bg-zinc-700/50 border border-zinc-600 hover:border-zinc-500'
                    : 'bg-white border border-neutral-200 hover:border-neutral-300'
                }
              `}
            >
              <div
                className={`absolute top-3 right-3 w-4 h-4 rounded border flex items-center justify-center ${
                  selected
                    ? isDark
                      ? 'bg-primary-500 border-primary-500'
                      : 'bg-neutral-900 border-neutral-900'
                    : isDark
                      ? 'border-zinc-500'
                      : 'border-neutral-300'
                }`}
              >
                {selected && (
                  <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
              </div>
              <p className={`text-sm font-medium mb-1 pr-6 truncate ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                {plan.name}
              </p>
              <p className={`text-xs line-clamp-2 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                {plan.description || `${stateCount} states`}
              </p>
            </motion.button>
          )
        })}
      </div>
    </div>
  )
}
