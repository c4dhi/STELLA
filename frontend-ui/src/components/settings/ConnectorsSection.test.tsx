import { describe, it, expect } from 'vitest'
import { suggestHandle } from './ConnectorsSection'
import { parseConnectorSlots } from '../../lib/api-types'

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

describe('parseConnectorSlots', () => {
  it('reads configSchema x-stella-connectors and fills defaults', () => {
    expect(parseConnectorSlots({
      'x-stella-connectors': [
        { slot: 'elias', kind: 'mcp', required: true, label: 'ELIAS', requiredTools: ['start_interview'] },
        { slot: 'notes', kind: 'mcp', label: 'Notes' },
        { label: 'no slot' },
      ],
    })).toEqual([
      { slot: 'elias', kind: 'mcp', required: true, label: 'ELIAS', description: undefined, requiredTools: ['start_interview'] },
      { slot: 'notes', kind: 'mcp', required: false, label: 'Notes', description: undefined, requiredTools: [] },
    ])
    expect(parseConnectorSlots(null)).toEqual([])
  })
})
