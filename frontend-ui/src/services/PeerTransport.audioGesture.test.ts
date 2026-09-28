import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PeerTransport } from './PeerTransport'

// Safari (and every iPhone browser) blocks audio until a user gesture. The track
// subscribes after connect, so its <audio> element is created outside the gesture
// and play() is rejected. These pin the retry on the next tap or key press (#468).

type Listener = () => void | Promise<void>

function fakeDocument() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    listeners,
    addEventListener: (type: string, fn: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener: (type: string, fn: Listener) => listeners.get(type)?.delete(fn),
    async fire(type: string) {
      for (const fn of [...(listeners.get(type) ?? [])]) await fn()
    },
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  }
}

describe('PeerTransport gesture retry', () => {
  let doc: ReturnType<typeof fakeDocument>
  let transport: any
  const startAudio = vi.fn()
  const play = vi.fn()

  beforeEach(() => {
    doc = fakeDocument()
    vi.stubGlobal('document', doc)
    startAudio.mockReset().mockResolvedValue(undefined)
    play.mockReset().mockResolvedValue(undefined)
    transport = new PeerTransport() as any
    transport.room = { startAudio }
    transport.remoteAudio = { play }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries startAudio() then play() on the next tap', async () => {
    transport.enableAudioOnNextGesture()
    expect(startAudio).not.toHaveBeenCalled()

    await doc.fire('click')

    expect(startAudio).toHaveBeenCalledTimes(1)
    expect(play).toHaveBeenCalledTimes(1)
    expect(startAudio.mock.invocationCallOrder[0]).toBeLessThan(play.mock.invocationCallOrder[0])
    expect(transport.audioEnabled).toBe(true)
  })

  it('starts play() in the same tick as startAudio(), before any await (WebKit gesture)', async () => {
    let releaseStartAudio: () => void = () => {}
    startAudio.mockReturnValue(new Promise<void>((r) => (releaseStartAudio = r)))
    transport.enableAudioOnNextGesture()

    const handled = doc.fire('click')
    // startAudio() has not resolved, yet play() must already have been called.
    expect(startAudio).toHaveBeenCalledTimes(1)
    expect(play).toHaveBeenCalledTimes(1)
    releaseStartAudio()
    await handled
  })

  it.each(['pointerdown', 'touchend'])('a %s tap on plain page background also unlocks (iOS)', async (type) => {
    transport.enableAudioOnNextGesture()
    await doc.fire(type)
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('re-arms itself when the retry is still blocked', async () => {
    play.mockRejectedValueOnce(new Error('NotAllowedError'))
    transport.enableAudioOnNextGesture()
    await doc.fire('click')
    expect(doc.count()).toBeGreaterThan(0)

    await doc.fire('pointerdown')
    expect(play).toHaveBeenCalledTimes(2)
    expect(transport.audioEnabled).toBe(true)
  })

  it('also retries on a key press', async () => {
    transport.enableAudioOnNextGesture()
    await doc.fire('keydown')
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('arms one listener pair however many tracks were blocked', () => {
    transport.enableAudioOnNextGesture()
    transport.enableAudioOnNextGesture()
    transport.enableAudioOnNextGesture()
    expect(doc.count()).toBe(4)
  })

  it('removes its listeners after firing and can be armed again if still blocked', async () => {
    play.mockRejectedValueOnce(new Error('NotAllowedError'))
    transport.enableAudioOnNextGesture()
    await doc.fire('click')
    // The failed retry re-armed itself: one listener per event type, not two sets.
    expect(doc.count()).toBe(4)

    transport.enableAudioOnNextGesture()
    expect(doc.count()).toBe(4)
    await doc.fire('click')
    expect(play).toHaveBeenCalledTimes(2)
    expect(doc.count()).toBe(0)
  })
})
