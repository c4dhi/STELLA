import { describe, it, expect } from 'vitest'
import { planDeclaredLanguage, showsVoiceStep, languageEnvVars } from './sessionLanguage'
import type { PlanTemplate, TtsCapabilities } from './api-types'

const plan = (language?: string): PlanTemplate => ({
  id: 'p', userId: 'u', name: 'Plan', content: { states: [], ...(language ? { language } : {}) },
  createdAt: '', updatedAt: '',
})

const caps = (over: Partial<TtsCapabilities> = {}): TtsCapabilities => ({
  provider: 'qwen3', voices: [{ id: 'v', displayName: 'V', languages: ['de'], defaultLanguage: 'de' }],
  languages: ['de', 'en'], defaultVoice: 'v', supportsVoiceSelection: true, ...over,
})

describe('planDeclaredLanguage', () => {
  it('reads and normalizes a declared code', () => {
    expect(planDeclaredLanguage(plan('DE'))).toBe('de')
    expect(planDeclaredLanguage(plan(' de '))).toBe('de')
  })

  it('is empty when the plan declares nothing', () => {
    expect(planDeclaredLanguage(plan())).toBe('')
    expect(planDeclaredLanguage(null)).toBe('')
  })
})

describe('showsVoiceStep', () => {
  it('still shows when there is a voice to choose, plan language or not', () => {
    expect(showsVoiceStep(caps(), 'de')).toBe(true)
    expect(showsVoiceStep(caps(), '')).toBe(true)
  })

  it('is skipped when language was the only question and the plan answered it', () => {
    const languageOnly = caps({ supportsVoiceSelection: false })
    expect(showsVoiceStep(languageOnly, '')).toBe(true)
    expect(showsVoiceStep(languageOnly, 'de')).toBe(false)
  })

  it('is skipped when the provider offers nothing at all', () => {
    expect(showsVoiceStep(caps({ voices: [] }), '')).toBe(false)
    expect(showsVoiceStep(null, '')).toBe(false)
  })
})

describe('languageEnvVars', () => {
  it('pins the operator choice when the plan declares nothing', () => {
    expect(languageEnvVars('fr', '')).toEqual({ STELLA_LANGUAGE: 'fr', TTS_LANGUAGE: 'fr' })
  })

  it('pins nothing when the operator chose Auto', () => {
    expect(languageEnvVars('', '')).toEqual({})
  })

  it('defers to the plan, discarding a stale pick made before it was chosen', () => {
    // The operator picks French, goes back, then selects a German plan.
    // STELLA_LANGUAGE outranks the plan's pin, so writing it here would make
    // the deployment French and silently contradict the plan's own content.
    expect(languageEnvVars('fr', 'de')).toEqual({})
  })
})
