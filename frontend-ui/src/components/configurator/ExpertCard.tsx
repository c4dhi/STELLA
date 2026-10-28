/**
 * ExpertCard — expandable card for a single expert in the sidebar.
 *
 * Shows name, description, priority badge, enabled/alwaysTriggered toggles.
 * Expands to reveal: triggerCriteria, model, temperature, maxTokens, systemPrompt.
 * Drag handle for reordering (via @dnd-kit).
 */

import { memo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ExpertDefinition } from './useConfiguratorState'
import { verdictDirectivesEqual } from './useConfiguratorState'
import { PromptComposer, buildExpertBlocks } from './PromptComposer'
import type { VerdictAction, VerdictDirective } from '../../lib/api-types'

const INFORM: VerdictDirective = { action: 'inform', template: '' }

const VERDICT_ACTION_OPTIONS: { value: VerdictAction; label: string; hint: string }[] = [
  { value: 'inform', label: 'Inform (LLM writes reply)', hint: 'Default — the model writes the reply; the template is unused.' },
  { value: 'prepend', label: 'Prepend (speak then continue)', hint: 'Speak the template first, then the generated reply.' },
  { value: 'override', label: 'Override (replace reply)', hint: 'Speak only the template; skip the response LLM. Post-processing still runs.' },
  { value: 'short_circuit', label: 'Short-circuit (replace + stop)', hint: 'Speak only the template and end the turn — nothing downstream runs.' },
]

interface ExpertCardProps {
  expert: ExpertDefinition
  index: number
  isExpanded: boolean
  onToggleExpand: () => void
  onUpdate: (updates: Partial<ExpertDefinition>) => void
  onRemove?: () => void
  isDark: boolean
}

const MODEL_OPTIONS = ['gpt-5.4-mini', 'gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1-nano']

