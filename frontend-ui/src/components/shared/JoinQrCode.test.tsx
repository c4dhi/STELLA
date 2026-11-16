import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import JoinQrCode from './JoinQrCode'

const JOIN_URL = 'https://stella.example/join/abc123'

describe('JoinQrCode', () => {
  it('encodes the exact join URL', () => {
    const html = renderToStaticMarkup(
      <JoinQrCode value={JOIN_URL} isDark={false} downloadFileName="invite.png" />,
    )
    expect(html).toContain(`data-qr-value="${JOIN_URL}"`)
  })

  it('shows no active QR value once revoked', () => {
    const html = renderToStaticMarkup(
      <JoinQrCode value={JOIN_URL} isDark={false} revoked downloadFileName="invite.png" />,
    )
    expect(html).toContain('data-qr-value=""')
    expect(html).not.toContain(JOIN_URL)
  })

  it('disables the download button once revoked', () => {
    const html = renderToStaticMarkup(
      <JoinQrCode value={JOIN_URL} isDark={false} revoked downloadFileName="invite.png" />,
    )
    expect(html).toContain('disabled=""')
  })

  it('leaves the download button enabled otherwise', () => {
    const html = renderToStaticMarkup(
      <JoinQrCode value={JOIN_URL} isDark={false} downloadFileName="invite.png" />,
    )
    expect(html).not.toContain('disabled=""')
  })
})
