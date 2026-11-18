/**
 * The session page on a narrow screen (#181): the conversation, the people
 * (participants and agents) and the plan each take the full width, one at a
 * time. Hidden from md up, where they sit side by side.
 */
export type SessionPanel = 'chat' | 'people' | 'plan'

interface SessionPanelTabsProps {
  active: SessionPanel
  onSelect: (panel: SessionPanel) => void
  /** The plan tab shows only while the task panel does. */
  showPlan: boolean
  isDark: boolean
}

const LABELS: Record<SessionPanel, string> = {
  chat: 'Conversation',
  people: 'People',
  plan: 'Plan',
}

export default function SessionPanelTabs({ active, onSelect, showPlan, isDark }: SessionPanelTabsProps) {
  const panels: SessionPanel[] = showPlan ? ['chat', 'people', 'plan'] : ['chat', 'people']
  return (
    <nav
      role="tablist"
      aria-label="Session panels"
      className={`md:hidden flex shrink-0 gap-1 px-3 pt-3 ${isDark ? 'text-content-inverse' : 'text-content'}`}
    >
      {panels.map((panel) => {
        const selected = panel === active
        return (
          <button
            key={panel}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(panel)}
            className={`flex-1 min-h-[40px] rounded-lg text-sm font-medium transition-colors ${
              selected
                ? isDark ? 'bg-white/10' : 'bg-neutral-900 text-white'
                : isDark ? 'text-content-inverse-secondary hover:bg-white/5' : 'text-content-secondary hover:bg-neutral-100'
            }`}
          >
            {LABELS[panel]}
          </button>
        )
      })}
    </nav>
  )
}
