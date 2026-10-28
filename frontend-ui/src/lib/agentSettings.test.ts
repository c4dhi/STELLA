import { describe, expect, it } from 'vitest'
import {
  checkEnvVarValue,
  defaultLabel,
  invalidSettings,
  removedTemplateKeys,
  settingsFromSchema,
  settingsTabs,
  splitVariables,
  type EnvVarSetting,
} from './agentSettings'

const schema = {
  'x-stella-env-vars': ['OPENAI_API_KEY'],
  'x-stella-optional-env-vars': [
    { name: 'BARGE_IN_ENABLED', type: 'boolean', group: 'Conversation', agentDefault: 'true' },
    { name: 'TTS_SPEED', type: 'number', group: 'Voice', min: 0.5, max: 2, unit: '×', agentDefault: '1.0' },
    { name: 'STELLA_TTS_PREROLL_MS', type: 'integer', group: 'Voice', advanced: true, unsetLabel: 'Automatic' },
    { name: 'STELLA_TTS_PLAYBACK', type: 'enum', group: 'Voice', default: 'auto', options: [{ value: 'auto', label: 'Auto' }, { value: 'sentence' }] },
    { name: 'STELLA_EXPERTS_DIR' },
  ],
}

describe('agent settings', () => {
  const settings = settingsFromSchema(schema)

  it('lists the required key as a secret and the optional variables as settings', () => {
    expect(settings.map((s) => s.name)).toEqual([
      'OPENAI_API_KEY', 'BARGE_IN_ENABLED', 'TTS_SPEED', 'STELLA_TTS_PREROLL_MS', 'STELLA_TTS_PLAYBACK', 'STELLA_EXPERTS_DIR',
    ])
    expect(settings[0]).toMatchObject({ type: 'secret', required: true })
  })

  it('makes tabs: keys first, groups in manifest order, General for ungrouped, Advanced last', () => {
    expect(settingsTabs(settings).map((t) => [t.id, t.settings.map((s) => s.name)])).toEqual([
      ['Keys', ['OPENAI_API_KEY']],
      ['Conversation', ['BARGE_IN_ENABLED']],
      ['Voice', ['TTS_SPEED', 'STELLA_TTS_PLAYBACK']],
      ['General', ['STELLA_EXPERTS_DIR']],
      ['Advanced', ['STELLA_TTS_PREROLL_MS']],
    ])
  })

  it('describes the default in words', () => {
    const by = (n: string) => settings.find((s) => s.name === n) as EnvVarSetting
    expect(defaultLabel(by('BARGE_IN_ENABLED'))).toBe('On')
    expect(defaultLabel(by('TTS_SPEED'))).toBe('1.0 ×')
    expect(defaultLabel(by('STELLA_TTS_PREROLL_MS'))).toBe('Automatic')
    expect(defaultLabel(by('STELLA_TTS_PLAYBACK'))).toBe('Auto')
    expect(defaultLabel(by('STELLA_EXPERTS_DIR'))).toBe('not set')
  })

  it('checks values exactly as the backend does', () => {
    const speed = settings[2]
    expect(checkEnvVarValue(speed, '3')).toBe('must be between 0.5 and 2')
    expect(checkEnvVarValue(speed, 'x')).toBe('must be a number')
    expect(checkEnvVarValue(settings[1], 'yes')).toBe('must be true or false')
    expect(invalidSettings(settings, { TTS_SPEED: '3', STELLA_TTS_PREROLL_MS: '', OPENAI_API_KEY: 'k' })).toEqual({
      TTS_SPEED: 'must be between 0.5 and 2',
    })
  })

  it('splits variables into declared settings and custom ones', () => {
    expect(splitVariables(settings, { TTS_SPEED: '1', STUDY_ARM: 'A' })).toEqual({
      settings: { TTS_SPEED: '1' },
      custom: { STUDY_ARM: 'A' },
    })
  })

  it('takes out the settings reset and the custom rows deleted, never a stored secret', () => {
    const template = {
      variableKeys: ['OPENAI_API_KEY', 'TTS_SPEED', 'BARGE_IN_ENABLED', 'STUDY_ARM', 'SITE'],
      settings: { TTS_SPEED: '0.9', BARGE_IN_ENABLED: 'false' },
    }
    // TTS_SPEED reset, BARGE_IN_ENABLED kept, STUDY_ARM row deleted.
    expect(removedTemplateKeys(template, settings, { BARGE_IN_ENABLED: 'false' }, ['SITE'])).toEqual([
      'TTS_SPEED',
      'STUDY_ARM',
    ])
  })
})
