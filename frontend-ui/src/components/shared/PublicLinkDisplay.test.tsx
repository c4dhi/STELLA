import { forwardRef } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const { qrCodeCanvasSpy } = vi.hoisted(() => ({ qrCodeCanvasSpy: vi.fn() }))

vi.mock('qrcode.react', () => ({
  QRCodeCanvas: forwardRef((props: Record<string, unknown>, _ref) => {
    qrCodeCanvasSpy(props)
    return null
  }),
}))

import PublicLinkDisplay from './PublicLinkDisplay'

// #204: ProjectModal's "Public Project Created!" step and PublicLinkModal both
// render this one component, so testing it once covers the QR value in each.

const LINK = 'https://stella.example/p/abc123'

beforeEach(() => {
  qrCodeCanvasSpy.mockClear()
})

describe('PublicLinkDisplay', () => {
  it('encodes the exact public link in the QR code', () => {
    renderToStaticMarkup(<PublicLinkDisplay value={LINK} isDark={false} copied={false} onCopy={() => {}} />)
    expect(qrCodeCanvasSpy).toHaveBeenCalledWith(expect.objectContaining({ value: LINK }))
  })

  it('shows the same link in the read-only field, as a link to it', () => {
    const html = renderToStaticMarkup(
      <PublicLinkDisplay value={LINK} isDark={false} copied={false} onCopy={() => {}} />,
    )
    expect(html).toContain(`value="${LINK}"`)
    expect(html).toContain(`href="${LINK}"`)
  })

  it('shows copied feedback only once copied', () => {
    const notYet = renderToStaticMarkup(
      <PublicLinkDisplay value={LINK} isDark={false} copied={false} onCopy={() => {}} />,
    )
    expect(notYet).not.toContain('text-green-500')

    const after = renderToStaticMarkup(
      <PublicLinkDisplay value={LINK} isDark={false} copied={true} onCopy={() => {}} />,
    )
    expect(after).toContain('text-green-500')
  })
})
