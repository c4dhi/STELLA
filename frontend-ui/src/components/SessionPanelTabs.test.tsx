import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import SessionPanelTabs, { visiblePanel } from './SessionPanelTabs'

describe('the session page on a narrow screen (#181)', () => {
  it('shows the chosen panel', () => {
    expect(visiblePanel('chat', true)).toBe('chat')
    expect(visiblePanel('people', false)).toBe('people')
    expect(visiblePanel('plan', true)).toBe('plan')
  })

  it('falls back to the conversation when the plan goes away', () => {
    expect(visiblePanel('plan', false)).toBe('chat')
  })

  it('offers the plan tab only while there is a plan', () => {
    const tabs = (showPlan: boolean) =>
      renderToStaticMarkup(<SessionPanelTabs active="chat" onSelect={() => {}} showPlan={showPlan} isDark={false} />)
    expect(tabs(true)).toContain('>Plan<')
    expect(tabs(false)).not.toContain('>Plan<')
    expect(tabs(false)).toContain('>Conversation<')
    expect(tabs(false)).toContain('>People<')
  })

  it('marks the active tab and is hidden from tablet width up', () => {
    const html = renderToStaticMarkup(<SessionPanelTabs active="people" onSelect={() => {}} showPlan={false} isDark />)
    expect(html).toMatch(/aria-selected="true"[^>]*>People</)
    expect(html).toContain('md:hidden')
  })
})
