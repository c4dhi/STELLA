/**
 * Shared presentational env-var list editor. Renders one inline row per variable
 * (KEY / value / delete) with origin badges and inline validation feedback. All
 * state lives in the `editor` (useEnvVarListEditor) passed in by the call site.
 */
import { useCallback, useRef } from 'react'
import type { EnvVarListEditor as Editor } from './useEnvVarListEditor'
import type { EnvVarRow } from './envVarListModel'

interface EnvVarListEditorProps {
  editor: Editor
  isDark: boolean
  /** Value inputs are hidden by default (secrets). */
  valueInputType?: 'password' | 'text'
  /** Show Required/Optional badges + lock declared keys. Default true. */
  showOriginBadges?: boolean
  /** Fires after any user mutation (add/edit/remove/fix) — for dirty tracking / sync. */
  onChange?: () => void
  /** A line under a row, by key: what the variable does (from agent.yaml). */
  hints?: Record<string, string>
}

const PRESERVED_PLACEHOLDER = '•••••••• unchanged'
const TEMPLATE_PLACEHOLDER = '•••••••• from template — type to override'

export default function EnvVarListEditor({
  editor,
  isDark,
  valueInputType = 'password',
  showOriginBadges = true,
  onChange,
  hints = {},
}: EnvVarListEditorProps) {
  const { rows, validation } = editor
  const keyInputRefs = useRef<Map<string, HTMLInputElement>>(new Map())

  const handleAdd = useCallback(() => {
    const id = editor.addRow()
    onChange?.()
    // Focus the new row's key field on the next frame.
    requestAnimationFrame(() => keyInputRefs.current.get(id)?.focus())
  }, [editor, onChange])

  return (
    <div>
      <div className="space-y-2.5">
        {rows.map((row) => (
          <EnvVarRowItem
            key={row.id}
            row={row}
            isDark={isDark}
            valueInputType={valueInputType}
            showOriginBadges={showOriginBadges}
            isDuplicate={validation.duplicateIds.has(row.id)}
            isInvalidKey={validation.invalidKeyIds.has(row.id)}
            isEmptyKey={validation.emptyKeyIds.has(row.id)}
            isMissingValue={validation.missingValueIds.has(row.id)}
            hint={hints[row.key.trim()]}
            onKeyChange={(v) => { editor.updateKey(row.id, v); onChange?.() }}
            onValueChange={(v) => { editor.updateValue(row.id, v); onChange?.() }}
            onFixKey={() => { editor.fixKey(row.id); onChange?.() }}
            onRemove={() => { editor.removeRow(row.id); onChange?.() }}
            registerKeyRef={(el) => {
              if (el) keyInputRefs.current.set(row.id, el)
              else keyInputRefs.current.delete(row.id)
            }}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={handleAdd}
        className={`
          mt-3 flex items-center gap-2 text-sm font-medium transition-colors
          ${isDark ? 'text-primary-400 hover:text-primary-300' : 'text-primary-600 hover:text-primary-700'}
        `}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 5v14M5 12h14" />
        </svg>
        Add Variable
      </button>
    </div>
  )
}

interface EnvVarRowItemProps {
  row: EnvVarRow
  isDark: boolean
  valueInputType: 'password' | 'text'
  showOriginBadges: boolean
  isDuplicate: boolean
  isInvalidKey: boolean
  isEmptyKey: boolean
  isMissingValue: boolean
  hint?: string
  onKeyChange: (value: string) => void
  onValueChange: (value: string) => void
  onFixKey: () => void
  onRemove: () => void
  registerKeyRef: (el: HTMLInputElement | null) => void
}

function EnvVarRowItem({
  row,
  isDark,
  valueInputType,
  showOriginBadges,
  isDuplicate,
  isInvalidKey,
  isEmptyKey,
  isMissingValue,
  hint,
  onKeyChange,
  onValueChange,
  onFixKey,
  onRemove,
  registerKeyRef,
}: EnvVarRowItemProps) {
  const isDeclared = row.origin === 'required' || row.origin === 'optional' || row.origin === 'template'
  const keyLocked = showOriginBadges && isDeclared
  // Required keys must stay; template keys belong to the template (removing a row
  // wouldn't drop the server-side value anyway) — both are non-deletable.
  const deletable = row.origin !== 'required' && row.origin !== 'template'
  const keyHasError = isDuplicate || isInvalidKey || isEmptyKey
  const valuePlaceholder = row.valuePreserved
    ? row.origin === 'template'
      ? TEMPLATE_PLACEHOLDER
      : PRESERVED_PLACEHOLDER
    : 'Value'

  const baseInput = `
    px-3 py-2.5 rounded-lg text-sm focus:outline-none transition-all duration-200
    ${isDark
      ? 'bg-zinc-700/50 border text-zinc-100 placeholder:text-zinc-500'
      : 'bg-neutral-50 border text-neutral-900 placeholder:text-neutral-400'}
  `
  const errorRing = isDark ? 'border-red-500/60 focus:border-red-500' : 'border-red-400 focus:border-red-500'
  const okRing = isDark ? 'border-zinc-600 focus:border-zinc-500' : 'border-neutral-200 focus:border-neutral-400'

  return (
    <div>
      <div className="flex gap-2 items-center">
        {/* Key */}
        <div className="flex-1">
          {keyLocked ? (
            <div
              className={`
                w-full px-3 py-2.5 rounded-lg text-sm font-mono flex items-center justify-between gap-2
                ${isDark ? 'bg-zinc-700/30 border border-zinc-700 text-zinc-200' : 'bg-neutral-100 border border-neutral-200 text-neutral-700'}
              `}
            >
              <span className="truncate">{row.key}</span>
              {showOriginBadges && <OriginBadge origin={row.origin} isDark={isDark} />}
            </div>
          ) : (
            <input
              ref={registerKeyRef}
              type="text"
              value={row.key}
              onChange={(e) => onKeyChange(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className={`w-full font-mono ${baseInput} ${keyHasError ? errorRing : okRing}`}
              placeholder="KEY_NAME"
            />
          )}
        </div>

        {/* Value */}
        <div className="flex-1">
          <input
            type={valueInputType}
            value={row.value}
            onChange={(e) => onValueChange(e.target.value)}
            className={`w-full ${baseInput} ${isMissingValue ? errorRing : okRing}`}
            placeholder={valuePlaceholder}
          />
        </div>

        {/* Delete */}
        <button
          type="button"
          onClick={onRemove}
          disabled={!deletable}
          title={deletable ? 'Remove variable' : 'Required variable'}
          className={`
            p-2.5 rounded-lg transition-all duration-200
            ${!deletable
              ? 'opacity-30 cursor-not-allowed'
              : isDark
                ? 'text-zinc-400 hover:text-red-400 hover:bg-red-500/10'
                : 'text-neutral-400 hover:text-red-500 hover:bg-red-50'}
          `}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* What the variable does, when the agent says */}
      {hint && !(keyHasError || isMissingValue) && (
        <div className={`mt-1 ml-0.5 text-xs font-light ${isDark ? 'text-zinc-500' : 'text-neutral-500'}`}>
          {hint}
        </div>
      )}

      {/* Inline feedback */}
      {(keyHasError || isMissingValue) && (
        <div className="mt-1 ml-0.5 flex items-center gap-2 text-xs">
          {isInvalidKey && (
            <>
              <span className="text-red-500">Use A–Z, 0–9, _ only</span>
              <button
                type="button"
                onClick={onFixKey}
                className={`font-medium underline ${isDark ? 'text-primary-400 hover:text-primary-300' : 'text-primary-600 hover:text-primary-700'}`}
              >
                Fix
              </button>
            </>
          )}
          {isDuplicate && !isInvalidKey && <span className="text-red-500">Duplicate key</span>}
          {isEmptyKey && !isInvalidKey && !isDuplicate && (
            <span className="text-red-500">Enter a key for this value</span>
          )}
          {isMissingValue && !keyHasError && <span className="text-red-500">Value required</span>}
        </div>
      )}
    </div>
  )
}

function OriginBadge({ origin, isDark }: { origin: EnvVarRow['origin']; isDark: boolean }) {
  if (origin === 'required') {
    return (
      <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded ${isDark ? 'bg-red-500/15 text-red-300' : 'bg-red-50 text-red-600'}`}>
        Required
      </span>
    )
  }
  if (origin === 'optional') {
    return (
      <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded ${isDark ? 'bg-zinc-600/40 text-zinc-300' : 'bg-neutral-200 text-neutral-600'}`}>
        Optional
      </span>
    )
  }
  if (origin === 'template') {
    return (
      <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded ${isDark ? 'bg-primary-500/15 text-primary-300' : 'bg-primary-50 text-primary-600'}`}>
        Template
      </span>
    )
  }
  return null
}
