import type { ParticipantMessage } from './ParticipantSessionView'

/**
 * Messages one sender sends back to back, with no more than this between two
 * of them and nobody else in between, read as one group: the avatar is shown
 * once and the time only under the last one, as in other chat apps.
 */
export const GROUP_GAP_MS = 2 * 60 * 1000

export interface GroupPosition {
  /** Opens a group: shows the avatar (and an organizer's name). */
  first: boolean
  /** Closes a group: shows the time. */
  last: boolean
}

const isEvent = (m: ParticipantMessage) => m.messageType === 'participant_event'

const senderOf = (m: ParticipantMessage) =>
  m.role === 'other_user' ? `other_user:${m.speakerName || m.participantName || ''}` : m.role

function continues(prev: ParticipantMessage | undefined, next: ParticipantMessage | undefined): boolean {
  if (!prev || !next || isEvent(prev) || isEvent(next)) return false
  if (senderOf(prev) !== senderOf(next)) return false
  const gap = next.timestamp.getTime() - prev.timestamp.getTime()
  return gap >= 0 && gap <= GROUP_GAP_MS
}

/** Where each message sits in its group, by index. */
export function groupPositions(messages: ParticipantMessage[]): GroupPosition[] {
  return messages.map((m, i) => ({
    first: !continues(messages[i - 1], m),
    last: !continues(m, messages[i + 1]),
  }))
}
