import { describe, expect, it } from 'vitest'
import { groupPositions, GROUP_GAP_MS } from './messageGroups'
import type { ParticipantMessage } from './ParticipantSessionView'

const t0 = new Date('2026-11-27T14:07:00Z').getTime()
const msg = (id: string, role: ParticipantMessage['role'], atMs: number, extra: Partial<ParticipantMessage> = {}): ParticipantMessage =>
  ({ id, role, text: id, timestamp: new Date(t0 + atMs), ...extra }) as ParticipantMessage

describe('groupPositions', () => {
  it('groups back-to-back messages from the same sender: first opens, last closes', () => {
    const p = groupPositions([msg('a', 'user', 0), msg('b', 'user', 10_000), msg('c', 'user', 20_000)])
    expect(p).toEqual([
      { first: true, last: false },
      { first: false, last: false },
      { first: false, last: true },
    ])
  })

  it('a reply from the other side ends the group', () => {
    const p = groupPositions([msg('a', 'user', 0), msg('b', 'assistant', 1000), msg('c', 'user', 2000)])
    expect(p.every((x) => x.first && x.last)).toBe(true)
  })

  it('a pause longer than the gap starts a new group', () => {
    const p = groupPositions([msg('a', 'assistant', 0), msg('b', 'assistant', GROUP_GAP_MS + 1)])
    expect(p).toEqual([{ first: true, last: true }, { first: true, last: true }])
  })

  it('a pause of exactly the gap still groups', () => {
    const p = groupPositions([msg('a', 'assistant', 0), msg('b', 'assistant', GROUP_GAP_MS)])
    expect(p).toEqual([{ first: true, last: false }, { first: false, last: true }])
  })

  it('two different organizers are two senders', () => {
    const p = groupPositions([
      msg('a', 'other_user', 0, { speakerName: 'Anna' }),
      msg('b', 'other_user', 1000, { speakerName: 'Ben' }),
    ])
    expect(p.every((x) => x.first && x.last)).toBe(true)
  })

  it('a join/leave note breaks a group', () => {
    const p = groupPositions([
      msg('a', 'user', 0),
      msg('j', 'system', 500, { messageType: 'participant_event', eventType: 'joined' } as Partial<ParticipantMessage>),
      msg('b', 'user', 1000),
    ])
    expect(p[0]).toEqual({ first: true, last: true })
    expect(p[2]).toEqual({ first: true, last: true })
  })

  it('an agent message still being written is never folded under an earlier time', () => {
    const p = groupPositions([msg('a', 'assistant', 0), msg('b', 'assistant', 1000, { isStreaming: true })])
    expect(p).toEqual([{ first: true, last: false }, { first: false, last: true }])
  })
})
