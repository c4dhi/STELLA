import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import { useToastStore } from '../../store/toastStore'
import { useFeatureFlagsStore } from '../../store/featureFlagsStore'
import { apiClient } from '../../services/ApiClient'
import {
  AgentValidationStatus,
  type AgentReviewBuild,
  type AgentReviewDetail,
  type AgentReviewItem,
  type AgentReviewState,
  type DeployRequirements,
} from '../../lib/api-types'

export type ReviewDecision = 'approve' | 'reject'

/** What an admin can do with an upload: decide a pending one, or reverse a decision. */
export function decisionsFor(status: AgentValidationStatus): ReviewDecision[] {
  if (status === AgentValidationStatus.APPROVED) return ['reject']
  if (status === AgentValidationStatus.REJECTED) return ['approve']
  return ['approve', 'reject']
}

/** A rejection needs a reason, so the uploader knows what to change. */
export function canConfirm(decision: ReviewDecision, text: string): boolean {
  return decision === 'approve' || text.trim().length > 0
}

export function formatPackageSize(bytes: number | null | undefined): string | null {
  if (bytes == null) return null
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1000))} KB`
}

/** What agent.yaml asks of a deployment, as label/value rows. Undeclared things are left out. */
export function declarationsOf(req: DeployRequirements): [string, string][] {
  const rows: [string, string][] = []
  if (req.env.required.length > 0) rows.push(['Keys it needs', req.env.required.join(', ')])
  if (req.env.optional.length > 0) rows.push(['Settings', `${req.env.optional.length} optional`])
  if (req.connectors.length > 0) {
    rows.push([
      'Connectors',
      req.connectors.map(c => `${c.label}${c.required ? ' (required)' : ''}`).join(', '),
    ])
  }
  if (req.persona) rows.push(['Persona', 'Yes'])
  if (req.plans) rows.push(['Plans', `${req.plans.modes.join(' or ')}, ${req.plans.required ? 'required' : 'optional'}`])
  if (req.configurator) rows.push(['Configurator', req.configurator.required ? 'required' : 'optional'])
  return rows
}

const formatDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null

function buildBadge(build: AgentReviewBuild | null): { label: string; tone: 'ok' | 'bad' | 'busy' | 'none' } {
  if (!build) return { label: 'Not built yet', tone: 'none' }
  // AgentBuildLog.status is lowercase: pending, building, success, failed.
  switch (build.status.toLowerCase()) {
    case 'success':
      return { label: 'Built', tone: 'ok' }
    case 'failed':
      return { label: 'Build failed', tone: 'bad' }
    case 'pending':
    case 'building':
      return { label: 'Building…', tone: 'busy' }
    default:
      return { label: build.status, tone: 'none' }
  }
}

const TONE = {
  ok: 'bg-green-500/10 text-green-600 dark:text-green-400',
  bad: 'bg-red-500/10 text-red-600 dark:text-red-400',
  busy: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  none: 'bg-neutral-500/10 text-neutral-500',
} as const

export interface AgentReviewCardProps {
  agent: AgentReviewItem
  isDark: boolean
  expanded: boolean
  /** Loaded when the card is opened; null while loading. */
  detail: AgentReviewDetail | null
  /** The decision being written, or null. */
  decision: ReviewDecision | null
  text: string
  busy: boolean
  onToggleDetails: () => void
  onStart: (decision: ReviewDecision) => void
  onText: (text: string) => void
  onConfirm: () => void
  onCancel: () => void
}

/** One upload: build status first (Felix, 7 Nov), then who uploaded what and what it declares. */
export function AgentReviewCard({
  agent, isDark, expanded, detail, decision, text, busy,
  onToggleDetails, onStart, onText, onConfirm, onCancel,
}: AgentReviewCardProps) {
  const build = buildBadge(agent.lastBuild)
  const muted = isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
  const body = isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
  const strong = isDark ? 'text-content-inverse' : 'text-content'
  const size = formatPackageSize(agent.packageSize)
  const declared = agent.requirements ? declarationsOf(agent.requirements) : []
  const reviewed = agent.validationStatus !== AgentValidationStatus.PENDING

  return (
    <div className={`p-5 rounded-2xl ${isDark ? 'bg-surface-dark-secondary' : 'bg-white border border-neutral-200/60'}`}>
      {/* Build status leads: an upload that does not build needs no further reading. */}
      <div className="flex items-center gap-2 mb-3 text-caption">
        <span className={`px-2 py-0.5 rounded-full font-medium ${TONE[build.tone]}`}>{build.label}</span>
        {agent.lastBuild && <span className={muted}>{formatDate(agent.lastBuild.startedAt)}</span>}
      </div>
      {agent.lastBuild?.errorMessage && (
        <p className="mb-3 text-caption text-red-500 font-mono break-words">{agent.lastBuild.errorMessage}</p>
      )}

      <div className="flex items-start gap-3">
        <span className="text-2xl leading-none">{agent.icon || '🤖'}</span>
        <div className="flex-1 min-w-0">
          <div className={`text-body-sm font-semibold ${strong}`}>
            {agent.name} <span className={`font-normal ${muted}`}>v{agent.version}</span>
          </div>
          <div className={`text-caption font-mono ${muted}`}>{agent.slug}</div>
          {agent.description && <p className={`text-body-sm mt-1 ${body}`}>{agent.description}</p>}
        </div>
      </div>

      <div className={`mt-3 flex flex-wrap gap-x-4 gap-y-1 text-caption ${body}`}>
        <span>
          Uploaded by {agent.owner ? `${agent.owner.name ?? agent.owner.email} (${agent.owner.email})` : 'unknown'}
          {formatDate(agent.createdAt) ? `, ${formatDate(agent.createdAt)}` : ''}
        </span>
        {agent.authorName && <span>Author: {agent.authorName}</span>}
        {agent.sdkVersion && <span>SDK {agent.sdkVersion}</span>}
        {agent.resourceGpu && <span>Needs GPU</span>}
        {size && <span>{size}</span>}
      </div>

      {(declared.length > 0 || agent.manifestError) && (
        <dl className={`mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-caption ${body}`}>
          {declared.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className={muted}>{label}</dt>
              <dd className="break-words">{value}</dd>
            </div>
          ))}
          {agent.manifestError && (
            <div className="contents">
              <dt className={muted}>Manifest</dt>
              <dd className="text-red-500 break-words">{agent.manifestError}</dd>
            </div>
          )}
        </dl>
      )}

      {reviewed && (
        <p className={`mt-3 text-caption ${body}`}>
          {agent.validationStatus === AgentValidationStatus.APPROVED ? 'Approved' : 'Rejected'}
          {formatDate(agent.validatedAt) ? ` ${formatDate(agent.validatedAt)}` : ''}
          {agent.validationNotes ? `: ${agent.validationNotes}` : ''}
        </p>
      )}

      {expanded && (
        <div className={`mt-4 pt-4 border-t text-caption ${isDark ? 'border-border-dark/50' : 'border-border/50'} ${body}`}>
          {!detail ? (
            <span className={muted}>Loading…</span>
          ) : (
            <>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span>Capabilities: {detail.capabilities.length > 0 ? detail.capabilities.join(', ') : 'none'}</span>
                {detail.resourceCpu && <span>CPU {detail.resourceCpu}</span>}
                {detail.resourceMemory && <span>Memory {detail.resourceMemory}</span>}
                {detail.sdkMinVersion && <span>Needs SDK ≥ {detail.sdkMinVersion}</span>}
              </div>
              {detail.buildLogs.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {detail.buildLogs.map(log => (
                    <li key={log.id} className="flex gap-3">
                      <span className="font-medium w-24 flex-shrink-0">{buildBadge(log).label}</span>
                      <span className={muted}>{formatDate(log.startedAt)}</span>
                      {log.errorMessage && <span className="text-red-500 truncate">{log.errorMessage}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {decision ? (
        <div className="mt-4">
          <label className={`block text-caption mb-1 ${body}`}>
            {decision === 'reject' ? 'Reason, shown to the uploader (required)' : 'Notes for the uploader (optional)'}
            <textarea
              value={text}
              onChange={e => onText(e.target.value)}
              rows={2}
              className={`mt-1 w-full rounded-xl px-3 py-2 text-body-sm ${
                isDark ? 'bg-surface-dark-tertiary text-content-inverse' : 'bg-surface-secondary text-content'
              }`}
            />
          </label>
          <div className="flex justify-end gap-2 mt-2">
            <button
              onClick={onCancel}
              className={`px-4 py-2 rounded-xl text-body-sm font-medium ${
                isDark ? 'text-content-inverse-secondary hover:bg-surface-dark-tertiary' : 'text-content-secondary hover:bg-surface-secondary'
              }`}
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={busy || !canConfirm(decision, text)}
              className={`btn-primary ${busy || !canConfirm(decision, text) ? 'opacity-40 cursor-not-allowed' : ''}`}
            >{decision === 'reject' ? 'Reject agent' : 'Approve agent'}</button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex items-center justify-between gap-2">
          <button onClick={onToggleDetails} className={`text-caption underline-offset-2 hover:underline ${muted}`}>
            {expanded ? 'Hide details' : 'Builds and resources'}
          </button>
          <div className="flex gap-2">
            {decisionsFor(agent.validationStatus).map(d => (
              <button
                key={d}
                onClick={() => onStart(d)}
                className={d === 'approve'
                  ? 'btn-primary'
                  : 'px-4 py-2 rounded-xl text-body-sm font-medium text-red-600 hover:bg-red-500/10'}
              >{d === 'approve' ? 'Approve' : 'Reject'}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const TABS: { id: AgentReviewState; label: string }[] = [
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
]

const EMPTY: Record<AgentReviewState, string> = {
  pending: 'Nothing waits for review.',
  approved: 'No uploaded agent is approved yet.',
  rejected: 'No uploaded agent is rejected.',
}

/** Settings → Agent Review: system admins approve or reject uploaded agents. */
export default function AgentReviewSection() {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const { addToast } = useToastStore()
  const reviewRequired = useFeatureFlagsStore(state => state.agentReviewRequired)
  const [tab, setTab] = useState<AgentReviewState>('pending')
  const [items, setItems] = useState<AgentReviewItem[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, AgentReviewDetail | null>>({})
  const [writing, setWriting] = useState<{ id: string; decision: ReviewDecision; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback((state: AgentReviewState) => {
    setItems(null)
    setLoadError(null)
    apiClient.getAgentReviews(state)
      .then(setItems)
      .catch(err => setLoadError(err instanceof Error ? err.message : 'Could not load uploaded agents'))
  }, [])

  useEffect(() => {
    setExpanded({})
    setWriting(null)
    load(tab)
  }, [tab, load])

  const toggleDetails = (id: string) => {
    if (id in expanded) {
      setExpanded(({ [id]: _, ...rest }) => rest)
      return
    }
    setExpanded(prev => ({ ...prev, [id]: null }))
    apiClient.getAgentReview(id)
      .then(detail => setExpanded(prev => (id in prev ? { ...prev, [id]: detail } : prev)))
      .catch(err => {
        setExpanded(({ [id]: _, ...rest }) => rest)
        addToast({ message: err instanceof Error ? err.message : 'Could not load the details', type: 'error' })
      })
  }

  const confirm = async (agent: AgentReviewItem) => {
    if (!writing) return
    setBusy(true)
    try {
      if (writing.decision === 'approve') {
        await apiClient.approveAgentReview(agent.id, writing.text.trim() || undefined)
        addToast({ message: `${agent.name} is approved and can now be deployed.`, type: 'success' })
      } else {
        await apiClient.rejectAgentReview(agent.id, writing.text.trim())
        addToast({ message: `${agent.name} is rejected. Its uploader sees your reason.`, type: 'success' })
      }
      // It now belongs to the other tab.
      setItems(prev => prev?.filter(i => i.id !== agent.id) ?? prev)
      setWriting(null)
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : 'Could not save the decision', type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <motion.div className="max-w-3xl" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="mb-6">
        <h2 className={`text-heading-lg mb-2 ${isDark ? 'text-content-inverse' : 'text-content'}`}>Agent Review</h2>
        <p className={`text-body-sm ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
          Uploaded agents run their own code on this server. Approve one to let it deploy, also for members of the
          projects it is shared with; reject one with a reason its uploader will see. Only system admins see this page.
        </p>
        {!reviewRequired && (
          <p className={`mt-2 text-caption ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
            Review is off in Platform Defaults, so a built upload deploys without approval, for its owner and in
            the projects it is shared with. A rejected agent still never deploys.
          </p>
        )}
      </div>

      <div role="tablist" className={`inline-flex mb-4 p-1 rounded-xl ${isDark ? 'bg-surface-dark-secondary' : 'bg-surface-secondary'}`}>
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-1.5 rounded-lg text-body-sm font-medium ${
              tab === t.id
                ? isDark ? 'bg-surface-dark-tertiary text-content-inverse' : 'bg-white text-content shadow-sm'
                : isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
            }`}
          >
            {t.label}
            {tab === t.id && items ? ` (${items.length})` : ''}
          </button>
        ))}
      </div>

      {loadError && <p className="text-body-sm text-red-500 mb-4">{loadError}</p>}
      {!items && !loadError && (
        <p className={`text-body-sm ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>Loading…</p>
      )}
      {items && items.length === 0 && (
        <p className={`text-body-sm ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>{EMPTY[tab]}</p>
      )}

      <div className="space-y-4">
        {items?.map(agent => (
          <AgentReviewCard
            key={agent.id}
            agent={agent}
            isDark={isDark}
            expanded={agent.id in expanded}
            detail={expanded[agent.id] ?? null}
            decision={writing?.id === agent.id ? writing.decision : null}
            text={writing?.id === agent.id ? writing.text : ''}
            busy={busy}
            onToggleDetails={() => toggleDetails(agent.id)}
            onStart={decision => setWriting({ id: agent.id, decision, text: '' })}
            onText={text => setWriting(w => (w ? { ...w, text } : w))}
            onConfirm={() => void confirm(agent)}
            onCancel={() => setWriting(null)}
          />
        ))}
      </div>
    </motion.div>
  )
}
