import { describe, it, expect } from 'vitest'
import { suggestHandle } from './ConnectorsSection'

describe('suggestHandle', () => {
  it('turns a display name into a valid handle', () => {
    expect(suggestHandle('ELIAS interview questions')).toBe('elias-interview-questions')
    expect(suggestHandle('Café Über API!')).toBe('cafe-uber-api')
    expect(suggestHandle('2nd server')).toBe('nd-server')
    expect(suggestHandle('')).toBe('')
  })

  it('stays within 40 characters without a trailing hyphen', () => {
    const handle = suggestHandle('a very long connector name that goes on and on and on')
    expect(handle.length).toBeLessThanOrEqual(40)
    expect(handle).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/)
  })
})
