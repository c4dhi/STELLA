import { describe, it, expect } from 'vitest'
import { compilerAtLeast, enabledByDefault } from './useConfiguratorState'

// #191: the capabilities expert is on for new configurations and off for ones
// saved before it existed, as the V2 agent decides at session start.
describe('an expert with a compiler floor', () => {
  it('is on for a new configuration', () => {
    expect(enabledByDefault('1.2.0', null)).toBe(true)
  })

  it('is off for one saved against an older compiler, or none', () => {
    expect(enabledByDefault('1.2.0', { minCompilerVersion: '1.1.0' })).toBe(false)
    expect(enabledByDefault('1.2.0', { minCompilerVersion: null })).toBe(false)
  })

  it('is on for one saved against that compiler or a later one', () => {
    expect(enabledByDefault('1.2.0', { minCompilerVersion: '1.2.0' })).toBe(true)
    expect(enabledByDefault('1.2.0', { minCompilerVersion: '1.10.0' })).toBe(true)
  })

  it('does not apply to experts without a floor', () => {
    expect(enabledByDefault(undefined, { minCompilerVersion: '0.1.0' })).toBe(true)
  })
})

describe('compilerAtLeast', () => {
  it('compares dotted numbers, not strings', () => {
    expect(compilerAtLeast('1.10.0', '1.2.0')).toBe(true)
    expect(compilerAtLeast('1.2', '1.2.0')).toBe(true)
    expect(compilerAtLeast('1.1.9', '1.2.0')).toBe(false)
    expect(compilerAtLeast('garbage', '1.2.0')).toBe(false)
  })
})
