import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useThemeStore } from '../../../store/themeStore'
import { apiClient } from '../../../services/ApiClient'
import EmojiPicker from '../../EmojiPicker'
import type { Connector, ConnectorAuthType } from '../../../lib/api-types'
import { CONNECTOR_EMOJIS, DEFAULT_CONNECTOR_ICON } from './connectorUi'

const HANDLE_PATTERN = /^[a-z][a-z0-9-]{0,39}$/

/** "ELIAS interview questions" → "elias-interview-questions" */
export function suggestHandle(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

interface FormState {
  icon: string
  name: string
  description: string
  handle: string
  handleTouched: boolean
  url: string
  authType: ConnectorAuthType
  token: string
}

function formFor(c: Connector | null): FormState {
  return {
    icon: c?.icon || DEFAULT_CONNECTOR_ICON,
    name: c?.name ?? '',
    description: c?.description ?? '',
    handle: c?.handle ?? '',
    handleTouched: !!c,
    url: c?.url ?? '',
    authType: c?.authType ?? 'bearer',
    token: '',
  }
}

interface ConnectorEditorModalProps {
  isOpen: boolean
  /** Null adds a new connector. */
  connector: Connector | null
  onClose: () => void
  onSaved: (connector: Connector, created: boolean) => void
  onDelete?: (connector: Connector) => void
}

/** Add or edit a connector: icon, name, description, then how to reach it. */
export default function ConnectorEditorModal({ isOpen, connector, onClose, onSaved, onDelete }: ConnectorEditorModalProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const [form, setForm] = useState<FormState>(formFor(connector))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen) {
      setForm(formFor(connector))
      setError(null)
    }
  }, [isOpen, connector])

  const editing = connector !== null
  const handleValid = HANDLE_PATTERN.test(form.handle)
  // A bearer connector needs a token when added, or when switched from "none".
  const needsToken = form.authType === 'bearer' && (!editing || !connector.hasCredential)
  const canSave =
    form.name.trim() !== '' && handleValid && form.url.trim() !== '' && (!needsToken || form.token.trim() !== '') && !saving

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      if (!editing) {
        const created = await apiClient.createConnector({
          name: form.name.trim(),
          icon: form.icon,
          description: form.description.trim() || undefined,
          handle: form.handle,
          url: form.url.trim(),
          authType: form.authType,
          token: form.authType === 'bearer' ? form.token.trim() : undefined,
        })
        onSaved(created, true)
      } else {
        const c = connector
        const updated = await apiClient.updateConnector(c.id, {
          name: form.name.trim() !== c.name ? form.name.trim() : undefined,
          icon: form.icon !== (c.icon || DEFAULT_CONNECTOR_ICON) ? form.icon : undefined,
          description: form.description.trim() !== (c.description ?? '') ? form.description.trim() : undefined,
          handle: form.handle !== c.handle ? form.handle : undefined,
          url: form.url.trim() !== c.url ? form.url.trim() : undefined,
          authType: form.authType !== c.authType ? form.authType : undefined,
          token: form.authType === 'bearer' && form.token.trim() ? form.token.trim() : undefined,
        })
        onSaved(updated, false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the connector')
    } finally {
      setSaving(false)
    }
  }

  const label = `block text-caption font-medium mb-1.5 ${isDark ? 'text-zinc-300' : 'text-neutral-700'}`
  const hint = `text-caption mt-1.5 ${isDark ? 'text-zinc-500' : 'text-neutral-500'}`
  const input = `w-full px-3 py-2.5 rounded-xl text-body-sm outline-none border transition-colors ${
    isDark
      ? 'bg-zinc-800 text-zinc-100 border-zinc-700 focus:border-primary-400'
      : 'bg-white text-neutral-900 border-neutral-300 focus:border-neutral-900'
  }`
  const secondary = `px-4 py-2 rounded-xl text-body-sm font-medium border ${
    isDark ? 'border-zinc-700 text-zinc-100 hover:bg-zinc-800' : 'border-neutral-200 text-neutral-900 hover:bg-neutral-50'
  }`

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            aria-label={editing ? `Edit ${connector.name}` : 'Add a connector'}
            className={`w-full max-w-xl max-h-[90vh] flex flex-col rounded-2xl shadow-2xl ${
              isDark ? 'bg-zinc-900 border border-zinc-700' : 'bg-white border border-neutral-200'
            }`}
            initial={{ opacity: 0, scale: 0.97, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 12 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              <div>
                <h2 className={`text-lg font-semibold ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                  {editing ? 'Edit connector' : 'Add a connector'}
                </h2>
                <p className={hint}>An MCP server over Streamable HTTP. STELLA tests it as soon as you save.</p>
              </div>

              <div className="flex gap-4 items-end">
                <div>
                  <span className={label}>Icon</span>
                  <EmojiPicker
                    value={form.icon}
                    onChange={(icon) => setForm((f) => ({ ...f, icon }))}
                    options={CONNECTOR_EMOJIS}
                  />
                </div>
                <div className="flex-1">
                  <label className={label} htmlFor="cn-name">Name</label>
                  <input
                    id="cn-name"
                    className={input}
                    placeholder="e.g. ELIAS interview questions"
                    maxLength={100}
                    value={form.name}
                    onChange={(e) => {
                      const name = e.target.value
                      setForm((f) => ({ ...f, name, handle: f.handleTouched ? f.handle : suggestHandle(name) }))
                    }}
                  />
                </div>
              </div>

              <div>
                <label className={label} htmlFor="cn-description">Description</label>
                <textarea
                  id="cn-description"
                  rows={2}
                  maxLength={500}
                  className={`${input} resize-none`}
                  placeholder="What it is for, e.g. Reads the question bank and stores answers."
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                />
                <p className={hint}>In your words. Shown on the card and in the deploy wizard.</p>
              </div>

              <div>
                <label className={label} htmlFor="cn-url">Server URL</label>
                <input
                  id="cn-url"
                  className={`${input} font-mono`}
                  placeholder="https://elias.apps.c4dhi.org/mcp"
                  value={form.url}
                  onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                />
                <p className={hint}>The server’s MCP endpoint, usually ending in /mcp.</p>
              </div>

              <div className="flex gap-3">
                <div className="w-40">
                  <label className={label} htmlFor="cn-auth">Authentication</label>
                  <select
                    id="cn-auth"
                    className={input}
                    value={form.authType}
                    onChange={(e) => setForm((f) => ({ ...f, authType: e.target.value as ConnectorAuthType }))}
                  >
                    <option value="bearer">Bearer token</option>
                    <option value="none">None</option>
                  </select>
                </div>
                {form.authType === 'bearer' && (
                  <div className="flex-1">
                    <label className={label} htmlFor="cn-token">{editing && connector.hasCredential ? 'New token' : 'Token'}</label>
                    <input
                      id="cn-token"
                      className={input}
                      type="password"
                      autoComplete="off"
                      placeholder={editing && connector.hasCredential ? 'Leave empty to keep the current token' : 'Paste the token the server gave you'}
                      value={form.token}
                      onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
                    />
                  </div>
                )}
              </div>
              {form.authType === 'bearer' && <p className={`${hint} -mt-3`}>Stored encrypted. STELLA never shows it again.</p>}

              <details className={`text-body-sm ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`} open={form.handle !== '' && !handleValid}>
                <summary className="cursor-pointer font-medium">
                  Advanced · handle <span className={`font-mono ${isDark ? 'text-zinc-200' : 'text-neutral-900'}`}>{form.handle || '…'}</span>
                </summary>
                <div className="mt-3">
                  <label className={label} htmlFor="cn-handle">Handle</label>
                  <input
                    id="cn-handle"
                    className={`${input} font-mono`}
                    maxLength={40}
                    value={form.handle}
                    onChange={(e) => setForm((f) => ({ ...f, handle: e.target.value, handleTouched: true }))}
                  />
                  <p className={`text-caption mt-1.5 ${form.handle && !handleValid ? 'text-red-500' : isDark ? 'text-zinc-500' : 'text-neutral-500'}`}>
                    How an agent’s code names this connector. Made from the name; change it only if an agent expects a
                    fixed handle. Lowercase letters, digits and hyphens.
                  </p>
                </div>
              </details>

              {error && <p className="text-body-sm text-red-500">{error}</p>}
            </div>

            <div className={`flex items-center gap-2 px-6 py-4 border-t rounded-b-2xl ${isDark ? 'border-zinc-800 bg-zinc-900' : 'border-neutral-100 bg-neutral-50'}`}>
              {editing && onDelete && (
                <button
                  type="button"
                  onClick={() => onDelete(connector)}
                  className={`px-3 py-2 rounded-xl text-body-sm font-medium text-red-500 ${isDark ? 'hover:bg-red-500/10' : 'hover:bg-red-50'}`}
                >
                  Delete connector
                </button>
              )}
              <div className="ml-auto flex gap-2">
                <button type="button" className={secondary} onClick={onClose}>Cancel</button>
                <button type="button" className="btn-primary disabled:opacity-50" disabled={!canSave} onClick={() => void save()}>
                  {saving ? 'Saving…' : editing ? 'Save' : 'Save and test'}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
