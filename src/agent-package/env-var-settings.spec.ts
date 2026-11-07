import {
  checkEnvVarValue,
  classifyEnvVars,
  extractEnvVarSettings,
  invalidEnvVarValues,
  EnvVarSetting,
  ENV_VAR_FORMATS,
} from './env-var-settings.js'

const speed: EnvVarSetting = { name: 'TTS_SPEED', type: 'number', min: 0.5, max: 2 }
const tick: EnvVarSetting = { name: 'TTS_PROGRESS_TICK_MS', type: 'integer', min: 50, max: 1000 }
const bargeIn: EnvVarSetting = { name: 'BARGE_IN_ENABLED', type: 'boolean' }
const playback: EnvVarSetting = {
  name: 'STELLA_TTS_PLAYBACK',
  type: 'enum',
  options: [{ value: 'auto' }, { value: 'stream' }, { value: 'sentence' }],
}
const language: EnvVarSetting = { name: 'STELLA_LANGUAGE', type: 'string', format: 'language-or-auto' }

describe('checkEnvVarValue', () => {
  it('accepts values that fit the declared type', () => {
    expect(checkEnvVarValue(speed, '0.95')).toBeNull()
    expect(checkEnvVarValue(tick, '200')).toBeNull()
    expect(checkEnvVarValue(bargeIn, 'false')).toBeNull()
    expect(checkEnvVarValue(playback, 'sentence')).toBeNull()
    expect(checkEnvVarValue(language, 'de')).toBeNull()
  })

  it('rejects a number outside its range, naming the range', () => {
    expect(checkEnvVarValue(speed, '3')).toBe('must be between 0.5 and 2')
    expect(checkEnvVarValue(tick, '10')).toBe('must be between 50 and 1000')
  })

  it('rejects what is not a number, or not a whole number for an integer', () => {
    expect(checkEnvVarValue(speed, 'fast')).toBe('must be a number')
    expect(checkEnvVarValue(speed, '')).toBe('must be a number')
    expect(checkEnvVarValue(tick, '200.5')).toBe('must be a whole number')
  })

  it('accepts only true or false for a boolean', () => {
    expect(checkEnvVarValue(bargeIn, 'yes')).toBe('must be true or false')
    expect(checkEnvVarValue(bargeIn, 'TRUE')).toBe('must be true or false')
  })

  it('rejects an enum value that is not one of the options, listing them', () => {
    expect(checkEnvVarValue(playback, 'fast')).toBe('must be one of: auto, stream, sentence')
  })

  it('checks a string against its fixed format', () => {
    expect(checkEnvVarValue(language, 'auto')).toBeNull()
    expect(checkEnvVarValue(language, 'deu')).toBe('must be "auto" or a two-letter language code, e.g. "de"')
    expect(checkEnvVarValue({ name: 'TTS_LANGUAGE', format: 'language' }, 'auto')).toBe(
      'must be a two-letter language code, e.g. "de"',
    )
  })

  it('offers only STELLA\'s own formats, no regular expression from a manifest (ReDoS)', () => {
    expect(ENV_VAR_FORMATS).toEqual(['language', 'language-or-auto'])
  })

  it('treats a declared variable without a type as free text', () => {
    expect(checkEnvVarValue({ name: 'STELLA_EXPERTS_DIR' }, 'anything at all')).toBeNull()
  })
})

describe('extractEnvVarSettings', () => {
  it('lists required keys as secrets first, then the optional settings', () => {
    const settings = extractEnvVarSettings({
      required: ['OPENAI_API_KEY'],
      optional: [{ name: 'TTS_SPEED', type: 'number', min: 0.5, max: 2 }],
    })
    expect(settings.map((s) => [s.name, s.type, s.required])).toEqual([
      ['OPENAI_API_KEY', 'secret', true],
      ['TTS_SPEED', 'number', undefined],
    ])
  })

  it('is empty for an agent without a readable manifest', () => {
    expect(extractEnvVarSettings(null)).toEqual([])
    expect(extractEnvVarSettings(undefined)).toEqual([])
  })
})

describe('classifyEnvVars', () => {
  const env = { required: ['OPENAI_API_KEY'], optional: [speed, bargeIn] }

  it('splits declared keys into settings and keeps the rest as custom', () => {
    expect(
      classifyEnvVars(env, { TTS_SPEED: '0.95', OPENAI_API_KEY: 'k', STUDY_ARM: 'A' }),
    ).toEqual({
      settings: { TTS_SPEED: '0.95', OPENAI_API_KEY: 'k' },
      custom: { STUDY_ARM: 'A' },
    })
  })
})

describe('invalidEnvVarValues', () => {
  it('reports each declared key whose value does not fit, and ignores custom keys', () => {
    const env = { required: [], optional: [speed, bargeIn] }
    expect(invalidEnvVarValues(env, { TTS_SPEED: '3', BARGE_IN_ENABLED: 'false', STUDY_ARM: '???' })).toEqual({
      TTS_SPEED: 'must be between 0.5 and 2',
    })
  })

  it('leaves an empty value alone, which the agent reads as unset', () => {
    expect(invalidEnvVarValues({ required: [], optional: [speed] }, { TTS_SPEED: '' })).toEqual({})
  })
})
