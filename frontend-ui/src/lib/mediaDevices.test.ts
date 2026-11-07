import { afterEach, describe, it, expect, vi } from 'vitest'
import { checkMicrophonePermission, pickDefaultSink } from './mediaDevices'

// Minimal MediaDeviceInfo-shaped stub — pickDefaultSink only reads deviceId.
const dev = (deviceId: string): MediaDeviceInfo =>
  ({ deviceId, kind: 'audiooutput', label: '', groupId: '' } as MediaDeviceInfo)

describe('pickDefaultSink', () => {
  it('returns empty string for an empty list (system default)', () => {
    expect(pickDefaultSink([])).toBe('')
  })

  it('prefers the entry the browser labels as "default"', () => {
    const devices = [dev('abc'), dev('default'), dev('xyz')]
    expect(pickDefaultSink(devices)).toBe('default')
  })

  it('falls back to the first device when there is no explicit default', () => {
    const devices = [dev('abc'), dev('xyz')]
    expect(pickDefaultSink(devices)).toBe('abc')
  })
})

describe('checkMicrophonePermission', () => {
  const setNavigator = (permissions: unknown, labels: string[]) => {
    vi.stubGlobal('navigator', {
      permissions,
      mediaDevices: {
        enumerateDevices: async () => labels.map((label) => ({ kind: 'audioinput', label, deviceId: 'x', groupId: '' })),
      },
    })
  }
  afterEach(() => vi.unstubAllGlobals())

  it('uses the Permissions API answer when there is one', async () => {
    setNavigator({ query: async () => ({ state: 'denied' }) }, ['Mic'])
    expect(await checkMicrophonePermission()).toBe('denied')
  })

  it('counts a visible microphone as granted when the browser cannot be asked', async () => {
    setNavigator(undefined, ['MacBook Microphone'])
    expect(await checkMicrophonePermission()).toBe('granted')
    setNavigator({ query: async () => { throw new TypeError('unsupported') } }, ['Mic'])
    expect(await checkMicrophonePermission()).toBe('granted')
  })

  it('stays at prompt when no microphone is visible yet', async () => {
    setNavigator(undefined, [''])
    expect(await checkMicrophonePermission()).toBe('prompt')
  })
})
