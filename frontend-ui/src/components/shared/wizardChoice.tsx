/**
 * The one look for a pickable card in the wizards (deploy agent, project
 * setup, invite participant). Every step uses these, so a choice looks and
 * behaves the same everywhere.
 *
 * Selected: dark outline 2px wide, drawn as a 1px border plus a 1px inset ring
 * so the card never shifts when picked; a tinted background; the check badge in
 * the top-right corner. Idle cards have the same 1px border in a light tone.
 * Keyboard focus keeps the app-wide focus ring (index.css).
 */
import { Check } from 'lucide-react'

export const CHOICE_CARD = {
  selected: {
    dark: 'bg-primary-500/20 border border-primary-500 ring-1 ring-inset ring-primary-500 shadow-lg shadow-primary-500/20',
    light: 'bg-neutral-100 border border-neutral-900 ring-1 ring-inset ring-neutral-900 shadow-lg shadow-neutral-900/10',
  },
  idle: {
    dark: 'bg-zinc-700/50 border border-zinc-600 hover:border-zinc-500 hover:bg-zinc-700/80',
    light: 'bg-white border border-neutral-200 hover:border-neutral-300 hover:shadow-md',
  },
} as const

export function choiceCardClass(selected: boolean, isDark: boolean): string {
  const state = selected ? CHOICE_CARD.selected : CHOICE_CARD.idle
  return isDark ? state.dark : state.light
}

/** The check that marks the selected card. Place it top-right. */
export function SelectedBadge({ isDark, className = '' }: { isDark: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`w-5 h-5 shrink-0 rounded-full flex items-center justify-center ${isDark ? 'bg-primary-500' : 'bg-neutral-900'} ${className}`}
    >
      <Check className="w-3 h-3 text-white" strokeWidth={3} />
    </span>
  )
}
