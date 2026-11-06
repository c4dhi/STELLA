/**
 * The agent picker in both deploy dialogs: one list in two sections, custom
 * (uploaded) agents first, then the built-in ones. Every agent follows the same
 * interface, so none gets its own tab or screen.
 */
import { useState } from 'react'
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
  refreshTrigger: number
  /** Shows the upload button at the top of the custom section. */
  onUpload?: () => void
  isDark: boolean
}

export default function AgentPickerSections({
  agentTypes,
  isLoading,
  loadError,
  selectedId,
  onSelectType,
  onSelectCustom,
  refreshTrigger,
  onUpload,
  isDark,
}: AgentPickerSectionsProps) {
  // The user's own uploads are listed by MyAgentsSection, with their build and
  // review state; approved uploads by others follow as plain cards.
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
        <h3 className={heading}>Custom</h3>
        <div className="space-y-3">
          {onUpload && (
            <button
              type="button"
              onClick={onUpload}
              className={`
                w-full p-3 rounded-xl text-left text-sm transition-all duration-200
                border-2 border-dashed hover:border-solid flex items-center gap-3
                ${isDark
                  ? 'border-zinc-600 hover:border-primary-500 text-zinc-300 bg-zinc-800/30 hover:bg-zinc-700/50'
                  : 'border-neutral-300 hover:border-primary-500 text-neutral-600 bg-neutral-50/50 hover:bg-primary-50'
                }
              `}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 16V4m0 0l-4 4m4-4l4 4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M3 20h18" strokeLinecap="round" />
              </svg>
              Upload a custom agent package (.zip)
            </button>
          )}
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
