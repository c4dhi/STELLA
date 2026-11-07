import { AgentValidationStatus } from './api-types'

/**
 * What the uploader reads about an admin's decision on their agent, or null
 * when there is nothing to say (still pending, or approved without notes).
 */
export function reviewNoteText(
  status: AgentValidationStatus | undefined,
  notes: string | null | undefined,
): string | null {
  const text = notes?.trim()
  if (status === AgentValidationStatus.REJECTED) {
    return text ? `Rejected by an admin: ${text}` : 'Rejected by an admin.'
  }
  if (status === AgentValidationStatus.APPROVED && text) return `Approved by an admin: ${text}`
  return null
}
