import { useCallback, useState } from 'react'

export interface DiscardGuard {
  showConfirm: boolean
  requestClose: () => void
  keepEditing: () => void
  confirmDiscard: () => void
}

export function useDiscardGuard(isDirty: boolean, onClose: () => void): DiscardGuard {
  const [showConfirm, setShowConfirm] = useState(false)

  const requestClose = useCallback(() => {
    if (isDirty) {
      setShowConfirm(true)
    } else {
      onClose()
    }
  }, [isDirty, onClose])

  const keepEditing = useCallback(() => setShowConfirm(false), [])

  const confirmDiscard = useCallback(() => {
    setShowConfirm(false)
    onClose()
  }, [onClose])

  return { showConfirm, requestClose, keepEditing, confirmDiscard }
}
