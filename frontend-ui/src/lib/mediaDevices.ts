/**
 * Media device utilities for permission checking and device access
 */

export type PermissionState = 'granted' | 'denied' | 'prompt'

/**
 * Whether the page can already see a named microphone. Browsers show device
 * labels only once microphone access was given, so a label means "granted".
 */
async function microphoneLabelVisible(): Promise<boolean> {
  try {
    const devices = await navigator.mediaDevices?.enumerateDevices()
    return !!devices?.some((d) => d.kind === 'audioinput' && d.label !== '')
  } catch {
    return false
  }
}

/**
 * Check microphone permission state.
 * Where the browser cannot be asked (no Permissions API, or it does not know
 * "microphone"), or answers 'prompt', a visible microphone label still counts
 * as 'granted', so nobody is asked again for access they already gave.
 */
export async function checkMicrophonePermission(): Promise<PermissionState> {
  let state: PermissionState = 'prompt'
  try {
    if (navigator.permissions) {
      const result = await navigator.permissions.query({ name: 'microphone' as PermissionName })
      state = result.state as PermissionState
    }
  } catch {
    // Some browsers don't support querying microphone permission
  }
  if (state === 'prompt' && (await microphoneLabelVisible())) return 'granted'
  return state
}

/**
 * Check camera permission state
 * Falls back to 'prompt' if permissions API is not supported
 */
export async function checkCameraPermission(): Promise<PermissionState> {
  try {
    if (!navigator.permissions) {
      return 'prompt' // API not supported, will need to request
    }
    const result = await navigator.permissions.query({ name: 'camera' as PermissionName })
    return result.state as PermissionState
  } catch {
    // Some browsers don't support querying camera permission
    return 'prompt'
  }
}

/**
 * Request microphone access
 * Returns the stream if granted, null if denied
 */
export async function requestMicrophoneAccess(deviceId?: string): Promise<MediaStream | null> {
  try {
    const constraints: MediaStreamConstraints = {
      audio: deviceId
        ? { deviceId: { exact: deviceId } }
        : true,
    }
    return await navigator.mediaDevices.getUserMedia(constraints)
  } catch (error) {
    console.error('Failed to access microphone:', error)
    return null
  }
}

/**
 * Request camera access
 * Returns the stream if granted, null if denied
 */
export async function requestCameraAccess(deviceId?: string): Promise<MediaStream | null> {
  try {
    const constraints: MediaStreamConstraints = {
      video: deviceId
        ? { deviceId: { exact: deviceId } }
        : true,
    }
    return await navigator.mediaDevices.getUserMedia(constraints)
  } catch (error) {
    console.error('Failed to access camera:', error)
    return null
  }
}

/**
 * Request both microphone and camera access together
 * Returns streams for each, null for any that were denied
 */
export async function requestMediaAccess(options: {
  audio?: boolean | { deviceId: string }
  video?: boolean | { deviceId: string }
}): Promise<{ audioStream: MediaStream | null; videoStream: MediaStream | null }> {
  let audioStream: MediaStream | null = null
  let videoStream: MediaStream | null = null

  // Request audio
  if (options.audio) {
    try {
      const audioConstraints: MediaStreamConstraints = {
        audio: typeof options.audio === 'object'
          ? { deviceId: { exact: options.audio.deviceId } }
          : true,
      }
      audioStream = await navigator.mediaDevices.getUserMedia(audioConstraints)
    } catch (error) {
      console.error('Failed to access microphone:', error)
    }
  }

  // Request video
  if (options.video) {
    try {
      const videoConstraints: MediaStreamConstraints = {
        video: typeof options.video === 'object'
          ? { deviceId: { exact: options.video.deviceId } }
          : true,
      }
      videoStream = await navigator.mediaDevices.getUserMedia(videoConstraints)
    } catch (error) {
      console.error('Failed to access camera:', error)
    }
  }

  return { audioStream, videoStream }
}

/**
 * Get all audio input devices (microphones)
 */
export async function getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter(device => device.kind === 'audioinput')
  } catch (error) {
    console.error('Failed to enumerate audio input devices:', error)
    return []
  }
}

/**
 * Get all audio output devices (speakers)
 */
export async function getAudioOutputDevices(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter(device => device.kind === 'audiooutput')
  } catch (error) {
    console.error('Failed to enumerate audio output devices:', error)
    return []
  }
}

/**
 * Pick the deviceId to use as the default output sink from an enumerated list.
 * Prefers the entry the browser labels as 'default', otherwise the first device.
 * Returns '' when the list is empty, which HTMLMediaElement.setSinkId treats as
 * the system default output.
 */
export function pickDefaultSink(devices: MediaDeviceInfo[]): string {
  if (!devices.length) return ''
  const explicitDefault = devices.find((d) => d.deviceId === 'default')
  return (explicitDefault ?? devices[0]).deviceId
}

/**
 * Get all video input devices (cameras)
 */
export async function getVideoInputDevices(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter(device => device.kind === 'videoinput')
  } catch (error) {
    console.error('Failed to enumerate video input devices:', error)
    return []
  }
}

/**
 * Stop all tracks in a stream
 */
export function stopStream(stream: MediaStream | null) {
  if (stream) {
    stream.getTracks().forEach(track => track.stop())
  }
}
