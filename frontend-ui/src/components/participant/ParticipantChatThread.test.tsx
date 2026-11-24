// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import ParticipantChatThread from './ParticipantChatThread'

afterEach(cleanup)

// jsdom doesn't implement this; the thread calls it to follow new messages.
Element.prototype.scrollIntoView = vi.fn()

const baseProps = {
  variant: 'page' as const,
  messages: [],
  room: null,
  participantName: 'participant-1',
  hint: 'Enter sends · Shift + Enter starts a new line',
}

describe('ParticipantChatThread hint', () => {
  it('shows the Enter/Shift+Enter hint when a physical keyboard is present', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    render(<ParticipantChatThread {...baseProps} />)
    expect(screen.getByText(baseProps.hint)).not.toBeNull()
  })

  it('hides the hint on a touch-only device with no physical keyboard', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }))
    render(<ParticipantChatThread {...baseProps} />)
    expect(screen.queryByText(baseProps.hint)).toBeNull()
  })

  it('uses a 16px input so iOS Safari does not zoom the page on focus', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    render(<ParticipantChatThread {...baseProps} />)
    expect(screen.getByLabelText('Your answer').className).toContain('text-base')
  })
})
