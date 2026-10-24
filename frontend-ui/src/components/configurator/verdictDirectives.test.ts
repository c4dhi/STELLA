import { describe, it, expect } from 'vitest'
import { readVerdictDirectives, verdictDirectivesEqual } from './useConfiguratorState'

// #75: the shipped medical/legal experts carry translated caution lines in
// template_i18n. Editing a verdict in the Configurator must not drop them.
const PUBLISHED = {
  none: { action: 'inform', template: '' },
  high: {
    action: 'prepend',
    template: "I can't give medical advice.",
    template_i18n: { de: 'Ich kann keine medizinische Beratung geben.' },
  },
}

describe('verdict directives keep template_i18n', () => {
  it('reads template_i18n from a published default', () => {
    const read = readVerdictDirectives(PUBLISHED)
    expect(read.high.template_i18n).toEqual({ de: 'Ich kann keine medizinische Beratung geben.' })
    expect(read.none.template_i18n).toBeUndefined()
  })

  it('keeps template_i18n through an edit, the save and a re-read', () => {
    const defaults = readVerdictDirectives(PUBLISHED)
    // As ExpertCard.setDirective does: the effective directive plus the patch.
    const edited = { ...defaults, high: { ...defaults.high, description: 'A specific health concern.' } }
    // The save writes the map into the configuration JSON as is.
    const saved = JSON.parse(JSON.stringify(edited))
    const reread = readVerdictDirectives(saved)
    expect(reread.high.template_i18n).toEqual({ de: 'Ich kann keine medizinische Beratung geben.' })
    expect(reread.high.description).toBe('A specific health concern.')
  })

  it('ignores a malformed template_i18n rather than passing it on', () => {
    const read = readVerdictDirectives({
      high: { action: 'prepend', template: 'x', template_i18n: { de: 'ok', fr: 3 } },
      low: { action: 'inform', template: '', template_i18n: 'nope' },
    })
    expect(read.high.template_i18n).toEqual({ de: 'ok' })
    expect(read.low.template_i18n).toBeUndefined()
  })

  it('counts a missing translation as a change from the default', () => {
    const defaults = readVerdictDirectives(PUBLISHED)
    const { template_i18n: _dropped, ...withoutI18n } = defaults.high
    expect(verdictDirectivesEqual(defaults, { ...defaults, high: withoutI18n })).toBe(false)
    expect(verdictDirectivesEqual(defaults, readVerdictDirectives(PUBLISHED))).toBe(true)
  })
})
