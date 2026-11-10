import { describe, it, expect } from 'vitest'
import { reviewNoteText } from './agentReview'
import { AgentValidationStatus } from './api-types'

describe('reviewNoteText', () => {
  it('gives the uploader the rejection reason', () => {
    expect(reviewNoteText(AgentValidationStatus.REJECTED, 'Opens a shell')).toBe('Rejected by an admin: Opens a shell')
    expect(reviewNoteText(AgentValidationStatus.REJECTED, null)).toBe('Rejected by an admin.')
  })

  it('passes on approval notes, and says nothing without them or while pending', () => {
    expect(reviewNoteText(AgentValidationStatus.APPROVED, 'Checked')).toBe('Approved by an admin: Checked')
    expect(reviewNoteText(AgentValidationStatus.APPROVED, '  ')).toBeNull()
    expect(reviewNoteText(AgentValidationStatus.PENDING, 'x')).toBeNull()
  })
})