function CollapsibleSettings({ isDark, children }: { isDark: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`rounded-lg border ${
      isDark ? 'bg-zinc-800/40 border-zinc-700/50' : 'bg-neutral-50/50 border-neutral-200/40'
    }`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors rounded-lg ${
          isDark ? 'hover:bg-zinc-700/40' : 'hover:bg-neutral-100/60'
        }`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className={isDark ? 'text-zinc-600' : 'text-neutral-400'}
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
        <span className={`flex-1 text-[10px] font-semibold tracking-wide uppercase ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
          Model Settings
        </span>
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={`transition-transform duration-200 ${open ? 'rotate-90' : ''} ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="grid grid-cols-3 gap-3 px-3 pb-3">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * VerdictResponsesEditor — the clinical-determinism knob. For each possible
 * verdict outcome of an expert, lets the developer wire a deterministic,
 * literature-informed response that replaces/augments the generated reply.
 */
function VerdictResponsesEditor({
  expert,
  onUpdate,
  isDark,
}: {
  expert: ExpertDefinition
  onUpdate: (updates: Partial<ExpertDefinition>) => void
  isDark: boolean
}) {
  const [newVerdict, setNewVerdict] = useState('')

  // Show every known outcome plus any verdict that already has a directive or default.
  const verdicts = Array.from(
    new Set([
      ...expert.verdictVocabulary,
      ...Object.keys(expert.verdictDirectives),
      ...Object.keys(expert.defaultVerdictDirectives),
    ]),
  )

  const defaultFor = (verdict: string): VerdictDirective =>
    expert.defaultVerdictDirectives[verdict] ?? INFORM
  const effectiveFor = (verdict: string): VerdictDirective =>
    expert.verdictDirectives[verdict] ?? INFORM
  const isModified = (verdict: string): boolean => {
    const eff = effectiveFor(verdict)
    const def = defaultFor(verdict)
    return (
      eff.action !== def.action ||
      eff.template !== def.template ||
      (eff.description ?? '') !== (def.description ?? '')
    )
  }

  // Persist the FULL effective map (runtime replaces, not merges). When the result
  // matches the shipped defaults exactly, clear the override so the config stays clean.
  const persist = (next: Record<string, VerdictDirective>) => {
    if (verdictDirectivesEqual(next, expert.defaultVerdictDirectives)) {
      onUpdate({ verdictDirectives: undefined })
    } else {
      onUpdate({ verdictDirectives: next })
    }
  }

  const setDirective = (verdict: string, patch: Partial<VerdictDirective>) => {
    const next: Record<string, VerdictDirective> = { ...expert.verdictDirectives }
    // The verdict label stays in the list even when "inform" — the labels ARE the
    // vocabulary fed to the LLM, so we keep every declared verdict, not just the
    // ones with a deterministic response.
    next[verdict] = { ...effectiveFor(verdict), ...patch }
    persist(next)
  }

  const renameVerdict = (oldLabel: string, rawNew: string) => {
    const newLabel = rawNew.trim()
    if (!newLabel || newLabel === oldLabel) return
    if (verdicts.includes(newLabel)) return // collision — ignore
    const next: Record<string, VerdictDirective> = {}
    for (const [k, v] of Object.entries(expert.verdictDirectives)) {
      next[k === oldLabel ? newLabel : k] = v
    }
    // A default row that was never materialized still needs to carry over on rename.
    if (!(oldLabel in expert.verdictDirectives)) next[newLabel] = effectiveFor(oldLabel)
    persist(next)
  }

  const removeVerdict = (verdict: string) => {
    const next: Record<string, VerdictDirective> = { ...expert.verdictDirectives }
    delete next[verdict]
    persist(next)
  }

  const resetVerdict = (verdict: string) => {
    const next: Record<string, VerdictDirective> = { ...expert.verdictDirectives }
    const def = expert.defaultVerdictDirectives[verdict]
    if (def) next[verdict] = def
    else delete next[verdict]
    persist(next)
  }

  const hasOverride = !verdictDirectivesEqual(expert.verdictDirectives, expert.defaultVerdictDirectives)

  const addVerdict = () => {
    const key = newVerdict.trim()
    if (!key || verdicts.includes(key)) return
    setDirective(key, { action: 'inform', template: '' })
    setNewVerdict('')
  }

  const labelClass = `text-xs font-medium mb-1.5 block ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`
  const inputClass = `w-full px-3 py-2 rounded-lg text-[13px] font-light focus:outline-none transition-all ${
    isDark
      ? 'bg-zinc-800/80 border border-zinc-600/80 text-zinc-100 focus:border-zinc-400'
      : 'bg-white border border-neutral-200 text-neutral-900 focus:border-neutral-400'
  }`

  const resetLinkClass = `text-[11px] font-medium transition-colors ${
    isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-neutral-500 hover:text-neutral-700'
  }`

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className={labelClass} style={{ marginBottom: 0 }}>Verdict Responses</label>
        {hasOverride && (
          <button type="button" onClick={() => onUpdate({ verdictDirectives: undefined })} className={resetLinkClass}>
            Reset all to default
          </button>
        )}
      </div>
      <p className={`text-[11px] mb-2.5 ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}>
        Deterministic, literature-informed responses per verdict. Non-"inform" actions replace or
        prepend to the generated reply, bypassing the model for safety-critical output.
      </p>

      {verdicts.length === 0 && (
        <p className={`text-[11px] italic mb-2 ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}>
          No verdict outcomes defined. Add one below or set an output schema for this expert.
        </p>
      )}

      <div className="space-y-2.5">
        {verdicts.map((verdict) => {
          const directive = effectiveFor(verdict)
          const def = defaultFor(verdict)
          const modified = isModified(verdict)
          // A label that comes from the expert's classifier vocabulary or shipped
          // defaults can't be removed (it lives in static config, not in the
          // editable override map), so a "rename" would leave the old row behind as
          // a duplicate. Only user-added verdicts are truly renamable.
          const isIntrinsic =
            expert.verdictVocabulary.includes(verdict) || verdict in expert.defaultVerdictDirectives
          return (
            <div
              key={verdict}
              className={`rounded-lg border p-2.5 ${
                isDark ? 'bg-zinc-800/40 border-zinc-700/50' : 'bg-neutral-50/60 border-neutral-200/50'
              }`}
            >
              <div className="flex items-center gap-2">
                {/* Verdict label (the vocabulary fed to the LLM). Editable only for
                    user-added verdicts; intrinsic ones are read-only (see isIntrinsic). */}
                <input
                  key={verdict}
                  defaultValue={verdict}
                  readOnly={isIntrinsic}
                  onBlur={isIntrinsic ? undefined : (e) => renameVerdict(verdict, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                  title={
                    isIntrinsic
                      ? 'Built-in verdict label — fixed by the expert’s classifier and cannot be renamed'
                      : 'Verdict label — rename to change what the LLM classifies into'
                  }
                  className={`text-[11px] font-mono font-medium px-2 py-1 rounded w-28 focus:outline-none ${
                    isIntrinsic ? 'cursor-default opacity-80' : ''
                  } ${
                    isDark
                      ? 'bg-zinc-700/60 text-zinc-200 border border-transparent focus:border-zinc-500'
                      : 'bg-neutral-200/70 text-neutral-700 border border-transparent focus:border-neutral-400'
                  }`}
                />
                <select
                  value={directive.action}
                  onChange={(e) => setDirective(verdict, { action: e.target.value as VerdictAction })}
                  className={`${inputClass} flex-1`}
                  style={{ paddingTop: 6, paddingBottom: 6 }}
                >
                  {VERDICT_ACTION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                {modified && (
                  <button type="button" onClick={() => resetVerdict(verdict)} className={resetLinkClass} title="Reset this verdict to default">
                    Reset
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => removeVerdict(verdict)}
                  title="Remove verdict"
                  className={`p-1 rounded transition-colors ${
                    isDark ? 'text-zinc-600 hover:text-red-400 hover:bg-zinc-700/50' : 'text-neutral-300 hover:text-red-500 hover:bg-neutral-100'
                  }`}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Explanation handed to the LLM (label + this text tell it what the verdict means) */}
              <input
                type="text"
                value={directive.description ?? ''}
                onChange={(e) => setDirective(verdict, { description: e.target.value })}
                placeholder="Explain to the LLM what this verdict means…"
                title="Shown to the classifying LLM alongside the label"
                className={`${inputClass} mt-2`}
                style={{ paddingTop: 6, paddingBottom: 6, fontSize: '12px' }}
              />

              {directive.action !== 'inform' && (
                <div className="mt-2">
                  <PromptComposer
                    blocks={[
                      {
                        id: `verdict_${verdict}`,
                        type: 'editable',
                        label: 'Response Template',
                        // value === defaultValue → show the default dimmed (no override);
                        // typing creates an override, onReset reverts to the default template.
                        value: directive.template === def.template ? undefined : directive.template,
                        defaultValue: def.template || undefined,
                        onChange: (v) => setDirective(verdict, { template: v }),
                        onReset: () => setDirective(verdict, { template: def.template }),
                        rows: 4,
                        placeholder: 'Literature-informed response spoken to the user (supports {{variables}})…',
                      },
                    ]}
                    isDark={isDark}
                    compact
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Add a verdict outcome (useful for custom experts without an output schema) */}
      <div className="flex items-center gap-2 mt-2.5">
        <input
          type="text"
          value={newVerdict}
          onChange={(e) => setNewVerdict(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addVerdict()
            }
          }}
          placeholder="Add a verdict outcome…"
          className={`${inputClass} flex-1`}
          style={{ paddingTop: 6, paddingBottom: 6 }}
        />
        <button
          type="button"
          onClick={addVerdict}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            isDark ? 'bg-zinc-700 text-zinc-200 hover:bg-zinc-600' : 'bg-neutral-200 text-neutral-700 hover:bg-neutral-300'
          }`}
        >
          Add
        </button>
      </div>
    </div>
  )
}

function ExpertCardInner({
  expert,
  index,
  isExpanded,
  onToggleExpand,
  onUpdate,
  onRemove,
  isDark,
}: ExpertCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: expert.name,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  const inputClass = `w-full px-3 py-2 rounded-lg text-[13px] font-light focus:outline-none transition-all ${
    isDark
      ? 'bg-zinc-800/80 border border-zinc-600/80 text-zinc-100 focus:border-zinc-400'
      : 'bg-white border border-neutral-200 text-neutral-900 focus:border-neutral-400'
  }`

  const labelClass = `text-xs font-medium mb-1.5 block ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`

  return (
    <div ref={setNodeRef} style={style}>
      <div
        className={`rounded-xl border transition-all ${
          expert.isCustom
            ? isDark
              ? 'border-violet-500/30 bg-violet-500/5'
              : 'border-violet-200 bg-violet-50/30'
            : isDark
              ? 'border-zinc-700/60 bg-zinc-800/40'
              : 'border-neutral-200/60 bg-white'
        }`}
      >
        {/* Header row */}
        <div className="flex items-center gap-2.5 px-4 py-3">
          {/* Drag handle */}
          <button
            {...attributes}
            {...listeners}
            style={{ touchAction: 'none' }}
            className={`cursor-grab active:cursor-grabbing p-1 rounded-md transition-colors ${
              isDark ? 'text-zinc-600 hover:text-zinc-400 hover:bg-zinc-700/50' : 'text-neutral-300 hover:text-neutral-500 hover:bg-neutral-100'
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" />
              <circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" />
              <circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" />
            </svg>
          </button>

          {/* Priority badge */}
          <span className={`text-[10px] font-mono font-medium w-5 h-5 flex items-center justify-center rounded ${
            isDark ? 'text-zinc-500 bg-zinc-800' : 'text-neutral-400 bg-neutral-100'
          }`}>
            {index + 1}
          </span>

          {/* Name + description */}
          <button onClick={onToggleExpand} className="flex-1 min-w-0 text-left">
            <div className="flex items-center gap-2">
              <span
                className={`text-[13px] font-medium ${
                  expert.isCustom
                    ? isDark
                      ? 'text-violet-300'
                      : 'text-violet-700'
                    : isDark
                      ? 'text-zinc-100'
                      : 'text-neutral-800'
                }`}
              >
                {expert.name}
              </span>
              {expert.isCustom && (
                <span
                  className={`text-[9px] font-medium px-1.5 py-0.5 rounded-md ${
                    isDark ? 'bg-violet-500/20 text-violet-400' : 'bg-violet-100 text-violet-600'
                  }`}
                >
                  custom
                </span>
              )}
              {expert.alwaysTriggered && (
                <span
                  className={`text-[9px] font-medium px-1.5 py-0.5 rounded-md ${
                    isDark ? 'bg-sky-500/20 text-sky-400' : 'bg-sky-100 text-sky-600'
                  }`}
                >
                  always
                </span>
              )}
            </div>
            <p className={`text-[11px] font-light truncate mt-0.5 ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
              {expert.description}
            </p>
          </button>

          {/* Remove (custom only) or Disable (built-in) */}
          {expert.isCustom && onRemove ? (
            <button
              onClick={onRemove}
              className={`p-1.5 rounded-lg transition-colors ${
                isDark ? 'text-zinc-600 hover:text-red-400 hover:bg-zinc-700/50' : 'text-neutral-300 hover:text-red-500 hover:bg-neutral-100'
              }`}
              title="Remove custom expert"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          ) : (
            <button
              onClick={() => onUpdate({ enabled: false })}
              className={`p-1.5 rounded-lg transition-colors ${
                isDark ? 'text-zinc-600 hover:text-red-400 hover:bg-zinc-700/50' : 'text-neutral-300 hover:text-red-500 hover:bg-neutral-100'
              }`}
              title="Disable expert"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="m4.93 4.93 14.14 14.14" />
              </svg>
            </button>
          )}

          {/* Expand arrow */}
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            className={`transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''} ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </div>

        {/* Expanded settings */}
        <AnimatePresence>
          {isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div
                className={`px-4 pb-5 pt-4 space-y-5 border-t ${
                  isDark ? 'border-zinc-700/50' : 'border-neutral-100'
                }`}
              >
                {/* Always triggered toggle */}
                <div className={`flex items-center justify-between px-3.5 py-3 rounded-lg ${
                  isDark ? 'bg-zinc-800/80' : 'bg-neutral-50'
                }`}>
                  <label className={`text-xs font-medium ${isDark ? 'text-zinc-300' : 'text-neutral-600'}`}>
                    Always Triggered
                  </label>
                  <button
                    onClick={() => onUpdate({ alwaysTriggered: !expert.alwaysTriggered })}
                    className={`relative w-10 h-[22px] rounded-full transition-colors ${
                      expert.alwaysTriggered
                        ? 'bg-sky-500'
                        : isDark
                          ? 'bg-zinc-600'
                          : 'bg-neutral-300'
                    }`}
                  >
                    <span
                      className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform shadow-sm ${
                        expert.alwaysTriggered ? 'translate-x-[18px]' : ''
                      }`}
                    />
                  </button>
                </div>

                {/* Trigger criteria (hidden when alwaysTriggered) */}
                {!expert.alwaysTriggered && (
                  <div>
                    <label className={labelClass}>Trigger Criteria</label>
                    <textarea
                      value={expert.triggerCriteria}
                      onChange={(e) => onUpdate({ triggerCriteria: e.target.value })}
                      placeholder="When should the input gate select this expert?"
                      rows={3}
                      className={`${inputClass} resize-y`}
                      style={{ fontSize: '12px', lineHeight: '1.6' }}
                    />
                    <p className={`text-[11px] mt-1.5 ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}>
                      Used by Input Gate to decide when to activate this expert
                    </p>
                  </div>
                )}

                {/* Model / Temp / MaxTokens — collapsible config grid */}
                <CollapsibleSettings isDark={isDark}>
                  <div>
                    <label className={labelClass}>Model</label>
                    <select
                      value={expert.model}
                      onChange={(e) => onUpdate({ model: e.target.value })}
                      className={inputClass}
                    >
                      {MODEL_OPTIONS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>Temperature</label>
                    <input
                      type="number"
                      value={expert.temperature}
                      onChange={(e) => onUpdate({ temperature: parseFloat(e.target.value) || 0 })}
                      min={0}
                      max={1}
                      step={0.1}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Max Tokens</label>
                    <input
                      type="number"
                      value={expert.maxTokens}
                      onChange={(e) => onUpdate({ maxTokens: parseInt(e.target.value) || 200 })}
                      min={10}
                      max={2000}
                      className={inputClass}
                    />
                  </div>
                </CollapsibleSettings>

                {/* Prompt assembly view */}
                <PromptComposer
                  blocks={buildExpertBlocks(expert, onUpdate)}
                  isDark={isDark}
                  compact
                />

                {/* Deterministic verdict → response mapping */}
                <VerdictResponsesEditor expert={expert} onUpdate={onUpdate} isDark={isDark} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

export const ExpertCard = memo(ExpertCardInner)
export default ExpertCard
