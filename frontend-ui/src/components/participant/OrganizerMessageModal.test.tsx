import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import OrganizerMessageModal from './OrganizerMessageModal'

// #213: a public-link participant's name is generated (user-12345), so the
// organiser's message greets them without it.
describe('OrganizerMessageModal', () => {
  it('greets a personally invited participant by name', () => {
    const html = renderToStaticMarkup(
      <OrganizerMessageModal message="Welcome" participantName="Anna" onContinue={() => {}} />,
    )
    expect(html).toContain('Hi Anna, the session organizer has a message for you.')
    expect(html).toContain('Welcome')
  })

  it('leaves the name out when there is none to use', () => {
    const html = renderToStaticMarkup(<OrganizerMessageModal message="Welcome" onContinue={() => {}} />)
    expect(html).toContain('The session organizer has a message for you.')
    expect(html).not.toContain('Hi ')
  })
})
