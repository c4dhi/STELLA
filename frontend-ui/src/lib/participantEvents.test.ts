import { describe, expect, it } from 'vitest'
import type { ParticipantEvent } from './types'
import { foldParticipantEvents, summarizeRun } from './participantEvents'

const ev = (id: string, name: string, type: 'joined' | 'left', at: number): ParticipantEvent =>
  ({ id, type, participantId: name, participantName: name, startedAt: at, messageType: 'participant' }) as ParticipantEvent
const msg = (id: string, at: number) => ({ id, startedAt: at, messageType: 'transcript' })

describe('foldParticipantEvents', () => {
  it('folds each run of notices into one item and leaves messages alone', () => {
    const out = foldParticipantEvents([
      msg('m1', 1),
      ev('a', 'owner', 'left', 2),
      ev('b', 'ELIAS', 'left', 3),
      ev('c', 'ELIAS', 'joined', 4),
      msg('m2', 5),
      ev('d', 'owner', 'joined', 6),
    ])
    expect(out.map((o) => o.messageType)).toEqual(['transcript', 'participant-run', 'transcript', 'participant-run'])
    expect((out[1] as any).events).toHaveLength(3)
    expect(out[1].id).toBe('run-a')
  })
})

describe('summarizeRun', () => {
  it('names where each person ended up, in the order of their last event', () => {
    const outcome = summarizeRun([
      ev('a', 'owner', 'left', 1),
      ev('b', 'ELIAS', 'left', 2),
      ev('c', 'ELIAS', 'joined', 3),
      ev('d', 'owner', 'joined', 4),
    ])
    expect(outcome).toEqual([
      { name: 'ELIAS', type: 'joined', changes: 2 },
      { name: 'owner', type: 'joined', changes: 2 },
    ])
  })
})
