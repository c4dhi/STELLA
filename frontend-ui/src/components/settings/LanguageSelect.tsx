import { useState } from 'react'

/** The languages offered by name. Any other ISO 639-1 code the speech
 *  recognition supports goes in through "Other…", so this list must never
 *  become the only way to set a language. */
export const LISTED_LANGUAGES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'de', name: 'German' },
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'French' },
  { code: 'it', name: 'Italian' },
  { code: 'es', name: 'Spanish' },
]

export const OTHER = '__other__'

/** Which entry of the select a stored value shows: a listed code, OTHER for
 *  any other code, and for an empty value '' (none) unless the user has just
 *  picked "Other…" and not typed a code yet. */
export function languageChoice(value: string, otherPicked = false): string {
  const code = value.trim().toLowerCase()
  if (!code) return otherPicked ? OTHER : ''
  return LISTED_LANGUAGES.some((l) => l.code === code) ? code : OTHER
}

/** The value a select entry stores: '' for none and for a fresh "Other…". */
export function valueForChoice(choice: string): string {
  return choice === OTHER ? '' : choice
}

/** What is saved: a trimmed lower-case code, or undefined (no key) for none. */
export function languageForSave(value: string): string | undefined {
  return value.trim().toLowerCase() || undefined
}

interface LanguageSelectProps {
  value: string
  onChange: (value: string) => void
  /** What the empty entry means here, e.g. "Auto-detect". */
  emptyLabel: string
  /** Classes for both the select and the free-code field. */
  className: string
}

export default function LanguageSelect({ value, onChange, emptyLabel, className }: LanguageSelectProps) {
  const [otherPicked, setOtherPicked] = useState(false)
  const choice = languageChoice(value, otherPicked)

  return (
    <div className="space-y-2">
      <select
        value={choice}
        onChange={(e) => {
          setOtherPicked(e.target.value === OTHER)
          onChange(valueForChoice(e.target.value))
        }}
        className={className}
        aria-label="Language"
      >
        <option value="">{emptyLabel}</option>
        {LISTED_LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>{l.name} ({l.code})</option>
        ))}
        <option value={OTHER}>Other…</option>
      </select>
      {choice === OTHER && (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          placeholder="ISO 639-1 code, e.g. pt"
          maxLength={16}
          aria-label="Language code"
          className={`${className} font-mono`}
        />
      )}
    </div>
  )
}
