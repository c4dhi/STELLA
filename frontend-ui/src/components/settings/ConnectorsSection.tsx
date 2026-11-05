import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import { useToastStore } from '../../store/toastStore'
import { apiClient } from '../../services/ApiClient'
import ConfirmDialog from '../modals/ConfirmDialog'
import type { Connector, ConnectorAuthType, ProjectWithCounts } from '../../lib/api-types'

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.1 } },
}

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] as const },
  },
}

const HANDLE_PATTERN = /^[a-z][a-z0-9-]{0,39}$/

/** "ELIAS interview questions" → "elias-interview-questions" */
export function suggestHandle(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug
}

const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

interface FormState {
  name: string
  handle: string
  handleTouched: boolean
  url: string
  authType: ConnectorAuthType
  token: string
}

const emptyForm: FormState = { name: '', handle: '', handleTouched: false, url: '', authType: 'bearer', token: '' }

/**
 * Settings → Connectors: outside MCP servers this user's agents may call.
 * Here STELLA is the MCP *client*. The opposite direction (Claude/ChatGPT
 * calling STELLA) is MCP Access, a separate section.
 */
export default function ConnectorsSection() {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const { addToast } = useToastStore()

  const [connectors, setConnectors] = useState<Connector[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<{ name: string; url: string; token: string }>({ name: '', url: '', token: '' })
  const [deleting, setDeleting] = useState<Connector | null>(null)
  const [projects, setProjects] = useState<ProjectWithCounts[] | null>(null)
  const [sharing, setSharing] = useState<string | null>(null)
  const [shareSelection, setShareSelection] = useState<Set<string>>(new Set())

  const load = () => {
    apiClient.listConnectors()
      .then(list => { setConnectors(list); setLoadError(null) })
      .catch(err => setLoadError(err instanceof Error ? err.message : 'Could not load your connectors'))
  }

  useEffect(() => {
    load()
    apiClient.listProjects().then(setProjects).catch(() => setProjects([]))
  }, [])

  const startShare = (c: Connector) => {
    setSharing(c.id)
    setShareSelection(new Set(c.sharedWith.map(s => s.projectId)))
  }

  const saveShares = async (c: Connector) => {
    try {
      const updated = await apiClient.setConnectorShares(c.id, [...shareSelection])
      replace(updated)
      setSharing(null)
      addToast({
        message: updated.sharedWith.length
          ? `${c.name} is shared with ${updated.sharedWith.map(s => s.projectName).join(', ')}`
          : `${c.name} is no longer shared`,
        type: 'success',
      })
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : 'Could not change sharing', type: 'error' })
    }
  }

  const replace = (c: Connector) =>
    setConnectors(prev => (prev ?? []).map(x => (x.id === c.id ? c : x)))

  const test = async (c: Connector) => {
    setTesting(c.id)
    try {
      const res = await apiClient.testConnector(c.id)
      replace(res.connector)
      if (res.ok) {
        const n = res.connector.tools?.length ?? 0
        addToast({ message: `${c.name}: connected, ${n} tool${n === 1 ? '' : 's'}`, type: 'success' })
        setExpanded(c.id)
      } else {
        addToast({ message: `${c.name}: ${res.error ?? 'connection failed'}`, type: 'error' })
      }
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : 'Could not test the connector', type: 'error' })
    } finally {
      setTesting(null)
    }
  }

  const create = async () => {
    setSaving(true)
    try {
      const created = await apiClient.createConnector({
        name: form.name.trim(),
        handle: form.handle,
        url: form.url.trim(),
        authType: form.authType,
        token: form.authType === 'bearer' ? form.token.trim() : undefined,
      })
      setForm(emptyForm)
      setConnectors(prev => [...(prev ?? []), created])
      // Test right away: an untested connector is the usual source of confusion.
      void test(created)
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : 'Could not add the connector', type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const startEdit = (c: Connector) => {
    setEditing(c.id)
    setEditForm({ name: c.name, url: c.url, token: '' })
  }

  const saveEdit = async (c: Connector) => {
    try {
      const updated = await apiClient.updateConnector(c.id, {
        name: editForm.name.trim() !== c.name ? editForm.name.trim() : undefined,
        url: editForm.url.trim() !== c.url ? editForm.url.trim() : undefined,
        token: editForm.token.trim() ? editForm.token.trim() : undefined,
      })
      replace(updated)
      setEditing(null)
      addToast({ message: `Saved ${updated.name}`, type: 'success' })
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : 'Could not save the connector', type: 'error' })
    }
  }

  const remove = async (c: Connector) => {
    setDeleting(null)
    try {
      await apiClient.deleteConnector(c.id)
      setConnectors(prev => (prev ?? []).filter(x => x.id !== c.id))
      addToast({ message: `Deleted ${c.name}. Agents it was bound to can no longer reach it.`, type: 'success' })
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : 'Could not delete the connector', type: 'error' })
    }
  }

  const card = `p-6 rounded-2xl ${isDark ? 'bg-surface-dark-secondary' : 'bg-white border border-neutral-200/60'}`
  const heading = `text-heading-sm font-semibold mb-2 ${isDark ? 'text-content-inverse' : 'text-content'}`
  const strong = isDark ? 'text-content-inverse' : 'text-content'
  const muted = isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
  const faint = isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
  const input = `w-full px-3 py-2 rounded-xl text-body-sm outline-none ${
    isDark
      ? 'bg-surface-dark-tertiary text-content-inverse border border-border-dark focus:border-primary-400'
      : 'bg-white text-content border border-neutral-200 focus:border-primary-500'
  }`
  const secondaryButton = `px-3 py-1.5 rounded-lg text-caption font-medium disabled:opacity-50 ${
    isDark ? 'bg-surface-dark text-content-inverse' : 'bg-white border border-neutral-200 text-content'
  }`
  const row = `px-4 py-3 rounded-xl ${isDark ? 'bg-surface-dark-tertiary' : 'bg-surface-secondary'}`

  const handleValid = HANDLE_PATTERN.test(form.handle)
  const canCreate =
    form.name.trim() !== '' &&
    handleValid &&
    form.url.trim() !== '' &&
    (form.authType === 'none' || form.token.trim() !== '') &&
    !saving

  const statusBadge = (c: Connector) => {
    const styles = {
      ok: 'bg-emerald-500/15 text-emerald-600',
      error: 'bg-red-500/15 text-red-500',
      untested: isDark ? 'bg-surface-dark text-content-inverse-tertiary' : 'bg-white text-content-tertiary border border-neutral-200',
    }[c.status]
    const label = { ok: 'Connected', error: 'Failed', untested: 'Not tested' }[c.status]
    return <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${styles}`}>{label}</span>
  }

  return (
    <motion.div className="max-w-2xl space-y-6" variants={containerVariants} initial="hidden" animate="visible">
      <motion.div variants={itemVariants}>
        <h2 className={`text-heading-lg mb-2 ${strong}`}>Connectors</h2>
        <p className={`text-body-sm ${muted}`}>
          Outside MCP servers your agents can use, such as an interview-question service or a study’s own API. When you
          deploy an agent, you choose which connectors it may call. STELLA makes the calls for the agent, so your
          token stays here and never reaches the agent. Share a connector with a project to let its members’ agents
          use it too.
        </p>
        <p className={`text-caption mt-2 ${faint}`}>
          This is the opposite of MCP Access, which lets Claude or ChatGPT reach STELLA.
        </p>
      </motion.div>

      {loadError && (
        <motion.div variants={itemVariants} className="text-body-sm text-red-500">{loadError}</motion.div>
      )}

      {/* Your connectors */}
      <motion.div variants={itemVariants} className={card}>
        <h3 className={heading}>Your connectors</h3>
        {connectors && connectors.length === 0 && (
          <p className={`text-body-sm ${muted}`}>No connectors yet. Add one below.</p>
        )}
        {connectors && connectors.length > 0 && (
          <ul className="space-y-2 mt-3">
            {connectors.map(c => (
              <li key={c.id} className={row}>
                {editing === c.id ? (
                  <div className="space-y-3">
                    <div>
                      <label className={`block text-caption mb-1 ${faint}`} htmlFor={`cn-name-${c.id}`}>Name</label>
                      <input id={`cn-name-${c.id}`} className={input} maxLength={100} value={editForm.name}
                        onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} />
                    </div>
                    <div>
                      <label className={`block text-caption mb-1 ${faint}`} htmlFor={`cn-url-${c.id}`}>URL</label>
                      <input id={`cn-url-${c.id}`} className={input} value={editForm.url}
                        onChange={e => setEditForm(f => ({ ...f, url: e.target.value }))} />
                    </div>
                    {c.authType === 'bearer' && (
                      <div>
                        <label className={`block text-caption mb-1 ${faint}`} htmlFor={`cn-token-${c.id}`}>New token</label>
                        <input id={`cn-token-${c.id}`} className={input} type="password" autoComplete="off"
                          placeholder="Leave empty to keep the current token" value={editForm.token}
                          onChange={e => setEditForm(f => ({ ...f, token: e.target.value }))} />
                      </div>
                    )}
                    <div className="flex gap-2">
                      <button className="btn-primary" onClick={() => void saveEdit(c)}>Save</button>
                      <button className={secondaryButton} onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className={`flex items-center gap-2 text-body-sm font-semibold ${strong}`}>
                          <span className="truncate">{c.name}</span>
                          {statusBadge(c)}
                        </div>
                        <div className={`text-caption mt-0.5 font-mono truncate ${faint}`} title={c.url}>
                          {c.handle} · {c.url}
                        </div>
                        <div className={`text-caption mt-0.5 ${faint}`}>
                          {c.authType === 'bearer' ? 'Bearer token saved' : 'No authentication'}
                          {c.lastCheckedAt && ` · checked ${formatDateTime(c.lastCheckedAt)}`}
                          {c.tools && ` · ${c.tools.length} tool${c.tools.length === 1 ? '' : 's'}`}
                        </div>
                        <div className={`text-caption mt-0.5 ${faint}`}>
                          {c.sharedWith.length
                            ? <>Shared with: <span className={muted}>{c.sharedWith.map(s => s.projectName).join(', ')}</span></>
                            : 'Not shared: only your own agents can use it'}
                        </div>
                        {c.status === 'error' && c.lastError && (
                          <div className="text-caption mt-1 text-red-500">{c.lastError}</div>
                        )}
                      </div>
                      <div className="flex flex-shrink-0 gap-1">
                        <button className={secondaryButton} disabled={testing === c.id} onClick={() => void test(c)}>
                          {testing === c.id ? 'Testing…' : 'Test connection'}
                        </button>
                        <button className={secondaryButton} onClick={() => (sharing === c.id ? setSharing(null) : startShare(c))}>Share</button>
                        <button className={secondaryButton} onClick={() => startEdit(c)}>Edit</button>
                        <button
                          onClick={() => setDeleting(c)}
                          className="px-3 py-1.5 rounded-lg text-caption font-medium text-red-500 hover:bg-red-500/10"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    {sharing === c.id && (
                      <div className={`mt-3 p-3 rounded-lg ${isDark ? 'bg-surface-dark' : 'bg-white border border-neutral-200'}`}>
                        <p className={`text-caption mb-2 ${muted}`}>
                          Members of these projects can let their agents use this connector. They never see your
                          token and can’t change the connector. Unsharing stops their agents at once.
                        </p>
                        {projects && projects.length === 0 && (
                          <p className={`text-caption ${faint}`}>You’re not in any project yet.</p>
                        )}
                        {!projects && <p className={`text-caption ${faint}`}>Loading projects…</p>}
                        <ul className="space-y-1 max-h-48 overflow-y-auto">
                          {(projects ?? []).map(p => (
                            <li key={p.id}>
                              <label className={`flex items-center gap-2 text-body-sm ${strong}`}>
                                <input
                                  type="checkbox"
                                  checked={shareSelection.has(p.id)}
                                  onChange={e => setShareSelection(prev => {
                                    const next = new Set(prev)
                                    if (e.target.checked) next.add(p.id)
                                    else next.delete(p.id)
                                    return next
                                  })}
                                />
                                <span className="truncate">{p.name}</span>
                              </label>
                            </li>
                          ))}
                        </ul>
                        <div className="flex gap-2 mt-3">
                          <button className="btn-primary" onClick={() => void saveShares(c)}>Save sharing</button>
                          <button className={secondaryButton} onClick={() => setSharing(null)}>Cancel</button>
                        </div>
                      </div>
                    )}
                    {c.tools && c.tools.length > 0 && (
                      <div className="mt-2">
                        <button
                          className={`text-caption font-medium ${muted}`}
                          aria-expanded={expanded === c.id}
                          onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                        >
                          {expanded === c.id ? 'Hide tools' : 'Show tools'}
                        </button>
                        {expanded === c.id && (
                          <ul className="mt-2 space-y-1">
                            {c.tools.map(t => (
                              <li key={t.name} className="text-caption">
                                <span className={`font-mono ${strong}`}>{t.name}</span>
                                {t.description && <span className={faint}> · {t.description}</span>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </motion.div>

      {/* Add */}
      <motion.div variants={itemVariants} className={card}>
        <h3 className={heading}>Add a connector</h3>
        <p className={`text-body-sm mb-5 ${muted}`}>
          The server must speak MCP over Streamable HTTP. STELLA tests it as soon as you add it.
        </p>

        <label className={`block text-caption mb-1 ${faint}`} htmlFor="cn-name">Name</label>
        <input
          id="cn-name"
          className={input}
          placeholder="e.g. ELIAS interview questions"
          maxLength={100}
          value={form.name}
          onChange={e => {
            const name = e.target.value
            setForm(f => ({ ...f, name, handle: f.handleTouched ? f.handle : suggestHandle(name) }))
          }}
        />

        <label className={`block text-caption mt-4 mb-1 ${faint}`} htmlFor="cn-handle">Handle</label>
        <input
          id="cn-handle"
          className={`${input} font-mono`}
          placeholder="elias"
          maxLength={40}
          value={form.handle}
          onChange={e => setForm(f => ({ ...f, handle: e.target.value, handleTouched: true }))}
        />
        <p className={`text-caption mt-1 ${form.handle && !handleValid ? 'text-red-500' : faint}`}>
          How an agent refers to this connector when you offer it as an extra. Lowercase letters, digits and hyphens.
        </p>

        <label className={`block text-caption mt-4 mb-1 ${faint}`} htmlFor="cn-url">URL</label>
        <input
          id="cn-url"
          className={input}
          placeholder="https://elias.apps.c4dhi.org/mcp"
          value={form.url}
          onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
        />
        <p className={`text-caption mt-1 ${faint}`}>The server’s MCP endpoint, usually ending in /mcp. No trailing slash.</p>

        <label className={`block text-caption mt-4 mb-1 ${faint}`} htmlFor="cn-auth">Authentication</label>
        <select
          id="cn-auth"
          className={input}
          value={form.authType}
          onChange={e => setForm(f => ({ ...f, authType: e.target.value as ConnectorAuthType }))}
        >
          <option value="bearer">Bearer token</option>
          <option value="none">None</option>
        </select>

        {form.authType === 'bearer' && (
          <>
            <label className={`block text-caption mt-4 mb-1 ${faint}`} htmlFor="cn-token">Token</label>
            <input
              id="cn-token"
              className={input}
              type="password"
              autoComplete="off"
              placeholder="Paste the token the server gave you"
              value={form.token}
              onChange={e => setForm(f => ({ ...f, token: e.target.value }))}
            />
            <p className={`text-caption mt-1 ${faint}`}>
              Stored encrypted. STELLA never shows it again, not even to you.
            </p>
          </>
        )}

        <div className="mt-5">
          <button className="btn-primary disabled:opacity-50" disabled={!canCreate} onClick={() => void create()}>
            {saving ? 'Adding…' : 'Add connector'}
          </button>
        </div>
      </motion.div>

      <ConfirmDialog
        isOpen={deleting !== null}
        title={`Delete ${deleting?.name ?? 'this connector'}?`}
        message="Its token is deleted too. Agents it was bound to can no longer reach it. This can’t be undone."
        confirmText="Delete"
        confirmVariant="danger"
        onConfirm={() => deleting && void remove(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </motion.div>
  )
}
