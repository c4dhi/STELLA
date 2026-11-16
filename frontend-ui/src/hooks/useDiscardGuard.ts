import { useCallback, useEffect, useState } from 'react'

export interface DiscardGuard {
  showConfirm: boolean
  requestClose: () => void
  keepEditing: () => void
  confirmDiscard: () => void
}

type DiscardGuardAction = 'requestClose' | 'keepEditing' | 'confirmDiscard'

/** The guard's state transitions, kept pure so they're testable with no render. */
export function nextDiscardGuardState(action: DiscardGuardAction, isDirty: boolean): { showConfirm: boolean; shouldClose: boolean } {
  switch (action) {
    case 'requestClose':
      return isDirty ? { showConfirm: true, shouldClose: false } : { showConfirm: false, shouldClose: true }
    case 'keepEditing':
      return { showConfirm: false, shouldClose: false }
    case 'confirmDiscard':
      return { showConfirm: false, shouldClose: true }
  }
}

export interface EscapeGuard {
  /** Whether the dialog is open; the listener attaches only while this is true. */
  isOpen: boolean
  /** Escape does nothing while this is true (e.g. mid-submit), same as the backdrop/X. */
  blocked?: boolean
}

export function useDiscardGuard(isDirty: boolean, onClose: () => void, escape?: EscapeGuard): DiscardGuard {
  const [showConfirm, setShowConfirm] = useState(false)

  const apply = useCallback((action: DiscardGuardAction) => {
    const next = nextDiscardGuardState(action, isDirty)
    setShowConfirm(next.showConfirm)
    if (next.shouldClose) onClose()
  }, [isDirty, onClose])

  const requestClose = useCallback(() => apply('requestClose'), [apply])
  const keepEditing = useCallback(() => apply('keepEditing'), [apply])
  const confirmDiscard = useCallback(() => apply('confirmDiscard'), [apply])

  // Opt-in: a caller that passes `escape` gets the Escape-key handling for
  // free instead of wiring its own listener. One that doesn't (the Agent
  // Configurator, which never had Escape-to-close) is unaffected.
  useEffect(() => {
    if (!escape?.isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (showConfirm) {
        keepEditing()
      } else if (!escape.blocked) {
        requestClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [escape?.isOpen, escape?.blocked, showConfirm, requestClose, keepEditing])

  return { showConfirm, requestClose, keepEditing, confirmDiscard }
}
