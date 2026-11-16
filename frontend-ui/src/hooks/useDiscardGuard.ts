import { useCallback, useState } from 'react'

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

export function useDiscardGuard(isDirty: boolean, onClose: () => void): DiscardGuard {
  const [showConfirm, setShowConfirm] = useState(false)

  const apply = useCallback((action: DiscardGuardAction) => {
    const next = nextDiscardGuardState(action, isDirty)
    setShowConfirm(next.showConfirm)
    if (next.shouldClose) onClose()
  }, [isDirty, onClose])

  const requestClose = useCallback(() => apply('requestClose'), [apply])
  const keepEditing = useCallback(() => apply('keepEditing'), [apply])
  const confirmDiscard = useCallback(() => apply('confirmDiscard'), [apply])

  return { showConfirm, requestClose, keepEditing, confirmDiscard }
}
