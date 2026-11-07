import { afterEach, describe, expect, it, vi } from 'vitest'
import { announceInteractionMode, createClientChannel, INTERACTION_MODE_EVENT, type ClientEventEnvelope } from './clientChannel'

afterEach(() => vi.useRealTimers())

function setup() {
  const sent: ClientEventEnvelope[] = []
  let n = 0
  const channel = createClientChannel((e) => sent.push(e), () => `r${++n}`)
  return { channel, sent }
}

describe('client channel', () => {
  it('sends an event with its data and no request id', () => {
    const { channel, sent } = setup()
    channel.send('wake', { reason: 'tap', event: 'ignored' })
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('client_event')
    expect(sent[0].data).toMatchObject({ event: 'wake', reason: 'tap' })
    expect(sent[0].data.request_id).toBeUndefined()
  })

  it('resolves a request with the first matching reply and drops the rest', async () => {
    const { channel, sent } = setup()
    const reply = channel.request('rate', { stars: 4 })
    expect(sent[0].data.request_id).toBe('r1')
    expect(channel.handleEnvelope({ type: 'transcript', data: {} })).toBe(false)
    expect(channel.handleEnvelope({ type: 'client_event_reply', data: { request_id: 'other', event: 'rate', ok: true } })).toBe(true)
    channel.handleEnvelope({ type: 'client_event_reply', data: { request_id: 'r1', event: 'rate', ok: true, data: { thanks: true } } })
    channel.handleEnvelope({ type: 'client_event_reply', data: { request_id: 'r1', event: 'rate', ok: false, error: 'second agent' } })
    await expect(reply).resolves.toMatchObject({ ok: true, data: { thanks: true } })
  })

  it('rejects a request nobody answers, and every waiting one on close', async () => {
    vi.useFakeTimers()
    const { channel } = setup()
    const late = channel.request('rate', {}, 1000)
    vi.advanceTimersByTime(1001)
    await expect(late).rejects.toThrow('no reply to rate')
    const open = channel.request('rate')
    channel.close()
    await expect(open).rejects.toThrow('closed')
  })

  it('announces the interaction mode, retrying while no agent answers', async () => {
    vi.useFakeTimers()
    const { channel, sent } = setup()
    const done = announceInteractionMode(channel, 'text', { attempts: 3, timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(101) // first attempt times out
    expect(sent.map((e) => e.data.event)).toEqual([INTERACTION_MODE_EVENT, INTERACTION_MODE_EVENT])
    channel.handleEnvelope({ type: 'client_event_reply', data: { request_id: 'r2', event: INTERACTION_MODE_EVENT, ok: true, data: { mode: 'text' } } })
    await expect(done).resolves.toBe(true)
    expect(sent[1].data).toMatchObject({ mode: 'text' })
  })
})
