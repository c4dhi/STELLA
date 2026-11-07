import { describe, expect, it } from 'vitest'
import { COMPLETION_READ_MAX_MS, COMPLETION_READ_MIN_MS, completionReadingTimeMs } from './completionScreen'

describe('completionReadingTimeMs', () => {
  it('gives a short goodbye the minimum', () => {
    expect(completionReadingTimeMs('Thank you, goodbye!')).toBe(COMPLETION_READ_MIN_MS)
    expect(completionReadingTimeMs(undefined)).toBe(COMPLETION_READ_MIN_MS)
  })

  it('grows with the length of the last message', () => {
    expect(completionReadingTimeMs(Array(20).fill('word').join(' '))).toBe(5000)
  })

  it('never waits longer than the maximum', () => {
    expect(completionReadingTimeMs(Array(500).fill('word').join(' '))).toBe(COMPLETION_READ_MAX_MS)
  })
})
