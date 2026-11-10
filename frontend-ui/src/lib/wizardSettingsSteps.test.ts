import { describe, it, expect } from 'vitest'
import { firstSettingsTab, settingsSteps, settingsTabs, startsOver, type EnvVarSetting } from './agentSettings'

const settings: EnvVarSetting[] = [
  { name: 'OPENAI_API_KEY', type: 'secret', required: true, group: 'Keys' },
  { name: 'INTERRUPT_MODE', type: 'enum', group: 'Conversation' },
  { name: 'EXPERT_TIMEOUT_MS', type: 'integer', group: 'Timing', advanced: true },
]

describe('the wizard settings screens (#892)', () => {
  it('asks where to start only when the agent has saved templates', () => {
    expect(settingsSteps(false, 2)).toEqual(['envtemplate', 'envvars'])
    expect(settingsSteps(false, 0)).toEqual(['envvars'])
  })

  it('keeps the template screen while the templates load, so the step bar does not jump', () => {
    expect(settingsSteps(true, 0)).toEqual(['envtemplate', 'envvars'])
  })

  it('opens the settings on Keys when asked to', () => {
    expect(firstSettingsTab(settingsTabs(settings), 'Keys')).toBe('Keys')
  })

  it('otherwise opens on the first tab that is not Keys, as the template editor does', () => {
    expect(firstSettingsTab(settingsTabs(settings))).toBe('Conversation')
  })

  it('falls back when the agent declares no keys', () => {
    expect(firstSettingsTab(settingsTabs(settings.slice(1)), 'Keys')).toBe('Conversation')
    expect(firstSettingsTab([], 'Keys')).toBe('custom')
  })

  it('starts the settings over only for a different starting point', () => {
    const a = { id: 'a' }
    expect(startsOver(a, { id: 'a' })).toBe(false)
    expect(startsOver(null, null)).toBe(false)
    expect(startsOver(a, { id: 'b' })).toBe(true)
    expect(startsOver(a, null)).toBe(true)
    expect(startsOver(null, a)).toBe(true)
  })
})
