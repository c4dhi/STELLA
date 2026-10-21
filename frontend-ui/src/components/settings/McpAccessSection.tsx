import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import { useToastStore } from '../../store/toastStore'
import { useFeatureFlagsStore } from '../../store/featureFlagsStore'
import { apiClient } from '../../services/ApiClient'
import ConfirmDialog from '../modals/ConfirmDialog'
import type { AccessToken, AccessTokenAccess, AccessTokenExpiryDays } from '../../lib/api-types'

const containerVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.1
    }
  }
}

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.4,
      ease: [0.25, 0.46, 0.45, 0.94] as const
    }
  }
}

const expiryOptions: { value: AccessTokenExpiryDays; label: string }[] = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 365, label: '1 year' },
]

const accessOptions: { value: AccessTokenAccess; label: string; description: string }[] = [
  {
    value: 'read_write',
    label: 'Read and write',
    description: 'Can list and read everything below, and create or change your personas, plans and agent configs.',
  },
  {
    value: 'read',
    label: 'Read only',
    description: 'Can list and read your personas, plans, agent configs, projects and session transcripts.',
  },
]

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })

function statusOf(token: AccessToken): 'active' | 'revoked' | 'expired' {
  if (token.revokedAt) return 'revoked'
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) return 'expired'
  return 'active'
}

