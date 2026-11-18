// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { BACK_ONLINE_MS, nextBanner, useConnectionBanner } from './useConnectionBanner'

describe('nextBanner', () => {
  it('offline always shows the offline banner', () => {
    expect(nextBanner('hidden', 'offline')).toBe('offline')
    expect(nextBanner('back-online', 'offline')).toBe('offline')
  })

  it('online after offline confirms the return', () => {
    expect(nextBanner('offline', 'online')).toBe('back-online')
  })

  it('online while nothing is shown stays hidden', () => {
    expect(nextBanner('hidden', 'online')).toBe('hidden')
  })
})

describe('useConnectionBanner', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('starts hidden when the browser is online', () => {
    const { result } = renderHook(() => useConnectionBanner())
    expect(result.current).toBe('hidden')
  })

  it('starts offline when the page loads without a connection', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const { result } = renderHook(() => useConnectionBanner())
    expect(result.current).toBe('offline')
  })

  it('follows the offline and online events, then hides "Back online"', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useConnectionBanner())

    act(() => { window.dispatchEvent(new Event('offline')) })
    expect(result.current).toBe('offline')

    act(() => { window.dispatchEvent(new Event('online')) })
    expect(result.current).toBe('back-online')

    act(() => { vi.advanceTimersByTime(BACK_ONLINE_MS) })
    expect(result.current).toBe('hidden')
  })

  it('going offline again during "Back online" keeps the banner up', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useConnectionBanner())
    act(() => { window.dispatchEvent(new Event('offline')) })
    act(() => { window.dispatchEvent(new Event('online')) })
    act(() => { window.dispatchEvent(new Event('offline')) })
    act(() => { vi.advanceTimersByTime(BACK_ONLINE_MS) })
    expect(result.current).toBe('offline')
  })

  it('stops listening once unmounted', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderHook(() => useConnectionBanner())
    unmount()
    expect(remove).toHaveBeenCalledWith('online', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('offline', expect.any(Function))
  })
})
