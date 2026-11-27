import { describe, expect, it } from 'vitest'
import { applyAgentReply } from './agentMessages'
import type { ParticipantMessage } from './ParticipantSessionView'

const t0 = new Date('2026-11-27T14:07:00Z').getTime()
const msg = (id: string, role: ParticipantMessage['role'], atMs: number, extra: Partial<ParticipantMessage> = {}): ParticipantMessage =>
  ({ id, role, text: id, timestamp: new Date(t0 + atMs), ...extra }) as ParticipantMessage

describe('applyAgentReply', () => {
  it('marks a new reply as streaming while it is not final', () => {
    const result = applyAgentReply([], { transcriptId: 'a', text: 'Hel', isFinal: false })
    expect(result).toEqual([expect.objectContaining({ id: 'a', isStreaming: true, text: 'Hel' })])
  })

  it('updates the same message in place as more of it streams in', () => {
    const prev = [msg('a', 'assistant', 0, { isStreaming: true, text: 'Hel' })]
    const result = applyAgentReply(prev, { transcriptId: 'a', text: 'Hello', isFinal: true })
    expect(result).toEqual([expect.objectContaining({ id: 'a', isStreaming: false, text: 'Hello' })])
  })

  it('a reply cut off mid-stream, followed by a new one, leaves no "is writing" indicator on the old one', () => {
    // "a" never got its own is_final chunk - cut off by a barge-in.
    const prev = [msg('a', 'assistant', 0, { isStreaming: true, text: 'Just a seco' })]
    const result = applyAgentReply(prev, { transcriptId: 'b', text: 'Sure,', isFinal: false })
    const old = result.find(m => m.id === 'a')
    const next = result.find(m => m.id === 'b')
    expect(old?.isStreaming).toBe(false)
    expect(next?.isStreaming).toBe(true)
  })

  it('leaves other roles alone when clearing a stale streaming flag', () => {
    const prev = [
      msg('a', 'assistant', 0, { isStreaming: true }),
      msg('u', 'user', 1, { isStreaming: true }), // never set in practice, but must not be touched
    ]
    const result = applyAgentReply(prev, { transcriptId: 'b', text: 'Sure,', isFinal: false })
    expect(result.find(m => m.id === 'u')?.isStreaming).toBe(true)
  })
})
