import { describe, expect, it } from 'vitest'
import { previewFaceSize } from './previewFaceSize'

// The face preview drew a fixed 520 px face, so at 390 px its left eye sat
// off-screen (#184). It now fits the viewport with a 16 px gutter each side.
describe('previewFaceSize', () => {
  it('fits a phone screen with a 16 px gutter on each side', () => {
    expect(previewFaceSize(390)).toBe(358)
    expect(previewFaceSize(375)).toBe(343)
  })

  it('stays 520 on tablets and desktops', () => {
    expect(previewFaceSize(820)).toBe(520)
    expect(previewFaceSize(1440)).toBe(520)
    expect(previewFaceSize(552)).toBe(520)
  })

  it('never shrinks below 160', () => {
    expect(previewFaceSize(100)).toBe(160)
  })
})
