import type { ReactNode } from 'react'
import type { Persona } from '../../../lib/api-types'

/**
 * Persona tokens — {{persona.<key>}} — in editable text.
 *
 * These are deliberately styled apart from the fixed runtime palette
 * ({{plan}}, {{current_focus}}, …). Those names are standardised and the same in
 * every deployment; a persona variable is invented by whoever wrote the persona,
 * so it can resolve to nothing if the deployed persona does not define it. The
 * UI should make "this one depends on your persona" visible rather than let it
 * pass as another built-in.
 */

// Matches one dotted persona token. Mirrors PERSONA_PATTERN in the SDK compiler;
// the plain \w+ used for built-ins cannot match the dot.
export const PERSONA_TOKEN_RE = /(\{\{persona\.\w+\}\})/g

/** Identity fields every persona has, regardless of what variables it defines. */
export const PERSONA_BUILTIN_KEYS = ['name', 'voice', 'language'] as const

export interface PersonaTokenOption {
  key: string
  token: string
  /** Which personas define it — empty for built-ins, which all personas have. */
  definedBy: string[]
  builtin: boolean
}

/**
 * The keys a plan author can reference, gathered across every persona they own.
 *
 * A plan does not know which persona will run it — that is chosen at deploy —
 * so the honest offer is the union, annotated with who defines what. A key only
 * some personas define is still worth offering; it just needs to be visibly
 * partial rather than silently empty at runtime.
 */
export function collectPersonaTokens(personas: Persona[]): PersonaTokenOption[] {
  const byKey = new Map<string, PersonaTokenOption>()

  for (const key of PERSONA_BUILTIN_KEYS) {
    byKey.set(key, { key, token: `{{persona.${key}}}`, definedBy: [], builtin: true })
  }

  for (const persona of personas) {
    for (const key of Object.keys(persona.variables || {})) {
      const existing = byKey.get(key)
      if (existing) {
        existing.definedBy.push(persona.name)
      } else {
        byKey.set(key, {
          key,
          token: `{{persona.${key}}}`,
          definedBy: [persona.name],
          builtin: false,
        })
      }
    }
  }

  // Built-ins first, in their declared order rather than alphabetically —
  // {{persona.name}} is the overwhelmingly common one and belongs at the front,
  // where an alphabetical sort would bury it behind "language". Author-defined
  // keys follow, alphabetised, since no order is more meaningful than any other.
  const builtinOrder = new Map(PERSONA_BUILTIN_KEYS.map((k, i) => [k as string, i]))
  return [...byKey.values()].sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1
    if (a.builtin && b.builtin) {
      return (builtinOrder.get(a.key) ?? 0) - (builtinOrder.get(b.key) ?? 0)
    }
    return a.key.localeCompare(b.key)
  })
}

/** Split text into plain runs and highlighted persona tokens. */
export function highlightPersonaTokens(
  text: string,
  isDark: boolean,
  known: Set<string>,
): ReactNode[] {
  if (!text) return [<span key="empty">{'\n'}</span>]

  return text.split(PERSONA_TOKEN_RE).map((part, i) => {
    const match = /^\{\{persona\.(\w+)\}\}$/.exec(part)
    if (!match) {
      return (
        <span key={i} className={isDark ? 'text-zinc-300' : 'text-neutral-700'}>
          {part}
        </span>
      )
    }
    // A token no persona defines is shown as a warning rather than as valid: at
    // runtime it resolves to an empty string, which is silent and easy to miss.
    const isKnown = known.has(match[1])
    const cls = isKnown
      ? isDark
        ? 'bg-fuchsia-500/25 text-fuchsia-300'
        : 'bg-fuchsia-100 text-fuchsia-700'
      : isDark
        ? 'bg-amber-500/20 text-amber-400 line-through decoration-amber-500/40'
        : 'bg-amber-100 text-amber-700 line-through decoration-amber-400/50'
    // CRITICAL: this span may not change the text's METRICS. The backdrop has to
    // lay out character-for-character identically to the textarea on top of it,
    // so horizontal padding, font-weight, letter-spacing and font-size are all
    // off limits — any of them shifts every character after the token and the
    // caret stops matching what you see. Colour and background only.
    // box-decoration-break keeps the tint on both halves of a wrapped token.
    return (
      <span
        key={i}
        className={`${cls} rounded-[2px]`}
        style={{ WebkitBoxDecorationBreak: 'clone', boxDecorationBreak: 'clone' }}
      >
        {part}
      </span>
    )
  })
}
