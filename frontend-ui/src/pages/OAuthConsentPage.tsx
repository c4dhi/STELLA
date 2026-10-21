import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { AlertCircle, ShieldCheck } from 'lucide-react'
import { apiClient } from '../services/ApiClient'
import { useAuthStore } from '../store/authStore'
import { OnboardingLayout, OnboardingCard, StellaBranding, GradientButton } from '../components/onboarding'
import type { AccessTokenAccess, OAuthAuthorizationRequestView } from '../lib/api-types'

const accessOptions: { value: AccessTokenAccess; label: string; description: string }[] = [
  {
    value: 'read_write',
    label: 'Read and write',
    description: 'Everything read only allows, and also create or change your personas, plans and agent configs.',
  },
  {
    value: 'read',
    label: 'Read only',
    description: 'Read your personas, plans and agent configs, and the sessions and transcripts in your projects.',
  },
]

/**
 * MCP sign-in consent (#772). An app such as Claude or ChatGPT sent the user
 * here from STELLA's /authorize; ProtectedRoute has already made sure they
 * are signed in. Allow or Deny sends the browser back to the app.
 */
export default function OAuthConsentPage() {
  const [searchParams] = useSearchParams()
  const requestId = searchParams.get('request')
  const { user } = useAuthStore()
  const [request, setRequest] = useState<OAuthAuthorizationRequestView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [access, setAccess] = useState<AccessTokenAccess>('read_write')
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null)

  useEffect(() => {
    if (!requestId) {
      setError('This link is missing its sign-in request. Start connecting again from the app.')
      return
    }
    apiClient.getOAuthRequest(requestId)
      .then(view => {
        setRequest(view)
        // Offer only what the app asked for.
        if (!view.requestedScopes.includes('mcp:write')) setAccess('read')
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Could not load this sign-in request'))
  }, [requestId])

  const answer = async (choice: 'approve' | 'deny') => {
    if (!request) return
    setBusy(choice)
    try {
      const { redirectUrl } = choice === 'approve'
        ? await apiClient.approveOAuthRequest(request.id, access)
        : await apiClient.denyOAuthRequest(request.id)
      window.location.assign(redirectUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Start connecting again from the app.')
      setBusy(null)
    }
  }

  const canWrite = request?.requestedScopes.includes('mcp:write') ?? false
  const options = accessOptions.filter(o => o.value === 'read' || canWrite)

  return (
    <OnboardingLayout>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
        className="w-full max-w-[480px]"
      >
        <StellaBranding size="sm" />

        <OnboardingCard contentClassName="p-8 sm:p-10">
          {error && (
            <div className="flex items-start gap-3 text-sm text-red-500">
              <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <p>{error}</p>
            </div>
          )}

          {!error && !request && (
            <p className="text-sm text-content-tertiary dark:text-content-inverse-tertiary">Loading…</p>
          )}

          {!error && request && (
            <>
              <div className="flex items-center gap-3 mb-6">
                {request.logoUri ? (
                  <img src={request.logoUri} alt="" className="w-10 h-10 rounded-lg object-contain" referrerPolicy="no-referrer" />
                ) : (
                  <ShieldCheck className="w-10 h-10 text-primary-500" />
                )}
                <div className="min-w-0">
                  <h2 className="text-xl font-light text-content dark:text-content-inverse">
                    Connect {request.clientName} to STELLA?
                  </h2>
                  <p className="text-xs text-content-tertiary dark:text-content-inverse-tertiary">
                    Signed in as {user?.email}
                  </p>
                </div>
              </div>

              <p className="text-sm font-light text-content-secondary dark:text-content-inverse-secondary mb-5">
                {request.clientName} will act as you in STELLA, with the access you choose below, until you disconnect it
                in Settings → MCP Access.
              </p>

              <div role="radiogroup" aria-label="Access" className="space-y-2 mb-5">
                {options.map(option => {
                  const selected = access === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setAccess(option.value)}
                      className={`w-full flex items-start gap-3 p-3.5 rounded-xl text-left transition-all duration-200 ${
                        selected
                          ? 'ring-2 ring-primary-500 bg-primary-50 dark:bg-primary-500/10 dark:ring-primary-400'
                          : 'bg-surface-secondary hover:bg-surface-tertiary dark:bg-surface-dark-tertiary'
                      }`}
                    >
                      <span className={`mt-0.5 w-4 h-4 flex-shrink-0 rounded-full border-2 flex items-center justify-center ${
                        selected ? 'border-primary-500' : 'border-neutral-300 dark:border-neutral-500'
                      }`}>
                        {selected && <span className="w-2 h-2 rounded-full bg-primary-500" />}
                      </span>
                      <span>
                        <span className="block text-sm font-medium text-content dark:text-content-inverse">{option.label}</span>
                        <span className="block text-xs mt-0.5 text-content-tertiary dark:text-content-inverse-tertiary">
                          {option.description}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>

              <p className="text-xs text-content-tertiary dark:text-content-inverse-tertiary mb-6">
                After you answer, your browser goes to <span className="font-mono">{request.redirectHost}</span>.
                Only continue if you started connecting this app yourself.
              </p>

              <div className="flex gap-3">
                <GradientButton
                  type="button"
                  variant="secondary"
                  fullWidth
                  disabled={busy !== null}
                  isLoading={busy === 'deny'}
                  onClick={() => void answer('deny')}
                >
                  Deny
                </GradientButton>
                <GradientButton
                  type="button"
                  fullWidth
                  disabled={busy !== null}
                  isLoading={busy === 'approve'}
                  loadingText="Connecting…"
                  onClick={() => void answer('approve')}
                >
                  Allow
                </GradientButton>
              </div>
            </>
          )}
        </OnboardingCard>
      </motion.div>
    </OnboardingLayout>
  )
}
