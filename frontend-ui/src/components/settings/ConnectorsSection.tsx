import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useSearchParams } from 'react-router-dom'
import { useThemeStore } from '../../store/themeStore'
import { useToastStore } from '../../store/toastStore'
import { apiClient } from '../../services/ApiClient'
import ConfirmDialog from '../modals/ConfirmDialog'
import type { Connector, ProjectWithCounts } from '../../lib/api-types'
import ConnectorCard from './connectors/ConnectorCard'
import ConnectorDetail from './connectors/ConnectorDetail'
import ConnectorEditorModal from './connectors/ConnectorEditorModal'

export { suggestHandle } from './connectors/ConnectorEditorModal'

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05 } },
}

const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.25, 0.46, 0.45, 0.94] as const } },
}

/**
 * Settings → Connectors: outside MCP servers this user's agents may call, as a
 * grid of cards. A card opens the connector's detail (?connector=<id>), with
 * its tools, a form to run each one, and its latest calls.
 * Here STELLA is the MCP *client*; the opposite direction is MCP Access.
 */
export default function ConnectorsSection() {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const { addToast } = useToastStore()
  const [searchParams, setSearchParams] = useSearchParams()
  const openId = searchParams.get('connector')

  const [connectors, setConnectors] = useState<Connector[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [projects, setProjects] = useState<ProjectWithCounts[] | null>(null)
  const [editor, setEditor] = useState<{ connector: Connector | null } | null>(null)
  const [deleting, setDeleting] = useState<Connector | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    apiClient
      .listConnectors()
      .then((list) => {
        setConnectors(list)
        setLoadError(null)
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Could not load your connectors'))
    apiClient.listProjects().then(setProjects).catch(() => setProjects([]))
  }, [])

  const open = (id: string | null) => {
    const next = new URLSearchParams(searchParams)
    if (id) next.set('connector', id)
    else next.delete('connector')
    setSearchParams(next)
  }

  const replace = (c: Connector) => setConnectors((prev) => (prev ?? []).map((x) => (x.id === c.id ? c : x)))

  const test = async (c: Connector) => {
    setTesting(c.id)
    try {
      const res = await apiClient.testConnector(c.id)
      replace(res.connector)
      if (res.ok) {
        const n = res.connector.tools?.length ?? 0
        addToast({ message: `${c.name}: connected, ${n} tool${n === 1 ? '' : 's'}`, type: 'success' })
      } else {
        addToast({ message: `${c.name}: ${res.error ?? 'connection failed'}`, type: 'error' })
      }
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : 'Could not test the connector', type: 'error' })
    } finally {
      setTesting(null)
      setRefreshKey((k) => k + 1)
    }
  }

  const saved = (c: Connector, created: boolean) => {
    setEditor(null)
    if (created) {
      setConnectors((prev) => [...(prev ?? []), c])
      open(c.id)
    } else {
      replace(c)
      addToast({ message: `Saved ${c.name}`, type: 'success' })
    }
    // A new connector, or one whose URL or token changed, is untested: test it
    // right away, since an untested connector is the usual source of confusion.
    if (c.status === 'untested') void test(c)
  }

  const remove = async (c: Connector) => {
    setDeleting(null)
    try {
      await apiClient.deleteConnector(c.id)
      setConnectors((prev) => (prev ?? []).filter((x) => x.id !== c.id))
      setEditor(null)
      open(null)
      addToast({ message: `Deleted ${c.name}. Agents it was bound to can no longer reach it.`, type: 'success' })
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : 'Could not delete the connector', type: 'error' })
    }
  }

  const strong = isDark ? 'text-content-inverse' : 'text-content'
  const muted = isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
  const current = openId ? connectors?.find((c) => c.id === openId) : undefined

  const dialogs = (
    <>
      <ConnectorEditorModal
        isOpen={editor !== null}
        connector={editor?.connector ?? null}
        onClose={() => setEditor(null)}
        onSaved={saved}
        onDelete={(c) => setDeleting(c)}
      />
      <ConfirmDialog
        isOpen={deleting !== null}
        title={`Delete ${deleting?.name ?? 'this connector'}?`}
        message="Its token is deleted too. Agents it was bound to can no longer reach it. This can’t be undone."
        confirmText="Delete"
        confirmVariant="danger"
        onConfirm={() => deleting && void remove(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </>
  )

  if (openId && connectors) {
    return (
      <div className="max-w-6xl">
        {current ? (
          <ConnectorDetail
            connector={current}
            projects={projects}
            isDark={isDark}
            refreshKey={refreshKey}
            testing={testing === current.id}
            onBack={() => open(null)}
            onTest={() => void test(current)}
            onEdit={() => setEditor({ connector: current })}
            onUpdated={replace}
          />
        ) : (
          <div className="space-y-3">
            <button type="button" onClick={() => open(null)} className={`text-body-sm ${muted} hover:underline underline-offset-2`}>
              ← All connectors
            </button>
            <p className={`text-body-sm ${muted}`}>This connector does not exist, or it is not yours.</p>
          </div>
        )}
        {dialogs}
      </div>
    )
  }

  return (
    <motion.div className="max-w-6xl space-y-6" variants={containerVariants} initial="hidden" animate="visible">
      <motion.div variants={itemVariants} className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className={`text-heading-lg mb-2 ${strong}`}>Connectors</h2>
          <p className={`text-body-sm ${muted}`}>
            Outside MCP servers your agents may call. You choose them when you deploy an agent. STELLA makes the calls,
            so your token never reaches the agent.
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setEditor({ connector: null })}>
          + Add connector
        </button>
      </motion.div>

      {loadError && <motion.p variants={itemVariants} className="text-body-sm text-red-500">{loadError}</motion.p>}
      {!connectors && !loadError && <p className={`text-body-sm ${muted}`}>Loading your connectors…</p>}

      {connectors && (
        <motion.div variants={itemVariants} className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
          {connectors.map((c) => (
            <ConnectorCard key={c.id} connector={c} isDark={isDark} onOpen={() => open(c.id)} />
          ))}
          <button
            type="button"
            onClick={() => setEditor({ connector: null })}
            className={`min-h-[188px] rounded-2xl border-[1.5px] border-dashed flex flex-col items-center justify-center gap-2 text-body-sm font-medium transition-colors ${
              isDark ? 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200' : 'border-neutral-300 text-neutral-500 hover:border-neutral-500 hover:text-neutral-800'
            }`}
          >
            <span aria-hidden="true" className="text-2xl leading-none">+</span>
            {connectors.length === 0 ? 'Add your first connector' : 'Add a connector'}
          </button>
        </motion.div>
      )}

      {dialogs}
    </motion.div>
  )
}
