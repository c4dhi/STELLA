import { useRef, useMemo, useState } from 'react'
import { useThemeStore } from '../../../store/themeStore'
import type { Persona } from '../../../lib/api-types'
import {
  collectPersonaTokens,
  highlightPersonaTokens,
  type PersonaTokenOption,
} from './personaTokens'

interface VariableTextAreaProps {
  value: string
  onChange: (value: string) => void
  personas: Persona[]
  placeholder?: string
  rows?: number
  /** Single-line fields (a task title) still benefit from the token palette. */
  singleLine?: boolean
  className?: string
}

/**
 * A text field that knows about {{persona.*}}.
 *
 * Two jobs, both aimed at the same problem: a plan author has no way to discover
 * that these tokens exist, and no feedback that one they typed will actually
 * resolve.
 *
 *  - **Highlighting** — tokens are tinted inside the field via a backdrop layer
 *    behind a transparent textarea (the same technique the Configurator's
 *    PromptComposer uses; a plain <textarea> cannot render rich text).
 *  - **Insertion** — a palette of the keys the author's personas actually define,
 *    inserted at the cursor, so nobody has to remember the exact syntax.
 *
 * Deliberately distinct from the Configurator's fixed palette: those names are
 * standardised, while these are invented per persona and resolve to nothing when
 * the deployed persona does not define them.
 */
export default function VariableTextArea({
  value,
  onChange,
  personas,
  placeholder,
  rows = 3,
  singleLine = false,
  className = '',
}: VariableTextAreaProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const ref = useRef<HTMLTextAreaElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const options = useMemo(() => collectPersonaTokens(personas), [personas])
  const knownKeys = useMemo(() => new Set(options.map((o) => o.key)), [options])

  const insert = (option: PersonaTokenOption) => {
    const el = ref.current
    if (!el) return
    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? start
    const next = value.slice(0, start) + option.token + value.slice(end)
    onChange(next)
    // Restore the caret after the inserted token rather than dropping it to the
    // end, so inserting mid-sentence does not interrupt typing.
    requestAnimationFrame(() => {
      el.focus()
      el.selectionStart = el.selectionEnd = start + option.token.length
    })
  }

  // The backdrop must scroll in lockstep with the textarea or the highlight
  // drifts away from the text on longer values.
  const syncScroll = () => {
    if (backdropRef.current && ref.current) {
      backdropRef.current.scrollTop = ref.current.scrollTop
      backdropRef.current.scrollLeft = ref.current.scrollLeft
    }
  }

  const shared =
    'w-full px-3 py-2 text-[13px] leading-relaxed font-normal whitespace-pre-wrap break-words'
  const box = isDark
    ? 'bg-zinc-800 border-zinc-700'
    : 'bg-white border-neutral-200'

  return (
    <div className={className}>
      <div className={`relative rounded-lg border ${box} focus-within:border-fuchsia-400/60 transition-colors`}>
        <div
          ref={backdropRef}
          aria-hidden="true"
          className={`${shared} absolute inset-0 overflow-hidden pointer-events-none`}
          style={{ fontFamily: 'inherit' }}
        >
          {highlightPersonaTokens(value, isDark, knownKeys)}
        </div>
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          placeholder={placeholder}
          rows={singleLine ? 1 : rows}
          spellCheck={false}
          className={`${shared} relative bg-transparent resize-none focus:outline-none ${
            isDark ? 'text-transparent caret-zinc-100' : 'text-transparent caret-neutral-900'
          } placeholder:text-neutral-400`}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      <div className="mt-1.5 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setPaletteOpen((o) => !o)}
          className={`text-[11px] font-medium px-2 py-1 rounded-md border transition-colors ${
            isDark
              ? 'border-fuchsia-500/30 text-fuchsia-300 hover:bg-fuchsia-500/10'
              : 'border-fuchsia-200 text-fuchsia-700 hover:bg-fuchsia-50'
          }`}
        >
          {paletteOpen ? '× ' : '+ '}persona variable
        </button>
        {!paletteOpen && (
          <span className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
            Insert a value from the persona chosen at deploy time
          </span>
        )}
      </div>

      {paletteOpen && (
        <div
          className={`mt-1.5 p-2 rounded-lg border ${
            isDark ? 'bg-zinc-800/60 border-zinc-700' : 'bg-neutral-50 border-neutral-200'
          }`}
        >
          <div className="flex flex-wrap gap-1.5">
            {options.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => insert(option)}
                title={
                  option.builtin
                    ? 'Every persona has this'
                    : `Defined by: ${option.definedBy.join(', ')}`
                }
                className={`font-mono text-[11px] px-2 py-1 rounded-md border transition-colors ${
                  isDark
                    ? 'bg-fuchsia-500/10 border-fuchsia-500/25 text-fuchsia-300 hover:bg-fuchsia-500/20'
                    : 'bg-fuchsia-50 border-fuchsia-200 text-fuchsia-700 hover:bg-fuchsia-100'
                }`}
              >
                {option.token}
              </button>
            ))}
          </div>
          <p className={`mt-2 text-[11px] leading-relaxed ${isDark ? 'text-zinc-500' : 'text-neutral-500'}`}>
            Resolved from the persona selected when the agent is deployed.{' '}
            <span className="font-mono">name</span>, <span className="font-mono">voice</span> and{' '}
            <span className="font-mono">language</span> exist on every persona; the rest come from
            a persona&apos;s own variables, so a token the deployed persona does not define
            resolves to nothing.
          </p>
        </div>
      )}
    </div>
  )
}
