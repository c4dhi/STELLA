/**
 * The agent's `[sleep]` is held by the store until it is honoured or dropped,
 * so a face that is not on screen when it arrives still gets it (#149).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from './index'

const s = () => useStore.getState()

beforeEach(() => {
  useStore.setState({ faceState: null, faceSleepPending: false, faceSleepAllowed: true, agentSpeaks: true })
})

describe('faceSleepPending (#149)', () => {
  it('is raised by a [sleep] cue', () => {
    s().triggerFaceState('sleep')
    expect(s().faceSleepPending).toBe(true)
  })

  it('is raised by a sleep command off the wire', () => {
    s().applyAgentCommand({ command: 'sleep' })
    expect(s().faceSleepPending).toBe(true)
  })

  it('is not raised by a state the face does not know', () => {
    s().triggerFaceState('dance')
    expect(s().faceSleepPending).toBe(false)
  })

  it('is not raised while the agent holds her awake, and is dropped when it starts to', () => {
    s().applyAgentCommand({ command: 'sleep_allowed', allowed: false })
    s().triggerFaceState('sleep')
    expect(s().faceSleepPending).toBe(false)

    s().applyAgentCommand({ command: 'sleep_allowed', allowed: true })
    s().triggerFaceState('sleep')
    s().applyAgentCommand({ command: 'sleep_allowed', allowed: false })
    expect(s().faceSleepPending).toBe(false)
  })

  it('is cleared once handled', () => {
    s().triggerFaceState('sleep')
    s().clearFaceSleepPending()
    expect(s().faceSleepPending).toBe(false)
  })

  it('does not carry a goodbye into the next session', () => {
    s().triggerFaceState('sleep')
    s().resetFaceForSession()
    expect(s().faceSleepPending).toBe(false)
    expect(s().faceSleepAllowed).toBe(true)
  })

  it('remembers whether the agent speaks, and forgets it with the session (#180)', () => {
    expect(s().agentSpeaks).toBe(true)
    s().applyAgentCommand({ command: 'stella.speech', enabled: false })
    expect(s().agentSpeaks).toBe(false)
    expect(s().faceState).toBeNull()
    expect(s().faceSleepPending).toBe(false)
    s().applyAgentCommand({ command: 'stella.speech', enabled: true })
    expect(s().agentSpeaks).toBe(true)
    s().applyAgentCommand({ command: 'stella.speech', enabled: false })
    s().resetFaceForSession()
    expect(s().agentSpeaks).toBe(true)
  })
})
