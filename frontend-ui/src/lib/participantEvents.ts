/**
 * Join/leave notices in the chat. A run of them in a row (a reconnect, an
 * agent restarting, someone switching tabs) is folded into one line that
 * names where each person ended up, so the conversation stays readable.
 */
import type { ParticipantEvent } from './types'

export interface ParticipantRun {
  messageType: 'participant-run'
  id: string
  startedAt: number
  events: ParticipantEvent[]
}

type WithType = { messageType: string; id: string; startedAt: number }

/** Replace each run of consecutive participant events with one ParticipantRun. */
export function foldParticipantEvents<T extends WithType>(
  items: T[],
): (Exclude<T, { messageType: 'participant' }> | ParticipantRun)[] {
  const out: (Exclude<T, { messageType: 'participant' }> | ParticipantRun)[] = []
  let run: ParticipantEvent[] = []
  const flush = () => {
    if (run.length > 0) {
      out.push({ messageType: 'participant-run', id: `run-${run[0].id}`, startedAt: run[0].startedAt, events: run })
    }
    run = []
  }
  for (const item of items) {
    if (item.messageType === 'participant') run.push(item as unknown as ParticipantEvent)
    else {
      flush()
      out.push(item as Exclude<T, { messageType: 'participant' }>)
    }
  }
  flush()
  return out
}

export interface ParticipantOutcome {
  name: string
  /** Where they are after the run: in the session or not. */
  type: 'joined' | 'left'
  /** They came and went (or went and came back) within the run. */
  changes: number
}

/** Each person's last state in the run, in the order of their last event. */
export function summarizeRun(events: ParticipantEvent[]): ParticipantOutcome[] {
  const byName = new Map<string, ParticipantOutcome>()
  for (const e of events) {
    const name = e.participantName || e.participantId || 'Unknown'
    const prev = byName.get(name)
    byName.delete(name) // re-insert so the order follows the last event
    byName.set(name, { name, type: e.type, changes: (prev?.changes ?? 0) + 1 })
  }
  return [...byName.values()]
}
