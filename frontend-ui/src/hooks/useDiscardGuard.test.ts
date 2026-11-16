import { describe, expect, it } from 'vitest'
import { nextDiscardGuardState } from './useDiscardGuard'

describe('nextDiscardGuardState', () => {
  it('requestClose on a clean dialog closes straight away', () => {
    expect(nextDiscardGuardState('requestClose', false)).toEqual({ showConfirm: false, shouldClose: true })
  })

  it('requestClose on a dirty dialog shows the confirm instead of closing', () => {
    expect(nextDiscardGuardState('requestClose', true)).toEqual({ showConfirm: true, shouldClose: false })
  })

  it('keepEditing dismisses the confirm without closing', () => {
    expect(nextDiscardGuardState('keepEditing', true)).toEqual({ showConfirm: false, shouldClose: false })
  })

  it('confirmDiscard closes', () => {
    expect(nextDiscardGuardState('confirmDiscard', true)).toEqual({ showConfirm: false, shouldClose: true })
  })
})
