import { describe, expect, it } from 'vitest'
import { AgentStatus, SessionStatus } from './api-types'
import { keptOpenNotice, sessionCloseChoice, sessionCloseChoices, closesOnTypeChange } from './closeWhenEmpty'

const base = {
  status: SessionStatus.ACTIVE,
  keptOpenAt: '2026-11-15T18:20:02.000Z',
  agents: [{ id: 'a1', name: 'Jev', status: AgentStatus.FAILED }],
}

describe('keptOpenNotice (#162)', () => {
  it('shows for an active session kept open, with the latest agent to restart', () => {
    expect(keptOpenNotice(base)).toEqual({ since: base.keptOpenAt, agentId: 'a1' })
  })

  it('is gone once somebody is back, or the session is no longer active', () => {
    expect(keptOpenNotice({ ...base, keptOpenAt: null })).toBeNull()
    expect(keptOpenNotice({ ...base, status: SessionStatus.CLOSED })).toBeNull()
  })

  it('still shows without an agent, but offers nothing to restart', () => {
    expect(keptOpenNotice({ ...base, agents: [] })).toEqual({ since: base.keptOpenAt, agentId: null })
  })
})

describe('the session setting', () => {
  it('maps null to "as the project" and back', () => {
    expect(sessionCloseChoice(null)).toBe('project')
    expect(sessionCloseChoice(false)).toBe('keep')
    expect(sessionCloseChoice(true)).toBe('close')
  })

  it('names what "as the project" means', () => {
    expect(sessionCloseChoices(false)[0]).toEqual({ value: 'project', label: 'As the project (keep open)', closeWhenEmpty: null })
    expect(sessionCloseChoices(true)[0].label).toBe('As the project (close)')
  })
})

describe('closesOnTypeChange (#162: public projects default to close)', () => {
  it('defaults a public project to close and a private one to keep open', () => {
    expect(closesOnTypeChange('public', false, false)).toBe(true)
    expect(closesOnTypeChange('private', true, false)).toBe(false)
  })

  it('keeps a choice the organiser made, whichever type they then pick', () => {
    expect(closesOnTypeChange('public', false, true)).toBe(false)
    expect(closesOnTypeChange('private', true, true)).toBe(true)
  })
})