export default function McpAccessSection() {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const { addToast } = useToastStore()
  const { mcpEnabled, loaded } = useFeatureFlagsStore()

  const [tokens, setTokens] = useState<AccessToken[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [expiresInDays, setExpiresInDays] = useState<AccessTokenExpiryDays>(90)
  const [access, setAccess] = useState<AccessTokenAccess>('read_write')
  const [creating, setCreating] = useState(false)
  const [newSecret, setNewSecret] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<AccessToken | null>(null)

  const mcpUrl = apiClient.getMcpUrl()

  const load = () => {
    apiClient.listAccessTokens()
      .then(setTokens)
      .catch(err => setLoadError(err instanceof Error ? err.message : 'Could not load your tokens'))
  }

  useEffect(load, [])

  const create = async () => {
    setCreating(true)
    try {
      const { token } = await apiClient.createAccessToken({ name: name.trim(), expiresInDays, access })
      setNewSecret(token)
      setName('')
      load()
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : 'Could not create the token', type: 'error' })
    } finally {
      setCreating(false)
    }
  }

  const revoke = async (token: AccessToken) => {
    setRevoking(null)
    try {
      await apiClient.revokeAccessToken(token.id)
      addToast({ message: `Revoked “${token.name}”. Clients using it are disconnected.`, type: 'success' })
      load()
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : 'Could not revoke the token', type: 'error' })
    }
  }

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      addToast({ message: `${what} copied`, type: 'success' })
    } catch {
      addToast({ message: 'Could not copy: select the text and copy it yourself', type: 'error' })
    }
  }

  const claudeCommand = (secret: string) =>
    `claude mcp add --transport http stella ${mcpUrl} --header "Authorization: Bearer ${secret}"`

  const card = `p-6 rounded-2xl ${isDark ? 'bg-surface-dark-secondary' : 'bg-white border border-neutral-200/60'}`
  const heading = `text-heading-sm font-semibold mb-2 ${isDark ? 'text-content-inverse' : 'text-content'}`
  const muted = isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
  const faint = isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
  const codeBox = `block w-full px-3 py-2 rounded-lg font-mono text-caption break-all ${
    isDark ? 'bg-surface-dark-tertiary text-content-inverse' : 'bg-surface-secondary text-content'
  }`
  const input = `w-full px-3 py-2 rounded-xl text-body-sm outline-none ${
    isDark
      ? 'bg-surface-dark-tertiary text-content-inverse border border-border-dark focus:border-primary-400'
      : 'bg-white text-content border border-neutral-200 focus:border-primary-500'
  }`

  if (loaded && !mcpEnabled) {
    return (
      <div className="max-w-2xl">
        <h2 className={`text-heading-lg mb-2 ${isDark ? 'text-content-inverse' : 'text-content'}`}>MCP Access</h2>
        <p className={`text-body-sm ${muted}`}>
          MCP access is switched off for this platform. A system admin can turn it on in Settings → Platform Defaults.
        </p>
      </div>
    )
  }

  return (
    <motion.div className="max-w-2xl space-y-6" variants={containerVariants} initial="hidden" animate="visible">
      <motion.div variants={itemVariants}>
        <h2 className={`text-heading-lg mb-2 ${isDark ? 'text-content-inverse' : 'text-content'}`}>
          MCP Access
        </h2>
        <p className={`text-body-sm ${muted}`}>
          Connect an AI client such as Claude Code to your STELLA account. It can then read and edit your personas,
          plans and agent configs, and read the sessions in your projects. It acts as you, with the access you give the token.
        </p>
      </motion.div>

      {/* The secret, shown once */}
      {newSecret && (
        <motion.div
          variants={itemVariants}
          className={`p-6 rounded-2xl ring-2 ${isDark ? 'ring-primary-400 bg-primary-500/10' : 'ring-primary-500 bg-primary-50'}`}
        >
          <h3 className={heading}>Copy your token now</h3>
          <p className={`text-body-sm mb-4 ${muted}`}>
            This is the only time it is shown. STELLA keeps only a fingerprint of it, so a lost token can’t be recovered:
            revoke it and create a new one.
          </p>
          <code className={codeBox}>{newSecret}</code>
          <div className="mt-3 flex gap-2">
            <button onClick={() => void copy(newSecret, 'Token')} className="btn-primary">Copy token</button>
          </div>

          <p className={`text-body-sm mt-6 mb-2 font-semibold ${isDark ? 'text-content-inverse' : 'text-content'}`}>
            Add it to Claude Code
          </p>
          <code className={codeBox}>{claudeCommand(newSecret)}</code>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => void copy(claudeCommand(newSecret), 'Command')}
              className={`px-4 py-2 rounded-xl text-body-sm font-medium ${
                isDark ? 'bg-surface-dark-tertiary text-content-inverse' : 'bg-white border border-neutral-200 text-content'
              }`}
            >
              Copy command
            </button>
            <button
              onClick={() => setNewSecret(null)}
              className={`px-4 py-2 rounded-xl text-body-sm font-medium ${muted}`}
            >
              Done
            </button>
          </div>
        </motion.div>
      )}

      {/* Create */}
      <motion.div variants={itemVariants} className={card}>
        <h3 className={heading}>New token</h3>
        <p className={`text-body-sm mb-5 ${muted}`}>
          Use one token per client, so you can revoke one without disconnecting the others.
        </p>

        <label className={`block text-caption mb-1 ${faint}`} htmlFor="mcp-token-name">Name</label>
        <input
          id="mcp-token-name"
          className={input}
          placeholder="e.g. Claude Code on my laptop"
          maxLength={100}
          value={name}
          onChange={e => setName(e.target.value)}
        />

        <label className={`block text-caption mt-4 mb-1 ${faint}`} htmlFor="mcp-token-expiry">Expires after</label>
        <select
          id="mcp-token-expiry"
          className={input}
          value={expiresInDays}
          onChange={e => setExpiresInDays(Number(e.target.value) as AccessTokenExpiryDays)}
        >
          {expiryOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <div role="radiogroup" aria-label="Access" className="mt-4 space-y-2">
          {accessOptions.map(option => {
            const isSelected = access === option.value
            return (
              <button
                key={option.value}
                role="radio"
                aria-checked={isSelected}
                onClick={() => setAccess(option.value)}
                className={`w-full flex items-start gap-4 p-4 rounded-xl text-left transition-all duration-200 ${
                  isSelected
                    ? isDark ? 'ring-2 ring-primary-400 bg-primary-500/10' : 'ring-2 ring-primary-500 bg-primary-50'
                    : isDark ? 'bg-surface-dark-tertiary hover:bg-surface-dark-tertiary/70' : 'bg-surface-secondary hover:bg-surface-tertiary'
                }`}
              >
                <span
                  className={`mt-0.5 w-5 h-5 flex-shrink-0 rounded-full border-2 flex items-center justify-center ${
                    isSelected ? 'border-primary-500' : isDark ? 'border-neutral-500' : 'border-neutral-300'
                  }`}
                >
                  {isSelected && <span className="w-2.5 h-2.5 rounded-full bg-primary-500" />}
                </span>
                <span className="flex-1 min-w-0">
                  <span className={`block text-body-sm font-semibold ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                    {option.label}
                  </span>
                  <span className={`block text-caption mt-0.5 ${faint}`}>{option.description}</span>
                </span>
              </button>
            )
          })}
        </div>

        <div className="mt-6 flex justify-end">
          <button
            onClick={() => void create()}
            disabled={!name.trim() || creating}
            className={`btn-primary ${name.trim() && !creating ? '' : 'opacity-40 cursor-not-allowed'}`}
          >
            {creating ? 'Creating…' : 'Create token'}
          </button>
        </div>
      </motion.div>

      {/* Existing tokens */}
      <motion.div variants={itemVariants} className={card}>
        <h3 className={heading}>Your tokens</h3>
        <p className={`text-caption mb-4 ${faint}`}>Endpoint: <span className="font-mono">{mcpUrl}</span></p>
        {loadError && <p className="text-body-sm text-red-500">{loadError}</p>}
        {tokens && tokens.length === 0 && (
          <p className={`text-body-sm ${muted}`}>No tokens yet.</p>
        )}
        {tokens && tokens.length > 0 && (
          <ul className="space-y-2">
            {tokens.map(token => {
              const status = statusOf(token)
              return (
                <li
                  key={token.id}
                  className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl ${
                    isDark ? 'bg-surface-dark-tertiary' : 'bg-surface-secondary'
                  } ${status === 'active' ? '' : 'opacity-60'}`}
                >
                  <div className="min-w-0">
                    <div className={`flex items-center gap-2 text-body-sm font-semibold ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                      <span className="truncate">{token.name}</span>
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        isDark ? 'bg-surface-dark text-content-inverse-tertiary' : 'bg-white text-content-tertiary border border-neutral-200'
                      }`}>
                        {token.scopes.includes('mcp:write') ? 'Read and write' : 'Read only'}
                      </span>
                      {status !== 'active' && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-500/10 text-red-500">
                          {status === 'revoked' ? 'Revoked' : 'Expired'}
                        </span>
                      )}
                    </div>
                    <div className={`text-caption mt-0.5 ${faint}`}>
                      <span className="font-mono">{token.displayPrefix}…</span>
                      {' · '}created {formatDate(token.createdAt)}
                      {' · '}{token.lastUsedAt ? `last used ${formatDate(token.lastUsedAt)}` : 'never used'}
                      {status === 'active' && token.expiresAt && <> · expires {formatDate(token.expiresAt)}</>}
                    </div>
                  </div>
                  {status === 'active' && (
                    <button
                      onClick={() => setRevoking(token)}
                      className="flex-shrink-0 px-3 py-1.5 rounded-lg text-caption font-medium text-red-500 hover:bg-red-500/10"
                    >
                      Revoke
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </motion.div>

      <ConfirmDialog
        isOpen={revoking !== null}
        title="Revoke this token?"
        message={`Clients using “${revoking?.name ?? ''}” lose access immediately. This can’t be undone.`}
        confirmText="Revoke"
        confirmVariant="danger"
        onConfirm={() => revoking && void revoke(revoking)}
        onCancel={() => setRevoking(null)}
      />
    </motion.div>
  )
}
