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

describe('ParticipantChatThread message groups', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 27, 13, 7, s))
  const m = (id: string, role: 'user' | 'assistant', s: number) => ({ id, role, text: `text ${id}`, timestamp: at(s) })

  it('shows the time once under back-to-back messages from one sender, and again after a reply', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    const messages = [m('a', 'user', 0), m('b', 'user', 5), m('c', 'user', 9), m('d', 'assistant', 20)]
    const { container } = render(<ParticipantChatThread {...baseProps} messages={messages as never} />)
    const rows = container.querySelectorAll('[data-group-last]')
    expect([...rows].map((r) => r.getAttribute('data-group-last'))).toEqual(['false', 'false', 'true', 'true'])
    // One time line for the three user messages, one for the reply.
    const time = at(0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    expect(screen.getAllByText(time)).toHaveLength(2)
    // The avatar is shown on the first of the group only.
    expect([...rows].map((r) => r.getAttribute('data-group-first'))).toEqual(['true', 'false', 'false', 'true'])
  })
})
