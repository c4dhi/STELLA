import { describe, it, expect } from 'vitest'
import { collectPersonaTokens, PERSONA_TOKEN_RE } from './personaTokens'
import type { Persona } from '../../../lib/api-types'

const persona = (name: string, variables: Record<string, string> = {}): Persona =>
  ({ id: name, name, systemPrompt: '', isSystemDefault: false, variables,
     createdAt: '', updatedAt: '' } as Persona)

describe('collectPersonaTokens', () => {
  it('always offers the built-in identity fields', () => {
    // Every persona has these, so they are offerable even with no personas saved.
    expect(collectPersonaTokens([]).map((o) => o.key)).toEqual(['name', 'voice', 'language'])
  })

  it('unions author-defined variables across personas', () => {
    // A plan does not know which persona will run it — the palette is the union,
    // not the intersection, or a key only one persona defines would be unofferable.
    const tokens = collectPersonaTokens([
      persona('Grace', { role: 'companion' }),
      persona('Max', { tone: 'brisk' }),
    ])
    expect(tokens.map((o) => o.key)).toContain('role')
    expect(tokens.map((o) => o.key)).toContain('tone')
  })

  it('records which personas define a key, so partial coverage is visible', () => {
    const tokens = collectPersonaTokens([
      persona('Grace', { role: 'companion' }),
      persona('Max', { role: 'coach' }),
      persona('Ada'),
    ])
    const role = tokens.find((o) => o.key === 'role')!
    expect(role.definedBy).toEqual(['Grace', 'Max'])
    expect(role.builtin).toBe(false)
  })

  it('does not let a variable named after a built-in create a duplicate entry', () => {
    const tokens = collectPersonaTokens([persona('Grace', { name: 'Gracie' })])
    expect(tokens.filter((o) => o.key === 'name')).toHaveLength(1)
  })

  it('builds the exact token text the compiler matches', () => {
    const role = collectPersonaTokens([persona('Grace', { role: 'x' })]).find((o) => o.key === 'role')!
    expect(role.token).toBe('{{persona.role}}')
  })
})

describe('PERSONA_TOKEN_RE', () => {
  it('splits persona tokens out of surrounding text', () => {
    const parts = 'Hi {{persona.name}}, meet {{current_focus}}.'.split(PERSONA_TOKEN_RE)
    expect(parts).toContain('{{persona.name}}')
    // Built-in palette tokens are left alone — they are highlighted elsewhere and
    // are not the plan author's to define.
    expect(parts).not.toContain('{{current_focus}}')
  })
})
