import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiClient } from '../../../services/ApiClient'
import { useToastStore } from '../../../store/toastStore'
import type { Connector, ConnectorCallLogEntry, ConnectorTool, ConnectorToolCallResult, ProjectWithCounts } from '../../../lib/api-types'
import { ArgumentError, argumentsFromForm, resultText, toolParameters, type ToolParameter } from '../../../lib/connectorTools'
import { IconTile, StatusPill, formatDateTime, toolCountLabel } from './connectorUi'

interface ConnectorDetailProps {
  connector: Connector
  projects: ProjectWithCounts[] | null
  isDark: boolean
  /** Bumped by the parent after it tests the connector, so the call list reloads. */
  refreshKey: number
  testing: boolean
  onBack: () => void
  onTest: () => void
  onEdit: () => void
  onUpdated: (connector: Connector) => void
}

/**
 * One connector: what it is, every tool it offers with its parameters and a
 * form to run it, how STELLA reaches it, who it is shared with, and its latest
 * calls.
 */
export default function ConnectorDetail({
  connector: c,
  projects,
  isDark,
  refreshKey,
  testing,
  onBack,
  onTest,
  onEdit,
  onUpdated,
}: ConnectorDetailProps) {
  const [calls, setCalls] = useState<ConnectorCallLogEntry[] | null>(null)
  const [callsError, setCallsError] = useState<string | null>(null)
  const [callsKey, setCallsKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    apiClient
      .listConnectorCalls(c.id, 10)
      .then((list) => !cancelled && (setCalls(list), setCallsError(null)))
      .catch((err) => !cancelled && setCallsError(err instanceof Error ? err.message : 'Could not load the calls'))
    return () => {
      cancelled = true
    }
  }, [c.id, refreshKey, callsKey])

  const reloadCalls = useCallback(() => setCallsKey((k) => k + 1), [])

  const strong = isDark ? 'text-content-inverse' : 'text-content'
  const muted = isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
  const faint = isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
  const panel = `rounded-2xl border ${isDark ? 'bg-surface-dark-secondary border-border-dark' : 'bg-white border-neutral-200/60'}`
  const secondary = `px-4 py-2 rounded-xl text-body-sm font-medium border disabled:opacity-50 ${
    isDark ? 'border-zinc-700 text-zinc-100 hover:bg-zinc-800' : 'border-neutral-200 bg-white text-neutral-900 hover:bg-neutral-50'
  }`
  const styles = { strong, muted, faint, panel, secondary }

  return (
    <div className="space-y-5">
      <button type="button" onClick={onBack} className={`text-body-sm ${muted} hover:underline underline-offset-2`}>
        ← All connectors
      </button>

      <section className={`${panel} p-6 flex flex-wrap items-start gap-5`}>
        <IconTile icon={c.icon} isDark={isDark} size="lg" />
        <div className="flex-1 min-w-[240px] space-y-1.5">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h2 className={`text-heading-lg ${strong}`}>{c.name}</h2>
            <StatusPill status={c.status} isDark={isDark} />
          </div>
          <p className={`text-body-sm leading-relaxed ${c.description ? muted : `${faint} italic`}`}>
            {c.description || 'No description yet. Add one under Edit, so others know what it is for.'}
          </p>
          <p className={`text-caption ${faint}`}>
            {c.lastCheckedAt ? `Last tested ${formatDateTime(c.lastCheckedAt)}` : 'Never tested'} · {toolCountLabel(c.tools)}
          </p>
          {c.status === 'error' && c.lastError && <p className="text-caption text-red-500">{c.lastError}</p>}
        </div>
        <div className="flex gap-2 shrink-0">
          <button type="button" className="btn-primary disabled:opacity-50" disabled={testing} onClick={onTest} title="Connect and list its tools">
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button type="button" className={secondary} onClick={onEdit}>Edit</button>
        </div>
      </section>

      <div className="flex flex-wrap gap-5 items-start">
        <ToolsPanel connector={c} isDark={isDark} styles={styles} onCalled={reloadCalls} />

        <aside className="w-full lg:w-[340px] shrink-0 space-y-5">
          <section className={`${panel} p-5 space-y-3`}>
            <h3 className={`text-body-sm font-semibold ${strong}`}>Connection</h3>
            <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2 text-caption">
              <dt className={faint}>URL</dt>
              <dd className={`font-mono break-all ${strong}`}>{c.url}</dd>
              <dt className={faint}>Handle</dt>
              <dd className={`font-mono ${strong}`}>{c.handle}</dd>
              <dt className={faint}>Auth</dt>
              <dd className={strong}>{c.authType === 'bearer' ? (c.hasCredential ? 'Bearer token, saved' : 'Bearer token, missing') : 'None'}</dd>
              <dt className={faint}>Server</dt>
              <dd className={strong}>
                {c.serverInfo?.name ? `${c.serverInfo.name}${c.serverInfo.version ? ` ${c.serverInfo.version}` : ''}` : '—'}
              </dd>
              <dt className={faint}>Protocol</dt>
              <dd className={strong}>{c.serverInfo?.protocolVersion ?? '—'}</dd>
              <dt className={faint}>Added</dt>
              <dd className={strong}>{formatDateTime(c.createdAt)}</dd>
            </dl>
          </section>

          <SharingPanel connector={c} projects={projects} isDark={isDark} styles={styles} onUpdated={onUpdated} />

          <section className={`${panel} p-5 space-y-3`}>
            <h3 className={`text-body-sm font-semibold ${strong}`}>Recent calls</h3>
            {callsError && <p className="text-caption text-red-500">{callsError}</p>}
            {!calls && !callsError && <p className={`text-caption ${faint}`}>Loading…</p>}
            {calls && calls.length === 0 && <p className={`text-caption ${faint}`}>No calls yet.</p>}
            {calls && calls.length > 0 && (
              <ul className="space-y-2">
                {calls.map((call) => (
                  <li key={call.id} className="flex justify-between gap-3 text-caption">
                    <span className={`font-mono truncate ${strong}`}>{call.tool ?? (call.operation === 'initialize' ? 'test' : call.operation)}</span>
                    <span className={`shrink-0 ${call.success ? faint : 'text-red-500'}`} title={formatDateTime(call.createdAt)}>
                      {call.agentName ?? 'You'} · {new Date(call.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} ·{' '}
                      {call.success ? `${call.durationMs} ms` : (call.errorCode ?? 'failed')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}

interface Styles {
  strong: string
  muted: string
  faint: string
  panel: string
  secondary: string
}

function ToolsPanel({ connector: c, isDark, styles, onCalled }: { connector: Connector; isDark: boolean; styles: Styles; onCalled: () => void }) {
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const tools = useMemo(() => c.tools ?? [], [c.tools])
  const q = filter.trim().toLowerCase()
  const shown = q ? tools.filter((t) => t.name.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q)) : tools

  return (
    <section className={`${styles.panel} flex-1 min-w-[320px] p-6 space-y-4`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className={`text-body font-semibold ${styles.strong}`}>
          Tools {c.tools && <span className={`font-normal ${styles.faint}`}>{c.tools.length}</span>}
        </h3>
        {tools.length > 4 && (
          <input
            type="search"
            aria-label="Filter tools"
            placeholder="Filter tools"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className={`w-56 px-3 py-1.5 rounded-lg text-body-sm outline-none border ${
              isDark ? 'bg-zinc-800 border-zinc-700 text-zinc-100' : 'bg-white border-neutral-200 text-neutral-900'
            }`}
          />
        )}
      </div>
      {!c.tools && (
        <p className={`text-body-sm ${styles.muted}`}>Test the connection to load the tools this server offers.</p>
      )}
      {c.tools && c.tools.length === 0 && <p className={`text-body-sm ${styles.muted}`}>This server offers no tools.</p>}
      {shown.length === 0 && tools.length > 0 && <p className={`text-body-sm ${styles.muted}`}>No tool matches “{filter}”.</p>}
      <ul className="space-y-2">
        {shown.map((tool) => (
          <ToolRow
            key={tool.name}
            connectorId={c.id}
            tool={tool}
            isOpen={open === tool.name}
            onToggle={() => setOpen(open === tool.name ? null : tool.name)}
            isDark={isDark}
            styles={styles}
            onCalled={onCalled}
          />
        ))}
      </ul>
    </section>
  )
}

function ToolRow({
  connectorId,
  tool,
  isOpen,
  onToggle,
  isDark,
  styles,
  onCalled,
}: {
  connectorId: string
  tool: ConnectorTool
  isOpen: boolean
  onToggle: () => void
  isDark: boolean
  styles: Styles
  onCalled: () => void
}) {
  const params = useMemo(() => toolParameters(tool), [tool])
  return (
    <li className={`rounded-xl border overflow-hidden ${isOpen ? (isDark ? 'border-zinc-500' : 'border-neutral-900') : isDark ? 'border-zinc-700/60' : 'border-neutral-200'}`}>
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={onToggle}
        className={`w-full px-4 py-3 flex items-start gap-3 text-left ${isOpen ? (isDark ? 'bg-zinc-800/60' : 'bg-neutral-50') : ''}`}
      >
        <span aria-hidden="true" className={`pt-0.5 text-caption ${styles.faint}`}>{isOpen ? '▾' : '▸'}</span>
        <span className="flex-1 min-w-0">
          <span className={`block font-mono text-body-sm font-medium ${styles.strong}`}>{tool.name}</span>
          {tool.description && <span className={`block text-body-sm leading-relaxed ${styles.muted} ${isOpen ? '' : 'line-clamp-1'}`}>{tool.description}</span>}
        </span>
        <span className={`shrink-0 text-caption ${styles.faint}`}>
          {params.length} parameter{params.length === 1 ? '' : 's'}
        </span>
      </button>
      {isOpen && (
        <div className={`p-4 flex flex-wrap gap-5 border-t ${isDark ? 'border-zinc-700/60' : 'border-neutral-200'}`}>
          <div className="flex-1 min-w-[220px] space-y-2.5">
            <div className={`text-[11px] font-medium tracking-wider uppercase ${styles.faint}`}>Parameters</div>
            {params.length === 0 ? (
              <p className={`text-caption ${styles.muted}`}>None.</p>
            ) : (
              <dl className="space-y-2">
                {params.map((p) => (
                  <div key={p.name} className="text-caption">
                    <dt className="flex gap-2 items-baseline">
                      <span className={`font-mono ${styles.strong}`}>
                        {p.name}
                        {p.required && <span className="text-red-500"> *</span>}
                      </span>
                      <span className={styles.faint}>{p.type === 'unknown' ? 'any' : p.type}</span>
                    </dt>
                    {(p.description || p.options || p.defaultText) && (
                      <dd className={`mt-0.5 ${styles.muted}`}>
                        {p.description}
                        {p.options && <span className={styles.faint}> {p.description ? '· ' : ''}{p.options.join(' · ')}</span>}
                        {p.defaultText && <span className={styles.faint}> · default {p.defaultText}</span>}
                      </dd>
                    )}
                  </div>
                ))}
              </dl>
            )}
          </div>
          <TryIt connectorId={connectorId} tool={tool} params={params} isDark={isDark} styles={styles} onCalled={onCalled} />
        </div>
      )}
    </li>
  )
}

function TryIt({
  connectorId,
  tool,
  params,
  isDark,
  styles,
  onCalled,
}: {
  connectorId: string
  tool: ConnectorTool
  params: ToolParameter[]
  isDark: boolean
  styles: Styles
  onCalled: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [fieldError, setFieldError] = useState<{ name: string; message: string } | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ConnectorToolCallResult | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)

  const run = async () => {
    setFieldError(null)
    setRequestError(null)
    let args: Record<string, unknown>
    try {
      args = argumentsFromForm(params, values)
    } catch (err) {
      if (err instanceof ArgumentError) {
        setFieldError({ name: err.parameter, message: err.message })
        return
      }
      throw err
    }
    setRunning(true)
    try {
      setResult(await apiClient.callConnectorTool(connectorId, tool.name, args))
      onCalled()
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : 'Could not run the tool')
    } finally {
      setRunning(false)
    }
  }

  const field = `w-full px-2.5 py-1.5 rounded-lg text-body-sm outline-none border ${
    isDark ? 'bg-zinc-800 border-zinc-700 text-zinc-100 focus:border-zinc-400' : 'bg-white border-neutral-300 text-neutral-900 focus:border-neutral-900'
  }`

  return (
    <div className="w-full md:w-[320px] shrink-0 space-y-2.5">
      <div className={`text-[11px] font-medium tracking-wider uppercase ${styles.faint}`}>Try it</div>
      {params.map((p) => {
        const id = `try-${tool.name}-${p.name}`
        const invalid = fieldError?.name === p.name
        return (
          <div key={p.name}>
            <label htmlFor={id} className={`block font-mono text-caption mb-1 ${styles.muted}`}>
              {p.name}
              {p.required && <span className="text-red-500"> *</span>}
            </label>
            {p.options ? (
              <select id={id} className={field} value={values[p.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}>
                <option value="">{p.defaultText ? `Default (${p.defaultText})` : p.required ? 'Choose…' : 'Leave out'}</option>
                {p.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : p.type === 'boolean' ? (
              <select id={id} className={field} value={values[p.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}>
                <option value="">{p.defaultText ? `Default (${p.defaultText})` : 'Leave out'}</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : p.type === 'object' || p.type === 'array' ? (
              <textarea
                id={id}
                rows={2}
                className={`${field} font-mono resize-y`}
                placeholder={p.type === 'array' ? '[ … ]' : '{ … }'}
                value={values[p.name] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
              />
            ) : (
              <input
                id={id}
                className={`${field} ${p.type === 'string' ? '' : 'font-mono'}`}
                inputMode={p.type === 'number' || p.type === 'integer' ? 'decimal' : undefined}
                placeholder={p.defaultText ? `Default: ${p.defaultText}` : undefined}
                value={values[p.name] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
              />
            )}
            {invalid && <p className="text-caption text-red-500 mt-1">{fieldError.message}</p>}
          </div>
        )
      })}
      <button type="button" className="btn-primary w-full disabled:opacity-50" disabled={running} onClick={() => void run()}>
        {running ? 'Running…' : 'Run tool'}
      </button>
      <p className={`text-[11px] leading-snug ${styles.faint}`}>Runs for real, with your token, and is logged. A tool that writes data writes it.</p>
      {requestError && <p className="text-caption text-red-500">{requestError}</p>}
      {result && (
        <div className="space-y-1">
          <div className={`text-caption ${result.ok ? (isDark ? 'text-emerald-300' : 'text-emerald-700') : 'text-red-500'}`}>
            {result.ok ? '✓ Done' : result.isError ? 'The tool reported an error' : `Failed: ${result.errorCode ?? 'error'}`} · {result.durationMs} ms
          </div>
          <pre className="max-h-72 overflow-auto p-3 rounded-lg bg-zinc-900 text-zinc-100 text-[11.5px] leading-relaxed font-mono whitespace-pre-wrap break-words">
            {result.error ?? resultText(result)}
          </pre>
        </div>
      )}
    </div>
  )
}

function SharingPanel({
  connector: c,
  projects,
  isDark,
  styles,
  onUpdated,
}: {
  connector: Connector
  projects: ProjectWithCounts[] | null
  isDark: boolean
  styles: Styles
  onUpdated: (c: Connector) => void
}) {
  const { addToast } = useToastStore()
  const [editing, setEditing] = useState(false)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)

  const start = () => {
    setSelection(new Set(c.sharedWith.map((s) => s.projectId)))
    setEditing(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      const updated = await apiClient.setConnectorShares(c.id, [...selection])
      onUpdated(updated)
      setEditing(false)
      addToast({
        message: updated.sharedWith.length
          ? `${c.name} is shared with ${updated.sharedWith.map((s) => s.projectName).join(', ')}`
          : `${c.name} is no longer shared`,
        type: 'success',
      })
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : 'Could not change sharing', type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={`${styles.panel} p-5 space-y-3`}>
      <div className="flex items-center justify-between">
        <h3 className={`text-body-sm font-semibold ${styles.strong}`}>Shared with</h3>
        {!editing && (
          <button type="button" onClick={start} className={`text-caption font-medium ${styles.muted} hover:underline underline-offset-2`}>
            Change
          </button>
        )}
      </div>
      {!editing ? (
        c.sharedWith.length ? (
          <div className="flex flex-wrap gap-1.5">
            {c.sharedWith.map((s) => (
              <span key={s.projectId} className={`px-2.5 py-1 rounded-full text-caption ${isDark ? 'bg-zinc-700/60 text-zinc-200' : 'bg-neutral-100 text-neutral-700'}`}>
                {s.projectName}
              </span>
            ))}
          </div>
        ) : (
          <p className={`text-caption ${styles.faint}`}>Only your agents can use it.</p>
        )
      ) : (
        <div className="space-y-2">
          {!projects && <p className={`text-caption ${styles.faint}`}>Loading projects…</p>}
          {projects && projects.length === 0 && <p className={`text-caption ${styles.faint}`}>You’re not in any project yet.</p>}
          <ul className="space-y-1 max-h-48 overflow-y-auto">
            {(projects ?? []).map((p) => (
              <li key={p.id}>
                <label className={`flex items-center gap-2 text-body-sm ${styles.strong}`}>
                  <input
                    type="checkbox"
                    checked={selection.has(p.id)}
                    onChange={(e) =>
                      setSelection((prev) => {
                        const next = new Set(prev)
                        if (e.target.checked) next.add(p.id)
                        else next.delete(p.id)
                        return next
                      })
                    }
                  />
                  <span className="truncate">{p.name}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex gap-2 pt-1">
            <button type="button" className="btn-primary disabled:opacity-50" disabled={saving} onClick={() => void save()}>Save</button>
            <button type="button" className={styles.secondary} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
      <p className={`text-caption leading-relaxed ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
        Members’ agents, including ones they uploaded, can call every tool with your token. The log shows you as the user.
      </p>
    </section>
  )
}
