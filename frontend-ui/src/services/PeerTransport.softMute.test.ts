import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PeerTransport } from './PeerTransport'

// Muting must keep the track published and only tell the agent (#362). Unpublishing
// made the agent's STT tear down and restart on every mute.

describe('PeerTransport soft mute', () => {
  let transport: any
  const publishData = vi.fn()
  const unpublishTrack = vi.fn()
  const pub = { mute: vi.fn(), unmute: vi.fn(), track: {} }

  const sent = () =>
    publishData.mock.calls.map(([bytes]) => JSON.parse(new TextDecoder().decode(bytes)))

  beforeEach(() => {
    publishData.mockReset()
    unpublishTrack.mockReset()
    pub.mute.mockReset().mockResolvedValue(undefined)
    pub.unmute.mockReset().mockResolvedValue(undefined)
    transport = new PeerTransport() as any
    transport.room = { state: 'connected', localParticipant: { publishData, unpublishTrack } }
    transport.publishedAudioTrack = pub
  })

  it('muteAudio() mutes the track, tells the agent, and does not unpublish', async () => {
    await transport.muteAudio()

    expect(pub.mute).toHaveBeenCalledTimes(1)
    expect(unpublishTrack).not.toHaveBeenCalled()
    expect(transport.hasPublishedAudio()).toBe(true)
    expect(sent().map((m) => m.type)).toEqual(['audio_stream_mute'])
  })

  it('unmuteAudio() tells the agent and unmutes the same track', async () => {
    await transport.unmuteAudio()

    expect(pub.unmute).toHaveBeenCalledTimes(1)
    expect(unpublishTrack).not.toHaveBeenCalled()
    expect(sent().map((m) => m.type)).toEqual(['audio_stream_unmute'])
  })

  it('does nothing when no track is published', async () => {
    transport.publishedAudioTrack = undefined

    await transport.muteAudio()
    await transport.unmuteAudio()

    expect(publishData).not.toHaveBeenCalled()
    expect(transport.hasPublishedAudio()).toBe(false)
  })
})
