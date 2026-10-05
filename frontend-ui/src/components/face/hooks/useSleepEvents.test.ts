import { describe, expect, it } from 'vitest'
import { sleepEventFor } from './useSleepEvents'

describe('what the agent is told about sleep', () => {
  it('reports falling asleep', () => {
    expect(sleepEventFor('awake', 'asleep')).toBe('sleep')
  })

  it('reports the wake when it begins, not when it ends', () => {
    expect(sleepEventFor('asleep', 'waking')).toBe('wake')
    expect(sleepEventFor('waking', 'awake')).toBeNull()
  })

  it('reports a wake when the face goes away while asleep', () => {
    expect(sleepEventFor('asleep', 'awake')).toBe('wake')
  })

  it('says nothing when nothing changed', () => {
    expect(sleepEventFor('awake', 'awake')).toBeNull()
    expect(sleepEventFor('asleep', 'asleep')).toBeNull()
  })
})
