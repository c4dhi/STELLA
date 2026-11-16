import { describe, expect, it } from 'vitest'
import { isInviteParticipantModalDirty } from './InviteParticipantModal.dirty'

const pristine = {
  step: 'type',
  hasResult: false,
  invitationType: 'web',
  participantName: '',
  customMessage: '',
  hasVisualizerType: false,
  visualizerLocked: false,
  hasExpiresInHours: false,
  hasMaxSessionDuration: false,
}

describe('isInviteParticipantModalDirty', () => {
  it('is clean on the pristine type step', () => {
    expect(isInviteParticipantModalDirty(pristine)).toBe(false)
  })

  it('is dirty once a participant name is typed', () => {
    expect(isInviteParticipantModalDirty({ ...pristine, participantName: 'Alex' })).toBe(true)
  })

  it('is clean for a whitespace-only name', () => {
    expect(isInviteParticipantModalDirty({ ...pristine, participantName: '   ' })).toBe(false)
  })

  it('is dirty once past the type step', () => {
    expect(isInviteParticipantModalDirty({ ...pristine, step: 'message' })).toBe(true)
  })

  it('is dirty once visualizer, expiration or duration is set', () => {
    expect(isInviteParticipantModalDirty({ ...pristine, hasVisualizerType: true })).toBe(true)
    expect(isInviteParticipantModalDirty({ ...pristine, hasExpiresInHours: true })).toBe(true)
    expect(isInviteParticipantModalDirty({ ...pristine, hasMaxSessionDuration: true })).toBe(true)
  })

  it('is never dirty once an invitation result exists', () => {
    expect(isInviteParticipantModalDirty({ ...pristine, hasResult: true, participantName: 'Alex', step: 'complete' })).toBe(false)
  })
})
