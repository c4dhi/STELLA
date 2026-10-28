import { describe, it, expect } from 'vitest'
import {
  COMPANION_DEFAULT_PERSONA_ID,
  defaultPersonaFor,
  personaFollowingMode,
} from './PersonaSelectionStep'
import type { Persona } from '../../lib/api-types'

const persona = (id: string, isSystemDefault: boolean): Persona => ({
  id,
  name: id,
  systemPrompt: 'prompt',
  isSystemDefault,
  createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: '2026-10-07T00:00:00.000Z',
})

const plan = persona('00000000-0000-4000-8000-000000000001', true)
const companion = persona(COMPANION_DEFAULT_PERSONA_ID, true)
const own = persona('own', false)
const personas = [own, plan, companion]

describe('defaultPersonaFor', () => {
  it('fits the built-in persona to the mode', () => {
    expect(defaultPersonaFor(personas, 'companion')).toBe(companion)
    expect(defaultPersonaFor(personas, 'plan')).toBe(plan)
    expect(defaultPersonaFor(personas, undefined)).toBe(plan)
  })
})

describe('personaFollowingMode', () => {
  it('keeps the standard default the user picked in companion mode', () => {
    expect(personaFollowingMode(personas, 'companion', plan, true)).toBeUndefined()
  })

  it('keeps the companion default the user picked in plan mode', () => {
    expect(personaFollowingMode(personas, 'plan', companion, true)).toBeUndefined()
  })

  it('keeps the companion default the user picked where there is no mode', () => {
    expect(personaFollowingMode(personas, undefined, companion, true)).toBeUndefined()
  })

  it('moves an untouched default when the mode changes', () => {
    expect(personaFollowingMode(personas, 'companion', plan, false)).toBe(companion)
    expect(personaFollowingMode(personas, 'plan', companion, false)).toBe(plan)
  })

  it('leaves an untouched default that already fits', () => {
    expect(personaFollowingMode(personas, 'companion', companion, false)).toBeUndefined()
    expect(personaFollowingMode(personas, 'plan', plan, false)).toBeUndefined()
  })

  it('never moves a user-made persona', () => {
    expect(personaFollowingMode(personas, 'companion', own, true)).toBeUndefined()
    expect(personaFollowingMode(personas, 'companion', own, false)).toBeUndefined()
    expect(personaFollowingMode(personas, 'plan', own, false)).toBeUndefined()
  })

  it('does nothing while nothing is selected or the list is not loaded', () => {
    expect(personaFollowingMode(personas, 'companion', null, false)).toBeUndefined()
    expect(personaFollowingMode([], 'companion', plan, false)).toBeUndefined()
  })
})
