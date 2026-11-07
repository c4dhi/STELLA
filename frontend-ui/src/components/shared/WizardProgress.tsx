/**
 * Where a multi-step dialog is: "Step 3 of 9" over a thin segmented bar.
 * It takes the same space for any number of steps, so a long wizard never
 * crowds the header or runs under the close button.
 */
interface WizardProgressProps {
  current: number
  total: number
  isDark: boolean
}

export default function WizardProgress({ current, total, isDark }: WizardProgressProps) {
  if (total <= 1) return null
  return (
    <div className="mb-3 pr-10" aria-label={`Step ${current} of ${total}`}>
      <div className={`text-xs font-medium mb-1.5 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
        Step {current} of {total}
      </div>
      <div className="flex gap-1">
        {Array.from({ length: total }, (_, i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
              i < current
                ? isDark ? 'bg-primary-500' : 'bg-neutral-900'
                : isDark ? 'bg-zinc-700' : 'bg-neutral-200'
            }`}
          />
        ))}
      </div>
    </div>
  )
}
