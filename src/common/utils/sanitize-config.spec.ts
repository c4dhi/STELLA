import { sanitizeAgentConfig } from './sanitize-config.js'

describe('sanitizeAgentConfig', () => {
  it('keeps legitimate configuration keys and values', () => {
    // Regression guard: normal runtime config keys should remain usable after sanitization.
    const input = {
      plan: { states: [{ id: 'intro' }] },
      llm: { model: 'gpt-4o-mini', temperature: 0.4 },
      pipeline: { input_gate: { max_tokens: 120 } },
      expert_overrides: { medical: { enabled: false } },
      enableDebug: true,
      maxTurns: 12,
    }

    const output = sanitizeAgentConfig(input)

    expect(output).toEqual(input)
  })

  it('blocks sensitive keys at root level', () => {
    // Security guard: secrets/credentials must never survive config sanitization.
    const output = sanitizeAgentConfig({
      OPENAI_API_KEY: 'sk-123',
      LIVEKIT_API_SECRET: 'secret',
      DATABASE_URL: 'postgres://...',
      password: 'p@ss',
      token: 'jwt-token',
      safe: 'ok',
    })

    expect(output).toEqual({ safe: 'ok' })
  })

  it('blocks sensitive keys case-insensitively', () => {
    // Security guard: attackers should not bypass blocking using mixed/lower case variants.
    const output = sanitizeAgentConfig({
      openai_api_key: 'sk-123',
      Password: 'p@ss',
      ToKeN: 'jwt',
      safe: true,
    } as unknown as Record<string, unknown>)

    expect(output).toEqual({ safe: true })
  })

  it('blocks prototype pollution keys', () => {
    // Security guard: prototype-related keys are dropped to prevent object pollution attacks.
    const output = sanitizeAgentConfig({
      __proto__: { polluted: true },
      constructor: { dangerous: true },
      prototype: { dangerous: true },
      normal: 'value',
    } as unknown as Record<string, unknown>)

    expect(output).toEqual({ normal: 'value' })
  })

  it('sanitizes nested objects recursively', () => {
    // Security + regression: nested secret keys are removed, but nested valid config remains.
    const output = sanitizeAgentConfig({
      llm: {
        model: 'gpt-4o-mini',
        OPENAI_API_KEY: 'sk-123',
      },
      nested: {
        token: 'jwt',
        keep: 42,
      },
    })

    expect(output).toEqual({
      llm: {
        model: 'gpt-4o-mini',
      },
      nested: {
        keep: 42,
      },
    })
  })

  it('sanitizes arrays while preserving supported values', () => {
    // Arrays should keep allowed primitives and recursively sanitize object items.
    const output = sanitizeAgentConfig({
      values: [
        'ok',
        1,
        true,
        null,
        { keep: 'yes', password: 'nope' },
      ],
    })

    expect(output).toEqual({
      values: [
        'ok',
        1,
        true,
        null,
        { keep: 'yes' },
      ],
    })
  })

  it('returns empty object for non-object inputs', () => {
    // Defensive behavior: invalid root config shapes should safely collapse to empty config.
    expect(sanitizeAgentConfig(null as unknown as Record<string, unknown>)).toEqual({})
    expect(sanitizeAgentConfig([] as unknown as Record<string, unknown>)).toEqual({})
    expect(sanitizeAgentConfig('bad' as unknown as Record<string, unknown>)).toEqual({})
  })

  it('removes control characters from key names', () => {
    // Key hygiene: control characters are stripped from keys before storing config.
    const output = sanitizeAgentConfig({
      'na\u0000me': 'value',
      '\u0007': 'drop-me',
    } as unknown as Record<string, unknown>)

    expect(output).toEqual({
      name: 'value',
    })
  })
})
