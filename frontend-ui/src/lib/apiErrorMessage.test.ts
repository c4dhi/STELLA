import { describe, expect, it } from 'vitest'
import { apiErrorMessage } from './apiErrorMessage'

describe('apiErrorMessage', () => {
  it('shows the server\'s message from the thrown error body', () => {
    expect(apiErrorMessage({ statusCode: 400, message: 'Echo still has 1 running agent' }, 'Failed')).toBe(
      'Echo still has 1 running agent',
    )
  })
  it('joins validation messages', () => {
    expect(apiErrorMessage({ message: ['a must be set', 'b is too long'] }, 'Failed')).toBe('a must be set; b is too long')
  })
  it('lists the errors of a refused package', () => {
    expect(
      apiErrorMessage({ message: { message: 'Package validation failed', errors: ['agent.yaml is missing'] } }, 'Failed'),
    ).toBe('Package validation failed: agent.yaml is missing')
  })
  it('reads an Error, and falls back when there is nothing to show', () => {
    expect(apiErrorMessage(new Error('offline'), 'Failed')).toBe('offline')
    expect(apiErrorMessage(undefined, 'Failed')).toBe('Failed')
    expect(apiErrorMessage({ statusCode: 500 }, 'Failed')).toBe('Failed')
  })
})
