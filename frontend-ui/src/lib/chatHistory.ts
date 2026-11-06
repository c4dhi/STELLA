/**
 * Merging the stored history into the messages the screen already shows.
 *
 * The participant screen collects messages live from the moment it joins and
 * loads the stored history when a chat first shows. The two overlap, and a
 * stored row has its own database id, so matching by id alone shows every
 * live message twice. A stored message is the same as a live one when:
 * - an agent reply: the stored envelope's transcript_id is the live id;
 * - a typed message: the same correlation_id;
 * - anything else (a spoken line): the same role and text.
 */

export interface HistoryMergeMessage {
  id: string
  role: string
  text: string
  correlationId?: string
  messageType?: string
}

/** The id a stored agent reply had on screen while it streamed. */
export function liveIdOf(metadata: unknown): string | undefined {
  const envelope = (metadata as { envelope?: { data?: unknown } } | null | undefined)?.envelope
  const data = envelope?.data
  if (data && typeof data === 'object') {
    const id = (data as Record<string, unknown>).transcript_id
    if (typeof id === 'string' && id) return id
  }
  return undefined
}

/** The correlation_id a stored typed message carried. */
export function correlationIdOf(metadata: unknown): string | undefined {
  const envelope = (metadata as { envelope?: { data?: unknown } } | null | undefined)?.envelope
  const data = envelope?.data
  if (data && typeof data === 'object') {
    const id = (data as Record<string, unknown>).correlation_id
    if (typeof id === 'string' && id) return id
  }
  return undefined
}

/** History first (oldest first), then what is already on screen, without repeats. */
export function mergeHistory<T extends HistoryMergeMessage>(live: T[], history: T[]): T[] {
  const ids = new Set(live.map(m => m.id))
  const correlationIds = new Set(live.map(m => m.correlationId).filter((c): c is string => !!c))
  const lines = new Set(live.map(m => `${m.role}\u0000${m.text}`))
  const older = history.filter(m => {
    if (ids.has(m.id)) return false
    if (m.correlationId && correlationIds.has(m.correlationId)) return false
    if (m.messageType !== 'participant_event' && lines.has(`${m.role}\u0000${m.text}`)) return false
    return true
  })
  return [...older, ...live]
}
