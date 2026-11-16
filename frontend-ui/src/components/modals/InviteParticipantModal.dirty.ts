export function isInviteParticipantModalDirty(state: {
  step: string
  hasResult: boolean
  invitationType: string
  participantName: string
  customMessage: string
  hasVisualizerType: boolean
  visualizerLocked: boolean
  hasExpiresInHours: boolean
  hasMaxSessionDuration: boolean
}): boolean {
  if (state.hasResult) return false
  return (
    state.step !== 'type' ||
    state.invitationType !== 'web' ||
    state.participantName.trim().length > 0 ||
    state.customMessage.trim().length > 0 ||
    state.hasVisualizerType ||
    state.visualizerLocked ||
    state.hasExpiresInHours ||
    state.hasMaxSessionDuration
  )
}
