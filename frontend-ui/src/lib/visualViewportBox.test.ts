import { describe, expect, it } from 'vitest'
import { visualViewportBox } from './visualViewportBox'

describe('visualViewportBox', () => {
  it('leaves the layout alone where there is no visual viewport', () => {
    expect(visualViewportBox(null)).toBeUndefined()
    expect(visualViewportBox(undefined)).toBeUndefined()
  })

  it('follows the visual viewport as the keyboard shrinks it', () => {
    expect(visualViewportBox({ height: 430, offsetTop: 0 })).toEqual({ top: 0, height: 430 })
  })

  it('moves down with it when iOS scrolls the visual viewport (#206)', () => {
    // Keyboard open: iOS Safari scrolls the visual viewport as well as
    // shrinking it. A box pinned at top 0 would start above what is visible,
    // and the composer at its bottom would end up partly hidden.
    expect(visualViewportBox({ height: 430, offsetTop: 250 })).toEqual({ top: 250, height: 430 })
  })

  it('never places the box above the page', () => {
    // Rubber-band scrolling can report a small negative offset.
    expect(visualViewportBox({ height: 844, offsetTop: -12 })).toEqual({ top: 0, height: 844 })
  })
})
