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

import JoinQrCode from './JoinQrCode'

const JOIN_URL = 'https://stella.example/join/abc123'

beforeEach(() => {
  qrCodeCanvasSpy.mockClear()
})

describe('JoinQrCode', () => {
  it('passes the exact join URL to the QR canvas', () => {
    renderToStaticMarkup(<JoinQrCode value={JOIN_URL} isDark={false} participantName="Alex" />)
    expect(qrCodeCanvasSpy).toHaveBeenCalledWith(expect.objectContaining({ value: JOIN_URL }))
  })

  it('never encodes the join URL once revoked, even under the overlay', () => {
    renderToStaticMarkup(<JoinQrCode value={JOIN_URL} isDark={false} revoked participantName="Alex" />)
    expect(qrCodeCanvasSpy).toHaveBeenCalled()
    const { value } = qrCodeCanvasSpy.mock.calls[0][0]
    expect(value).not.toBe(JOIN_URL)
    expect(String(value)).not.toContain(JOIN_URL)
  })

  it('disables the download button once revoked', () => {
    const html = renderToStaticMarkup(<JoinQrCode value={JOIN_URL} isDark={false} revoked participantName="Alex" />)
    expect(html).toContain('disabled=""')
  })

  it('leaves the download button enabled otherwise', () => {
    const html = renderToStaticMarkup(<JoinQrCode value={JOIN_URL} isDark={false} participantName="Alex" />)
    expect(html).not.toContain('disabled=""')
  })
})
