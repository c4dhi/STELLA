import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import LanguageSelect, { LISTED_LANGUAGES, OTHER, languageChoice, languageForSave, valueForChoice } from './LanguageSelect'

const render = (value: string) =>
  renderToStaticMarkup(<LanguageSelect value={value} onChange={() => {}} emptyLabel="Auto-detect" className="" />)

describe('LanguageSelect', () => {
  it('still offers every language and "Other…" with English selected', () => {
    // The old datalist filtered its suggestions by what was typed: "en" left
    // only English and French.
    const html = render('en')
    for (const l of LISTED_LANGUAGES) expect(html).toContain(`value="${l.code}"`)
    expect(html).toContain(`value="${OTHER}"`)
    expect(html).toContain('Auto-detect')
    expect(languageChoice('en')).toBe('en')
  })

  it('opens a plan with an unlisted code on "Other…", showing the code', () => {
    expect(languageChoice('pt')).toBe(OTHER)
    const html = render('pt')
    expect(html).toContain('aria-label="Language code"')
    expect(html).toContain('value="pt"')
  })

  it('shows no code field for auto-detect or a listed language', () => {
    expect(render('')).not.toContain('Language code')
    expect(render('de')).not.toContain('Language code')
  })

  it('reads stored codes case-insensitively', () => {
    expect(languageChoice('DE')).toBe('de')
    expect(languageChoice(' Pt ')).toBe(OTHER)
  })

  it('keeps "Other…" open while no code is typed yet', () => {
    expect(languageChoice('', true)).toBe(OTHER)
    expect(languageChoice('')).toBe('')
  })

  it('stores nothing for auto-detect or a fresh "Other…", and the code otherwise', () => {
    expect(valueForChoice('')).toBe('')
    expect(valueForChoice(OTHER)).toBe('')
    expect(valueForChoice('fr')).toBe('fr')
  })

  it('saves a free code in lower case and no language for auto-detect', () => {
    expect(languageForSave('PT')).toBe('pt')
    expect(languageForSave(' de ')).toBe('de')
    expect(languageForSave('')).toBeUndefined()
    expect(languageForSave('   ')).toBeUndefined()
  })
})
