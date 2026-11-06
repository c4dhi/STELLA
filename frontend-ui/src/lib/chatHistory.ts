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

/**
 * History first (oldest first), then what is already on screen, without repeats.
 *
 * A line matched by text stands for one stored copy only, taken from the newest
 * end of the history: a "Yes." said before a reload and again after it keeps
 * the older one.
 */
export function mergeHistory<T extends HistoryMergeMessage>(live: T[], history: T[]): T[] {
  const ids = new Set(live.map(m => m.id))
  const correlationIds = new Set(live.map(m => m.correlationId).filter((c): c is string => !!c))
  // Live lines left for matching by text: not already found by id or correlation id.
  const storedIds = new Set(history.map(m => m.id))
  const storedCorrelationIds = new Set(history.map(m => m.correlationId).filter((c): c is string => !!c))
  const unmatched = new Map<string, number>()
  for (const m of live) {
    if (storedIds.has(m.id) || (m.correlationId && storedCorrelationIds.has(m.correlationId))) continue
    const key = `${m.role}\u0000${m.text}`
    unmatched.set(key, (unmatched.get(key) ?? 0) + 1)
  }
  const older: T[] = []
  for (const m of [...history].reverse()) {
    if (ids.has(m.id)) continue
    if (m.correlationId && correlationIds.has(m.correlationId)) continue
    const key = `${m.role}\u0000${m.text}`
    const left = unmatched.get(key) ?? 0
    if (m.messageType !== 'participant_event' && left > 0) {
      unmatched.set(key, left - 1)
      continue
    }
    older.unshift(m)
  }
  return [...older, ...live]
}
