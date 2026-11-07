/**
 * The agent picker in both deploy dialogs: one list in two sections, custom
 * (uploaded) agents first, then the built-in ones. Every agent follows the same
 * interface, so none gets its own tab or screen. Uploading happens in
 * Settings → Agent Library; the picker links there.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import AgentGalleryCard from '../agents/AgentGalleryCard'
import { MyAgentsSection } from '../agents'
import type { AgentType, CustomAgentType } from '../../lib/api-types'

interface AgentPickerSectionsProps {
  agentTypes: AgentType[]
  isLoading: boolean
  loadError?: string | null
  selectedId: string | null
  onSelectType: (type: AgentType) => void
  onSelectCustom: (agent: CustomAgentType) => void
  refreshTrigger?: number
  isDark: boolean
}

export default function AgentPickerSections({
  agentTypes,
  isLoading,
  loadError,
  selectedId,
  onSelectType,
  onSelectCustom,
  refreshTrigger = 0,
  isDark,
}: AgentPickerSectionsProps) {
  // The user's own uploads are listed by MyAgentsSection, with their build and
  // review state; uploads others shared with this project follow as plain cards.
  const [ownIds, setOwnIds] = useState<Set<string>>(new Set())
  const [ownLoaded, setOwnLoaded] = useState(false)
  const othersCustom = agentTypes.filter((t) => !t.isBuiltIn && !ownIds.has(t.id))
  const builtIn = agentTypes.filter((t) => t.isBuiltIn)
  const heading = `text-xs font-medium tracking-wider uppercase mb-3 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`
  const quiet = `text-sm ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`

  const cards = (types: AgentType[]) => (
    <div className="grid grid-cols-2 gap-3 pt-1">
      {types.map((type) => (
        <AgentGalleryCard
          key={type.id}
          agentType={type}
          isSelected={selectedId === type.id}
          onClick={() => onSelectType(type)}
        />
      ))}
    </div>
  )

  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <h3 className={`${heading} mb-0`}>Custom</h3>
          <Link
            to="/settings/agent-library"
            className={`text-xs ${isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-neutral-500 hover:text-neutral-900'} underline-offset-2 hover:underline`}
          >
            Upload or manage in Agent Library →
          </Link>
        </div>
        <div className="space-y-3">
          <MyAgentsSection
            onSelectAgent={onSelectCustom}
            refreshTrigger={refreshTrigger}
            onAgentsLoaded={(agents) => {
              setOwnIds(new Set(agents.map((a) => a.id)))
              setOwnLoaded(true)
            }}
            hideEmpty
          />
          {othersCustom.length > 0 && cards(othersCustom)}
          {ownLoaded && ownIds.size === 0 && othersCustom.length === 0 && !isLoading && (
            <p className={quiet}>No custom agents yet.</p>
          )}
        </div>
      </section>

      <section>
        <h3 className={heading}>Built-in</h3>
        {isLoading ? (
          <div className={`flex items-center gap-3 py-6 ${quiet}`}>
            <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
            Loading agents...
          </div>
        ) : loadError ? (
          <p className={quiet}>{loadError}</p>
        ) : builtIn.length === 0 ? (
          <p className={quiet}>No built-in agents</p>
        ) : (
          cards(builtIn)
        )}
      </section>
    </div>
  )
}
