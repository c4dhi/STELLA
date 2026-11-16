// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { nextDiscardGuardState, useDiscardGuard } from './useDiscardGuard'

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

describe('useDiscardGuard', () => {
  it('clean requestClose calls onClose and never shows the confirm', () => {
    const onClose = vi.fn()
    const { result } = renderHook(() => useDiscardGuard(false, onClose))

    act(() => result.current.requestClose())

    expect(onClose).toHaveBeenCalledOnce()
    expect(result.current.showConfirm).toBe(false)
  })

  it('dirty requestClose shows the confirm and does not call onClose', () => {
    const onClose = vi.fn()
    const { result } = renderHook(() => useDiscardGuard(true, onClose))

    act(() => result.current.requestClose())

    expect(onClose).not.toHaveBeenCalled()
    expect(result.current.showConfirm).toBe(true)
  })

  it('keepEditing hides the confirm without closing', () => {
    const onClose = vi.fn()
    const { result } = renderHook(() => useDiscardGuard(true, onClose))

    act(() => result.current.requestClose())
    act(() => result.current.keepEditing())

    expect(result.current.showConfirm).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('confirmDiscard closes', () => {
    const onClose = vi.fn()
    const { result } = renderHook(() => useDiscardGuard(true, onClose))

    act(() => result.current.requestClose())
    act(() => result.current.confirmDiscard())

    expect(result.current.showConfirm).toBe(false)
    expect(onClose).toHaveBeenCalledOnce()
  })

  describe('Escape key (opt-in via the escape option)', () => {
    it('does nothing when no escape option is passed', () => {
      const onClose = vi.fn()
      renderHook(() => useDiscardGuard(false, onClose))

      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })

      expect(onClose).not.toHaveBeenCalled()
    })

    it('closes a clean dialog, same as requestClose', () => {
      const onClose = vi.fn()
      renderHook(() => useDiscardGuard(false, onClose, { isOpen: true }))

      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })

      expect(onClose).toHaveBeenCalledOnce()
    })

    it('shows the confirm for a dirty dialog instead of closing', () => {
      const onClose = vi.fn()
      const { result } = renderHook(() => useDiscardGuard(true, onClose, { isOpen: true }))

      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })

      expect(onClose).not.toHaveBeenCalled()
      expect(result.current.showConfirm).toBe(true)
    })

    it('does nothing while blocked (e.g. mid-submit)', () => {
      const onClose = vi.fn()
      renderHook(() => useDiscardGuard(true, onClose, { isOpen: true, blocked: true }))

      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })

      expect(onClose).not.toHaveBeenCalled()
    })
  })
})
