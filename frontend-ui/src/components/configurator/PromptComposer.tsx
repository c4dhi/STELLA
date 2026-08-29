/**
 * PromptComposer — IDE-like unified prompt editor with {{placeholder}} highlighting.
 *
 * For experts: renders a SINGLE code-editor-style textarea containing the entire
 * prompt template. An attached output format footer shows the enforced JSON schema.
 * Variables are accessible via a hover-triggered popover behind an info icon.
 *
 * For pipeline stages (NodeDetailOverlay): still supports injection/context/output_format
 * block types for non-placeholder-based stages.
 */

import { memo, useState, useRef, useCallback, useEffect, useMemo, useContext, createContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import type { ExpertDefinition } from './useConfiguratorState'
import type { RuntimeVariable } from '../../lib/api-types'
import { useConfiguratorStore } from '../../store/configuratorStore'

// ---------------------------------------------------------------------------
// Placeholder registry — colors and descriptions for each variable
// ---------------------------------------------------------------------------

export interface PlaceholderDef {
  name: string
  label: string
  description: string
  /** Example of what this variable resolves to at runtime */
  preview: string
  insertToken: string
  pattern: string | RegExp
  dark: { text: string; bg: string; chip: string }
  light: { text: string; bg: string; chip: string }
}

export const PLACEHOLDER_REGISTRY: PlaceholderDef[] = [
  {
    name: 'plan',
    label: 'plan',
    description: 'Full plan: all states, tasks, deliverables',
    preview: 'States:\n  - welcome_intro (active)\n  - assessment\n  - wrap_up\nTasks:\n  - greeting (completed)\n  - collect_basic_info (active)\nDeliverables:\n  - user_name (required)\n  - age (optional)',
    insertToken: '{{plan}}',
    pattern: '{{plan}}',
    dark: { text: 'text-amber-300', bg: 'bg-amber-500/20', chip: 'bg-amber-500/15 text-amber-400 border-amber-500/25' },
    light: { text: 'text-amber-700', bg: 'bg-amber-100/80', chip: 'bg-amber-50 text-amber-700 border-amber-200' },
  },
  {
    name: 'current_focus',
    label: 'current_focus',
    description: 'Active task + pending deliverables with criteria',
    preview: 'Task: collect_basic_info\nPending:\n  - user_name (required): "User\'s first name"\n  - preferred_time (optional): "Best time for sessions"',
    insertToken: '{{current_focus}}',
    pattern: '{{current_focus}}',
    dark: { text: 'text-orange-300', bg: 'bg-orange-500/20', chip: 'bg-orange-500/15 text-orange-400 border-orange-500/25' },
    light: { text: 'text-orange-700', bg: 'bg-orange-100/80', chip: 'bg-orange-50 text-orange-700 border-orange-200' },
  },
  {
    name: 'pending_deliverables',
    label: 'pending_deliverables',
    description: 'Pending deliverables with required/optional flags',
    preview: '- user_name: User\'s first name [required]\n- preferred_time: Best time for sessions [optional]\n- fitness_goal: Primary fitness objective [required]',
    insertToken: '{{pending_deliverables}}',
    pattern: '{{pending_deliverables}}',
    dark: { text: 'text-sky-300', bg: 'bg-sky-500/20', chip: 'bg-sky-500/15 text-sky-400 border-sky-500/25' },
    light: { text: 'text-sky-700', bg: 'bg-sky-100/80', chip: 'bg-sky-50 text-sky-700 border-sky-200' },
  },
  {
    name: 'collected_deliverables',
    label: 'collected_deliverables',
    description: 'Already collected deliverable keys',
    preview: '- age: 28\n- exercise_type: running\n- frequency: 3x per week',
    insertToken: '{{collected_deliverables}}',
    pattern: '{{collected_deliverables}}',
    dark: { text: 'text-emerald-300', bg: 'bg-emerald-500/20', chip: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25' },
    light: { text: 'text-emerald-700', bg: 'bg-emerald-100/80', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  },
  {
    name: 'turns_without_progress',
    label: 'turns_without_progress',
    description: 'Turns since last deliverable collected',
    preview: '3',
    insertToken: '{{turns_without_progress}}',
    pattern: '{{turns_without_progress}}',
    dark: { text: 'text-rose-300', bg: 'bg-rose-500/20', chip: 'bg-rose-500/15 text-rose-400 border-rose-500/25' },
    light: { text: 'text-rose-700', bg: 'bg-rose-100/80', chip: 'bg-rose-50 text-rose-700 border-rose-200' },
  },
  {
    name: 'current_state',
    label: 'current_state',
    description: 'Current state name + description',
    preview: 'welcome_intro: Greet the user and collect basic information about their fitness goals',
    insertToken: '{{current_state}}',
    pattern: '{{current_state}}',
    dark: { text: 'text-violet-300', bg: 'bg-violet-500/20', chip: 'bg-violet-500/15 text-violet-400 border-violet-500/25' },
    light: { text: 'text-violet-700', bg: 'bg-violet-100/80', chip: 'bg-violet-50 text-violet-700 border-violet-200' },
  },
  {
    name: 'progress_percentage',
    label: 'progress_percentage',
    description: 'Overall progress %',
    preview: '42%',
    insertToken: '{{progress_percentage}}',
    pattern: '{{progress_percentage}}',
    dark: { text: 'text-blue-300', bg: 'bg-blue-500/20', chip: 'bg-blue-500/15 text-blue-400 border-blue-500/25' },
    light: { text: 'text-blue-700', bg: 'bg-blue-100/80', chip: 'bg-blue-50 text-blue-700 border-blue-200' },
  },
  {
    name: 'processing_mode',
    label: 'processing_mode',
    description: 'Processing mode (sequential/flexible/goal)',
    preview: 'goal',
    insertToken: '{{processing_mode}}',
    pattern: '{{processing_mode}}',
    dark: { text: 'text-zinc-300', bg: 'bg-zinc-600/30', chip: 'bg-zinc-700 text-zinc-400 border-zinc-600' },
    light: { text: 'text-neutral-600', bg: 'bg-neutral-200/80', chip: 'bg-neutral-100 text-neutral-600 border-neutral-200' },
  },
  {
    name: 'trigger_rules',
    label: 'trigger_rules',
    description: 'Auto-generated routing rules from expert trigger criteria',
    preview: 'RULES:\n1. Include "noise_detection" if the message seems garbled\n2. Include "medical" if health topics are mentioned\n3. Include "probing" if clarification might be needed\n4. Select multiple experts if needed — they run in parallel.',
    insertToken: '{{trigger_rules}}',
    pattern: '{{trigger_rules}}',
    dark: { text: 'text-cyan-300', bg: 'bg-cyan-500/20', chip: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/25' },
    light: { text: 'text-cyan-700', bg: 'bg-cyan-100/80', chip: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
  },
  {
    name: 'plan_persona',
    label: 'plan_persona',
    description: 'Persona instructions from the uploaded plan',
    preview: 'You are STELLA, a warm and engaging AI fitness coach.\nYou guide users through personalized workout planning\nwith a friendly, professional tone.',
    insertToken: '{{plan_persona}}',
    pattern: '{{plan_persona}}',
    dark: { text: 'text-amber-300', bg: 'bg-amber-500/20', chip: 'bg-amber-500/15 text-amber-400 border-amber-500/25' },
    light: { text: 'text-amber-700', bg: 'bg-amber-100/80', chip: 'bg-amber-50 text-amber-700 border-amber-200' },
  },
  {
    name: 'arbitration_directive',
    label: 'arbitration_directive',
    description: 'Tone, must_avoid, deliverable signals from expert arbitration',
    preview: 'GUIDANCE:\nTone: curious\nThe user just provided: exercise_type.\nAcknowledge this naturally before moving on.\nYour response should ask about: preferred_time',
    insertToken: '{{arbitration_directive}}',
    pattern: '{{arbitration_directive}}',
    dark: { text: 'text-fuchsia-300', bg: 'bg-fuchsia-500/20', chip: 'bg-fuchsia-500/15 text-fuchsia-400 border-fuchsia-500/25' },
    light: { text: 'text-fuchsia-700', bg: 'bg-fuchsia-100/80', chip: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200' },
  },
  {
    name: 'history',
    label: 'history_N',
    description: 'Last N conversation messages (e.g. {{history_8}})',
    preview: '[user]: Hi, I\'m looking for a workout plan\n[assistant]: Welcome! I\'d love to help you.\n[user]: I usually go running three times a week\n[assistant]: That\'s great! Running is excellent.',
    insertToken: '{{history_8}}',
    pattern: /\{\{history_\d+\}\}/,
    dark: { text: 'text-teal-300', bg: 'bg-teal-500/20', chip: 'bg-teal-500/15 text-teal-400 border-teal-500/25' },
    light: { text: 'text-teal-700', bg: 'bg-teal-100/80', chip: 'bg-teal-50 text-teal-700 border-teal-200' },
  },
  {
    name: 'user_message',
    label: 'user_message',
    description: "The user's latest message",
    preview: 'I usually go running about three times a week, mostly in the morning.',
    insertToken: '{{user_message}}',
    pattern: '{{user_message}}',
    dark: { text: 'text-indigo-300', bg: 'bg-indigo-500/20', chip: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/25' },
    light: { text: 'text-indigo-700', bg: 'bg-indigo-100/80', chip: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  },
  {
    name: 'language',
    label: 'language',
    description: 'Resolved conversation language for this turn (auto-detected)',
    preview: 'German',
    insertToken: '{{language}}',
    pattern: '{{language}}',
    dark: { text: 'text-lime-300', bg: 'bg-lime-500/20', chip: 'bg-lime-500/15 text-lime-400 border-lime-500/25' },
    light: { text: 'text-lime-700', bg: 'bg-lime-100/80', chip: 'bg-lime-50 text-lime-700 border-lime-200' },
  },
]

const PLACEHOLDER_MAP = new Map(
  PLACEHOLDER_REGISTRY.filter((p) => typeof p.pattern === 'string').map((p) => [p.name, p])
)

// Accepts one dotted segment so namespaced tokens ({{persona.name}}) are
// recognised here too — the plain \w+ form silently left them unstyled.
const PLACEHOLDER_RE = /(\{\{\w+(?:\.\w+)?\}\})/g

// Deterministic color cycle for manifest-declared variables that aren't one of the
// built-ins above (so a new agent type's custom variables still get distinct chips).
const COLOR_CYCLE: Array<{ dark: PlaceholderDef['dark']; light: PlaceholderDef['light'] }> =
  PLACEHOLDER_REGISTRY.map((p) => ({ dark: p.dark, light: p.light }))

/**
 * Build the effective palette for a given agent type's manifest-declared
 * runtimeVariables. Reuses the built-in def (colors/preview/description) when the
 * name matches, otherwise synthesizes a def with cycled colors. Falls back to the
 * full hardcoded registry when an agent declares no runtimeVariables (legacy).
 */
function buildPalette(runtimeVariables?: RuntimeVariable[] | null): PlaceholderDef[] {
  if (!runtimeVariables || runtimeVariables.length === 0) return PLACEHOLDER_REGISTRY

  return runtimeVariables.map((rv, i) => {
    const existing = PLACEHOLDER_REGISTRY.find((p) => p.name === rv.name)
    const colors = COLOR_CYCLE[i % COLOR_CYCLE.length]
    const label = rv.label || rv.name
    return {
      name: rv.name,
      label,
      description: rv.description ?? existing?.description ?? '',
      preview: rv.preview ?? existing?.preview ?? '',
      insertToken: rv.parametric ? `{{${rv.name}_8}}` : `{{${rv.name}}}`,
      pattern: rv.parametric
        ? new RegExp(`\\{\\{${rv.name}_\\d+\\}\\}`)
        : `{{${rv.name}}}`,
      dark: existing?.dark ?? colors.dark,
      light: existing?.light ?? colors.light,
    }
  })
}

interface Palette {
  defs: PlaceholderDef[]
  map: Map<string, PlaceholderDef>
}

// Defaults to the hardcoded registry so any PromptComposer rendered outside a
// configured agent context still works exactly as before.
const PaletteContext = createContext<Palette>({ defs: PLACEHOLDER_REGISTRY, map: PLACEHOLDER_MAP })

// ---------------------------------------------------------------------------
// Output format registry (per expert name)
// ---------------------------------------------------------------------------

export const EXPERT_OUTPUT_FORMATS: Record<string, string> = {
  task_extraction: 'Tools: set_deliverable(key, value, reasoning), complete_task(task_id, reasoning)',
  probing: '{"deliverable_signals":[...],"verdict":"no_probe|needs_clarification|gentle_redirect","confidence":0.0}',
  timekeeper: '{"verdict":"on_track|slowing|stuck|force_advance","confidence":0.0,"recommendation":"..."}',
  noise_detection: '{"verdict":"clear|unclear|partial","confidence":0.0,"recommendation":"short"}',
  medical: '{"verdict":"none|low|high|critical","confidence":0.0,"recommendation":"short"}',
  legal: '{"verdict":"none|low|high|critical","confidence":0.0,"recommendation":"short"}',
  _custom: '{"verdict":"...","confidence":0.0,"recommendation":"short"}',
  input_gate: '{"experts": ["name1", "name2"]}',
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptBlock {
  id: string
  type: 'editable' | 'injection' | 'output_format' | 'context'
  label: string
  // editable
  value?: string
  defaultValue?: string
  onChange?: (value: string) => void
  onReset?: () => void
  rows?: number
  placeholder?: string
  helperText?: string
  /** Header hint rendered above the editor (like outputFormat footer, but on top) */
  headerHint?: string
  /** Label for the header hint box. Defaults to "Note". Set e.g. "Bridge Phrase Injection"
   *  only where that is actually true (the stella-v2 response generator). */
  headerHintLabel?: string
  /** Expert name — used to look up the enforced output format */
  expertName?: string
  /** Direct output format override (takes precedence over expertName lookup) */
  outputFormat?: string
  // injection
  description?: string
  tag?: string
  tagVariant?: 'amber' | 'sky' | 'zinc'
  // output_format
  formatExample?: string
  // context
  contextType?: 'history' | 'user_message'
  messageCount?: number
}

interface PromptComposerProps {
  blocks: PromptBlock[]
  isDark: boolean
  compact?: boolean
}

// ---------------------------------------------------------------------------
// Helper — build ONE editable block for an expert (single unified editor)
// ---------------------------------------------------------------------------

export function buildExpertBlocks(
  expert: ExpertDefinition,
  onUpdate: (updates: Partial<ExpertDefinition>) => void,
): PromptBlock[] {
  return [
    {
      // Namespace per expert: variable insertion locates the target textarea via
      // querySelector('[data-prompt-id="..."]'), so a shared id collides when two
      // expert editors are open at once (e.g. task-extraction + a pool expert) and
      // the inserted {{variable}} lands in the wrong textarea.
      id: `prompt_template_${expert.name}`,
      type: 'editable',
      label: 'Prompt Template',
      // Pass the raw override through: `undefined` = inherit default, `''` = explicit
      // empty (#174). Do not collapse '' to undefined or the default snaps back.
      value: expert.systemPrompt,
      defaultValue: expert.defaultSystemPrompt || undefined,
      onChange: (v) => onUpdate({ systemPrompt: v }),
      onReset: () => onUpdate({ systemPrompt: undefined }),
      rows: 18,
      // No enforced-output-format footer: the output is a generic interface and the
      // verdict labels are configured in the Verdict Responses editor below.
    },
  ]
}

// ---------------------------------------------------------------------------
// Highlighted text renderer
// ---------------------------------------------------------------------------

function getPlaceholderDef(
  token: string,
  defs: PlaceholderDef[],
  map: Map<string, PlaceholderDef>,
): PlaceholderDef | undefined {
  const match = token.match(/^\{\{(\w+)\}\}$/)
  if (!match) return undefined
  const name = match[1]
  const simple = map.get(name)
  if (simple) return simple
  // Parametric tokens (e.g. {{history_8}}) match a def whose pattern is a RegExp.
  return defs.find((p) => p.pattern instanceof RegExp && p.pattern.test(token))
}

function renderHighlightedText(
  text: string,
  isDark: boolean,
  defs: PlaceholderDef[],
  map: Map<string, PlaceholderDef>,
  dimmed?: boolean,
): ReactNode[] {
  if (!text) return [<span key="empty">{'\n'}</span>]

  const parts = text.split(PLACEHOLDER_RE)
  return parts.map((part, i) => {
    if (/^\{\{\w+(?:\.\w+)?\}\}$/.test(part)) {
      const def = getPlaceholderDef(part, defs, map)
      if (def) {
        const colors = isDark ? def.dark : def.light
        return (
          <span key={i} className={`${colors.bg} ${colors.text} rounded px-0.5 font-medium`}>
            {part}
          </span>
        )
      }
      return (
        <span key={i} className={`rounded px-0.5 ${isDark ? 'bg-zinc-700/50 text-zinc-400' : 'bg-neutral-200/50 text-neutral-500'}`}>
          {part}
        </span>
      )
    }
    const textClass = dimmed
      ? isDark ? 'text-zinc-500' : 'text-neutral-400'
      : isDark ? 'text-zinc-300' : 'text-neutral-700'
    return <span key={i} className={textClass}>{part || '\u200b'}</span>
  })
}

// ---------------------------------------------------------------------------
// Placeholder popover — appears on hover over the info icon
// ---------------------------------------------------------------------------

function isPlaceholderUsed(text: string, ph: PlaceholderDef): boolean {
  if (typeof ph.pattern === 'string') return text.includes(ph.pattern)
  return ph.pattern.test(text)
}

function VariablesPopover({
  isDark,
  onInsert,
  promptText,
  anchorRef,
}: {
  isDark: boolean
  onInsert: (token: string) => void
  promptText: string
  anchorRef: React.RefObject<HTMLButtonElement | null>
}) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const { defs } = useContext(PaletteContext)

  useEffect(() => {
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect()
      setPosition({ top: rect.bottom + 6, left: rect.left })
    }
  }, [anchorRef])

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        anchorRef.current && !anchorRef.current.contains(e.target as Node)
      ) {
        // Will be handled by the parent's onMouseLeave
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [anchorRef])

  if (!position) return null

  return (
    <div
      ref={popoverRef}
      style={{ position: 'fixed', top: position.top, left: Math.min(position.left, window.innerWidth - 340), zIndex: 200 }}
      className={`w-[320px] rounded-xl border shadow-xl p-3 ${
        isDark
          ? 'bg-zinc-900 border-zinc-700 shadow-black/40'
          : 'bg-white border-neutral-200 shadow-black/8'
      }`}
    >
      <div className="flex items-center gap-2 mb-2.5">
        <span className={`text-[10px] font-semibold tracking-wide uppercase ${
          isDark ? 'text-zinc-400' : 'text-neutral-500'
        }`}>
          Available Variables
        </span>
        <span className={`text-[9px] font-light ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}>
          Click to insert at cursor
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {defs.map((ph) => {
          const colors = isDark ? ph.dark : ph.light
          const isUsed = isPlaceholderUsed(promptText, ph)
          return (
            <button
              key={ph.name}
              onClick={() => onInsert(ph.insertToken)}
              title={ph.description}
              className={`text-[10px] font-mono font-medium px-1.5 py-0.5 rounded-md border transition-all ${colors.chip} ${
                isUsed ? 'opacity-100' : 'opacity-40 hover:opacity-75'
              }`}
            >
              {`{{${ph.label}}}`}
            </button>
          )
        })}
      </div>
      <div className={`mt-2.5 pt-2 border-t space-y-1 ${isDark ? 'border-zinc-800' : 'border-neutral-100'}`}>
        {defs.map((ph) => {
          const colors = isDark ? ph.dark : ph.light
          const isUsed = isPlaceholderUsed(promptText, ph)
          return (
            <div key={ph.name} className={`flex items-baseline gap-2 ${isUsed ? 'opacity-100' : 'opacity-40'}`}>
              <span className={`text-[10px] font-mono font-medium shrink-0 ${colors.text}`}>
                {`{{${ph.label}}}`}
              </span>
              <span className={`text-[10px] font-light ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                {ph.description}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Placeholder hover tooltip
// ---------------------------------------------------------------------------

function PlaceholderTooltip({
  def,
  isDark,
  position,
}: {
  def: PlaceholderDef
  isDark: boolean
  position: { x: number; y: number }
}) {
  const colors = isDark ? def.dark : def.light

  // Clamp to viewport
  const left = Math.min(position.x, window.innerWidth - 320)
  const top = position.y + 16

  return (
    <div
      style={{ position: 'fixed', top, left, zIndex: 300 }}
      className={`w-[300px] rounded-lg border shadow-lg overflow-hidden ${
        isDark
          ? 'bg-zinc-900 border-zinc-700 shadow-black/50'
          : 'bg-white border-neutral-200 shadow-black/10'
      }`}
    >
      {/* Header: variable name + description */}
      <div className="px-3 py-2">
        <div className="flex items-center gap-2 mb-1">
          <span className={`text-[11px] font-mono font-semibold ${colors.text}`}>
            {def.insertToken}
          </span>
        </div>
        <p className={`text-[11px] font-light leading-relaxed ${
          isDark ? 'text-zinc-400' : 'text-neutral-500'
        }`}>
          {def.description}
        </p>
      </div>

      {/* Preview: example runtime value */}
      <div className={`px-3 py-2 border-t ${
        isDark ? 'bg-zinc-800/60 border-zinc-800' : 'bg-neutral-50 border-neutral-100'
      }`}>
        <span className={`text-[9px] font-semibold uppercase tracking-wide ${
          isDark ? 'text-zinc-600' : 'text-neutral-400'
        }`}>
          Example at runtime
        </span>
        <pre className={`mt-1 text-[10px] font-mono leading-relaxed whitespace-pre-wrap break-words ${
          isDark ? 'text-zinc-400' : 'text-neutral-500'
        }`}>
          {def.preview}
        </pre>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hover overlay — invisible layer on top of textarea for placeholder hover
// ---------------------------------------------------------------------------

function renderHoverTargets(
  text: string,
  onEnter: (def: PlaceholderDef, e: React.MouseEvent) => void,
  onLeave: () => void,
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  defs: PlaceholderDef[],
  map: Map<string, PlaceholderDef>,
): ReactNode[] {
  if (!text) return [<span key="empty">{'\n'}</span>]

  const parts = text.split(PLACEHOLDER_RE)
  return parts.map((part, i) => {
    if (/^\{\{\w+\}\}$/.test(part)) {
      const def = getPlaceholderDef(part, defs, map)
      if (def) {
        return (
          <span
            key={i}
            className="rounded px-0.5"
            style={{ pointerEvents: 'auto', opacity: 0, cursor: 'text' }}
            onMouseEnter={(e) => onEnter(def, e)}
            onMouseLeave={onLeave}
            onMouseDown={(e) => {
              // Let clicks pass through to the textarea
              e.preventDefault()
              textareaRef.current?.focus()
            }}
          >
            {part}
          </span>
        )
      }
      return <span key={i} className="rounded px-0.5" style={{ opacity: 0 }}>{part}</span>
    }
    return <span key={i} style={{ visibility: 'hidden' }}>{part || '\u200b'}</span>
  })
}

// ---------------------------------------------------------------------------
// Highlighted prompt editor
// ---------------------------------------------------------------------------

function HighlightedEditor({
  value,
  onChange,
  isDark,
  rows,
  dimmed,
  blockId,
  outputFormat,
  fillHeight,
  headerHint,
  headerHintLabel,
}: {
  value: string
  onChange?: (value: string) => void
  isDark: boolean
  rows?: number
  dimmed?: boolean
  blockId?: string
  outputFormat?: string
  /** When true, the editor expands to fill its container height */
  fillHeight?: boolean
  /** Header hint rendered above the editor */
  headerHint?: string
  /** Label for the header hint box (defaults to "Note") */
  headerHintLabel?: string
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const hoverLayerRef = useRef<HTMLDivElement>(null)
  const [hoveredPh, setHoveredPh] = useState<{ def: PlaceholderDef; x: number; y: number } | null>(null)
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const { defs, map } = useContext(PaletteContext)

  const syncScroll = useCallback(() => {
    if (textareaRef.current) {
      if (backdropRef.current) {
        backdropRef.current.scrollTop = textareaRef.current.scrollTop
        backdropRef.current.scrollLeft = textareaRef.current.scrollLeft
      }
      if (hoverLayerRef.current) {
        hoverLayerRef.current.scrollTop = textareaRef.current.scrollTop
        hoverLayerRef.current.scrollLeft = textareaRef.current.scrollLeft
      }
    }
  }, [])

  const handlePhEnter = useCallback((def: PlaceholderDef, e: React.MouseEvent) => {
    clearTimeout(hoverTimeoutRef.current)
    setHoveredPh({ def, x: e.clientX, y: e.clientY })
  }, [])

  const handlePhLeave = useCallback(() => {
    hoverTimeoutRef.current = setTimeout(() => setHoveredPh(null), 100)
  }, [])

  const displayText = value || ''
  const backdropText = displayText.endsWith('\n') ? displayText + ' ' : displayText

  return (
    <div className={`rounded-lg overflow-hidden ${fillHeight ? 'flex flex-col h-full' : ''}`}>
      {/* Header hint — attached above the editor */}
      {headerHint && (
        <div className={`flex items-start gap-2 px-3.5 py-2.5 border rounded-t-lg border-b-0 ${
          isDark
            ? 'bg-zinc-800/60 border-zinc-700/80'
            : 'bg-neutral-50/80 border-neutral-200'
        }`}>
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={`shrink-0 mt-0.5 ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}
          >
            <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
          <div className="flex-1 min-w-0">
            <span className={`text-[9px] font-semibold uppercase tracking-wide ${
              isDark ? 'text-zinc-500' : 'text-neutral-400'
            }`}>
              {headerHintLabel || 'Note'}
            </span>
            <p className={`mt-1 text-[10px] font-mono leading-relaxed ${
              isDark ? 'text-zinc-400' : 'text-neutral-500'
            }`}>
              {headerHint}
            </p>
          </div>
        </div>
      )}

      {/* Editor area */}
      <div className={`relative border border-b-0 transition-colors ${
        fillHeight ? 'flex-1 min-h-0 flex flex-col' : ''
      } ${
        headerHint ? '' : 'rounded-t-lg'
      } ${
        outputFormat ? '' : 'rounded-b-lg border-b'
      } ${
        isDark
          ? 'bg-zinc-900/80 border-zinc-700/80 focus-within:border-zinc-500'
          : 'bg-white border-neutral-200 focus-within:border-neutral-400'
      }`}>
        {/* Layer 1: Backdrop — visual highlighting */}
        <div
          ref={backdropRef}
          className="absolute inset-0 overflow-hidden pointer-events-none px-3.5 py-2.5"
          aria-hidden
        >
          <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.7] m-0">
            {renderHighlightedText(backdropText, isDark, defs, map, dimmed)}
          </pre>
        </div>

        {/* Layer 2: Textarea — text input */}
        <textarea
          ref={textareaRef}
          data-prompt-id={blockId}
          value={displayText}
          onChange={(e) => onChange?.(e.target.value)}
          onScroll={syncScroll}
          rows={fillHeight ? undefined : (rows ?? 18)}
          spellCheck={false}
          className={`relative z-10 w-full px-3.5 py-2.5 font-mono text-[12px] leading-[1.7] bg-transparent focus:outline-none ${
            fillHeight ? 'h-full resize-none' : 'resize-y'
          }`}
          style={{
            color: 'transparent',
            caretColor: isDark ? '#d4d4d8' : '#171717',
          }}
        />

        {/* Layer 3: Hover overlay — invisible, only placeholder spans are interactive */}
        <div
          ref={hoverLayerRef}
          className="absolute inset-0 z-20 overflow-hidden pointer-events-none px-3.5 py-2.5"
        >
          <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.7] m-0">
            {renderHoverTargets(backdropText, handlePhEnter, handlePhLeave, textareaRef, defs, map)}
          </pre>
        </div>
      </div>

      {/* Output format footer — attached to the editor */}
      {outputFormat && (
        <div className={`flex items-start gap-2 px-3.5 py-2.5 border rounded-b-lg ${
          isDark
            ? 'bg-zinc-800/60 border-zinc-700/80'
            : 'bg-neutral-50/80 border-neutral-200'
        }`}>
          {outputFormat.startsWith('Tools:') ? (
            <svg
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={`shrink-0 mt-0.5 ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}
            >
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
          ) : (
            <svg
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={`shrink-0 mt-0.5 ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}
            >
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          )}
          <div className="flex-1 min-w-0">
            <span className={`text-[9px] font-semibold uppercase tracking-wide ${
              isDark ? 'text-zinc-500' : 'text-neutral-400'
            }`}>
              {outputFormat.startsWith('Tools:') ? 'Tool Calling Mode' : 'Enforced Output Format'}
            </span>
            <code className={`block mt-1 text-[10px] font-mono leading-relaxed break-all ${
              isDark ? 'text-zinc-400' : 'text-neutral-500'
            }`}>
              {outputFormat}
            </code>
          </div>
        </div>
      )}

      {/* Placeholder hover tooltip */}
      {hoveredPh && (
        <PlaceholderTooltip def={hoveredPh.def} isDark={isDark} position={{ x: hoveredPh.x, y: hoveredPh.y }} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Fullscreen prompt modal
// ---------------------------------------------------------------------------

/**
 * Resolve how an editable block renders from its raw override `value` and the
 * built-in `defaultValue`. `undefined` value = no override → show the default
 * (dimmed). An explicit `''` counts as an override and renders empty, so clearing
 * the textarea does not snap the default back (#174).
 */
export function resolveBlockDisplay(
  value: string | undefined,
  defaultValue: string | undefined,
): { isOverridden: boolean; showDefault: boolean; displayValue: string } {
  const isOverridden = value !== undefined
  const showDefault = !isOverridden && !!defaultValue
  const displayValue = isOverridden ? value! : showDefault ? defaultValue! : ''
  return { isOverridden, showDefault, displayValue }
}

function FullscreenPromptModal({
  block,
  isDark,
  onClose,
}: {
  block: PromptBlock
  isDark: boolean
  onClose: () => void
}) {
  const { isOverridden, showDefault, displayValue } = resolveBlockDisplay(block.value, block.defaultValue)

  const [showPopover, setShowPopover] = useState(false)
  const infoButtonRef = useRef<HTMLButtonElement>(null)
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout>>()

  const outputFormat = block.outputFormat
    ?? (block.expertName
      ? EXPERT_OUTPUT_FORMATS[block.expertName] ?? EXPERT_OUTPUT_FORMATS._custom
      : undefined)

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const handleMouseEnterInfo = useCallback(() => {
    clearTimeout(hideTimeoutRef.current)
    setShowPopover(true)
  }, [])

  const handleMouseLeaveInfo = useCallback(() => {
    hideTimeoutRef.current = setTimeout(() => setShowPopover(false), 200)
  }, [])

  const handlePopoverEnter = useCallback(() => {
    clearTimeout(hideTimeoutRef.current)
  }, [])

  const handlePopoverLeave = useCallback(() => {
    hideTimeoutRef.current = setTimeout(() => setShowPopover(false), 150)
  }, [])

  const handleInsertPlaceholder = useCallback((token: string) => {
    if (!block.onChange) return
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-prompt-id="fullscreen-editor"]')
    if (textarea) {
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const newValue = displayValue.slice(0, start) + token + displayValue.slice(end)
      block.onChange(newValue)
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start + token.length
        textarea.focus()
      })
    } else {
      block.onChange(displayValue + token)
    }
  }, [block, displayValue])

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-[9999] flex items-center justify-center"
      >
        {/* Backdrop */}
        <div
          className={`absolute inset-0 ${isDark ? 'bg-black/70' : 'bg-black/40'} backdrop-blur-sm`}
          onClick={onClose}
        />

        {/* Modal */}
        <motion.div
          initial={{ scale: 0.97, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.97, opacity: 0 }}
          transition={{ duration: 0.15 }}
          className={`relative w-[90vw] max-w-[1100px] h-[85vh] rounded-2xl border shadow-2xl flex flex-col overflow-hidden ${
            isDark
              ? 'bg-zinc-900 border-zinc-700 shadow-black/50'
              : 'bg-white border-neutral-200 shadow-black/15'
          }`}
        >
          {/* Header */}
          <div className={`flex items-center justify-between px-5 py-3.5 border-b shrink-0 ${
            isDark ? 'border-zinc-800' : 'border-neutral-100'
          }`}>
            <div className="flex items-center gap-3">
              <span className={`text-[11px] font-semibold tracking-wide uppercase ${
                isDark ? 'text-zinc-400' : 'text-neutral-500'
              }`}>
                {block.label}
              </span>
              {showDefault && (
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                  isDark ? 'bg-zinc-800 text-zinc-500' : 'bg-neutral-100 text-neutral-400'
                }`}>
                  default
                </span>
              )}
              {/* Info icon */}
              <div
                className="relative"
                onMouseEnter={handleMouseEnterInfo}
                onMouseLeave={handleMouseLeaveInfo}
              >
                <button
                  ref={infoButtonRef}
                  type="button"
                  className={`p-1 rounded-md transition-colors ${
                    showPopover
                      ? isDark ? 'bg-zinc-700 text-zinc-300' : 'bg-neutral-200 text-neutral-600'
                      : isDark ? 'text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800' : 'text-neutral-400 hover:text-neutral-500 hover:bg-neutral-100'
                  }`}
                  title="Available variables"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 7V4h16v3" />
                    <path d="M9 20h6" />
                    <path d="M12 4v16" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {isOverridden && block.onReset && (
                <button
                  onClick={block.onReset}
                  className={`text-[11px] font-medium px-2.5 py-1 rounded-md transition-colors ${
                    isDark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700' : 'text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100'
                  }`}
                >
                  Reset to default
                </button>
              )}
              {/* Close button */}
              <button
                onClick={onClose}
                className={`p-1.5 rounded-lg transition-colors ${
                  isDark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800' : 'text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100'
                }`}
                title="Close (Esc)"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Variables popover */}
          {showPopover && (
            <div onMouseEnter={handlePopoverEnter} onMouseLeave={handlePopoverLeave}>
              <VariablesPopover
                isDark={isDark}
                onInsert={handleInsertPlaceholder}
                promptText={displayValue}
                anchorRef={infoButtonRef}
              />
            </div>
          )}

          {/* Editor — fills remaining space */}
          <div className="flex-1 min-h-0 p-4 overflow-auto">
            <HighlightedEditor
              value={displayValue}
              onChange={block.onChange}
              isDark={isDark}
              rows={999}
              dimmed={showDefault}
              blockId="fullscreen-editor"
              outputFormat={outputFormat}
              headerHint={block.headerHint}
              headerHintLabel={block.headerHintLabel}
              fillHeight
            />
          </div>

          {/* Footer hint */}
          {showDefault && (
            <div className={`px-5 py-2 border-t shrink-0 ${
              isDark ? 'border-zinc-800' : 'border-neutral-100'
            }`}>
              <p className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}>
                Showing built-in default. Edit to override.
              </p>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// Tag badge colors (for injection blocks in pipeline stages)
// ---------------------------------------------------------------------------

const TAG_COLORS: Record<string, { dark: string; light: string }> = {
  amber: { dark: 'bg-amber-500/15 text-amber-400', light: 'bg-amber-50 text-amber-600' },
  sky: { dark: 'bg-sky-500/15 text-sky-400', light: 'bg-sky-50 text-sky-600' },
  zinc: { dark: 'bg-zinc-700 text-zinc-400', light: 'bg-neutral-100 text-neutral-500' },
}

// ---------------------------------------------------------------------------
// Block renderers
// ---------------------------------------------------------------------------

function EditableBlock({ block, isDark, compact }: { block: PromptBlock; isDark: boolean; compact?: boolean }) {
  const { isOverridden, showDefault, displayValue } = resolveBlockDisplay(block.value, block.defaultValue)

  const [showPopover, setShowPopover] = useState(false)
  const [showFullscreen, setShowFullscreen] = useState(false)
  const infoButtonRef = useRef<HTMLButtonElement>(null)
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout>>()

  const handleMouseEnterInfo = useCallback(() => {
    clearTimeout(hideTimeoutRef.current)
    setShowPopover(true)
  }, [])

  const handleMouseLeaveInfo = useCallback(() => {
    hideTimeoutRef.current = setTimeout(() => setShowPopover(false), 200)
  }, [])

  const handlePopoverEnter = useCallback(() => {
    clearTimeout(hideTimeoutRef.current)
  }, [])

  const handlePopoverLeave = useCallback(() => {
    hideTimeoutRef.current = setTimeout(() => setShowPopover(false), 150)
  }, [])

  const handleInsertPlaceholder = useCallback((token: string) => {
    if (!block.onChange) return
    const textarea = document.querySelector<HTMLTextAreaElement>(`[data-prompt-id="${block.id}"]`)
    if (textarea) {
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const newValue = displayValue.slice(0, start) + token + displayValue.slice(end)
      block.onChange(newValue)
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start + token.length
        textarea.focus()
      })
    } else {
      block.onChange(displayValue + token)
    }
  }, [block, displayValue])

  const outputFormat = block.outputFormat
    ?? (block.expertName
      ? EXPERT_OUTPUT_FORMATS[block.expertName] ?? EXPERT_OUTPUT_FORMATS._custom
      : undefined)

  return (
    <div className={compact ? 'space-y-1.5' : 'space-y-2'}>
      {/* Header row: default badge + info icon + expand + reset */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {showDefault && (
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
              isDark ? 'bg-zinc-800 text-zinc-500' : 'bg-neutral-100 text-neutral-400'
            }`}>
              default
            </span>
          )}
          {/* Info icon — hover to show variables popover */}
          <div
            className="relative"
            onMouseEnter={handleMouseEnterInfo}
            onMouseLeave={handleMouseLeaveInfo}
          >
            <button
              ref={infoButtonRef}
              type="button"
              className={`p-1 rounded-md transition-colors ${
                showPopover
                  ? isDark ? 'bg-zinc-700 text-zinc-300' : 'bg-neutral-200 text-neutral-600'
                  : isDark ? 'text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800' : 'text-neutral-400 hover:text-neutral-500 hover:bg-neutral-100'
              }`}
              title="Available variables"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 7V4h16v3" />
                <path d="M9 20h6" />
                <path d="M12 4v16" />
              </svg>
            </button>
          </div>
          {/* Expand button — open fullscreen editor */}
          <button
            type="button"
            onClick={() => setShowFullscreen(true)}
            className={`p-1 rounded-md transition-colors ${
              isDark ? 'text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800' : 'text-neutral-400 hover:text-neutral-500 hover:bg-neutral-100'
            }`}
            title="Expand editor"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
        </div>
        {isOverridden && block.onReset && (
          <button
            onClick={block.onReset}
            className={`text-[11px] font-medium px-2 py-0.5 rounded-md transition-colors ${
              isDark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700' : 'text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100'
            }`}
          >
            Reset to default
          </button>
        )}
      </div>

      {/* Variables popover */}
      {showPopover && (
        <div onMouseEnter={handlePopoverEnter} onMouseLeave={handlePopoverLeave}>
          <VariablesPopover
            isDark={isDark}
            onInsert={handleInsertPlaceholder}
            promptText={displayValue}
            anchorRef={infoButtonRef}
          />
        </div>
      )}

      {/* Highlighted editor with attached output format */}
      <HighlightedEditor
        value={displayValue}
        onChange={block.onChange}
        isDark={isDark}
        rows={block.rows ?? 18}
        dimmed={showDefault}
        blockId={block.id}
        outputFormat={outputFormat}
        headerHint={block.headerHint}
        headerHintLabel={block.headerHintLabel}
      />

      {showDefault && (
        <p className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}>
          Showing built-in default. Edit to override.
        </p>
      )}
      {block.helperText && (
        <p className={`text-[10px] leading-relaxed ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
          {block.helperText}
        </p>
      )}

      {/* Fullscreen modal */}
      {showFullscreen && (
        <FullscreenPromptModal
          block={block}
          isDark={isDark}
          onClose={() => setShowFullscreen(false)}
        />
      )}
    </div>
  )
}

function InjectionBlock({ block, isDark }: { block: PromptBlock; isDark: boolean }) {
  const colors = TAG_COLORS[block.tagVariant ?? 'amber']
  const tagColor = isDark ? colors.dark : colors.light
  const bgColor = block.tagVariant === 'amber'
    ? isDark ? 'bg-amber-500/[0.06] border-amber-500/15' : 'bg-amber-50/60 border-amber-100'
    : block.tagVariant === 'sky'
      ? isDark ? 'bg-sky-500/[0.06] border-sky-500/15' : 'bg-sky-50/60 border-sky-100'
      : isDark ? 'bg-zinc-800/40 border-zinc-700/40' : 'bg-neutral-50/60 border-neutral-200/50'

  return (
    <div className={`flex items-start gap-3 px-3.5 py-3 rounded-lg border ${bgColor}`}>
      <svg
        width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        className={`shrink-0 mt-0.5 opacity-50 ${isDark ? 'text-zinc-400' : 'text-neutral-400'}`}
      >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
      <div className="flex-1 min-w-0">
        <p className={`text-[11px] leading-relaxed ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
          {block.description}
        </p>
      </div>
      {block.tag && (
        <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${tagColor}`}>
          {block.tag}
        </span>
      )}
    </div>
  )
}

function OutputFormatBlock({ block, isDark }: { block: PromptBlock; isDark: boolean }) {
  return (
    <div className={`px-3.5 py-2.5 rounded-lg border ${
      isDark ? 'bg-zinc-800/40 border-zinc-700/40' : 'bg-neutral-50/60 border-neutral-200/50'
    }`}>
      <code className={`text-[10px] font-mono leading-relaxed break-all ${
        isDark ? 'text-zinc-400' : 'text-neutral-500'
      }`}>
        {block.formatExample}
      </code>
    </div>
  )
}

function ContextBlock({ block, isDark }: { block: PromptBlock; isDark: boolean }) {
  const isHistory = block.contextType === 'history'

  return (
    <div className={`flex items-center gap-2.5 px-3.5 py-2 rounded-lg border ${
      isDark ? 'bg-zinc-800/20 border-zinc-700/30' : 'bg-neutral-50/40 border-neutral-200/40'
    }`}>
      <svg
        width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        className={`shrink-0 opacity-40 ${isDark ? 'text-zinc-400' : 'text-neutral-400'}`}
      >
        {isHistory ? (
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        ) : (
          <>
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </>
        )}
      </svg>
      <span className={`text-[11px] font-light ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
        {isHistory
          ? `Last ${block.messageCount ?? 8} messages from conversation`
          : "The user's latest message"
        }
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function PromptComposerInner({ blocks, isDark, compact }: PromptComposerProps) {
  // The agent type's manifest-declared palette (set when the configurator opened).
  // Falls back to the built-in registry for agents that declare none.
  const runtimeVariables = useConfiguratorStore((s) => s.runtimeVariables)
  const palette = useMemo<Palette>(() => {
    const defs = buildPalette(runtimeVariables)
    const map = new Map(
      defs.filter((p) => typeof p.pattern === 'string').map((p) => [p.name, p]),
    )
    return { defs, map }
  }, [runtimeVariables])

  return (
    <PaletteContext.Provider value={palette}>
    <div className={compact ? 'space-y-2.5' : 'space-y-3.5'}>
      {blocks.map((block) => (
        <div key={block.id}>
          {/* Block header */}
          <div className={`flex items-center gap-2 ${compact ? 'mb-1.5' : 'mb-2'}`}>
            <span className={`text-[10px] font-semibold tracking-wide uppercase ${
              isDark ? 'text-zinc-500' : 'text-neutral-400'
            }`}>
              {block.label}
            </span>
            {block.type === 'injection' && block.tag && (
              <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${
                isDark
                  ? TAG_COLORS[block.tagVariant ?? 'amber'].dark
                  : TAG_COLORS[block.tagVariant ?? 'amber'].light
              }`}>
                {block.tag}
              </span>
            )}
          </div>

          {/* Block content */}
          {block.type === 'editable' && (
            <EditableBlock block={block} isDark={isDark} compact={compact} />
          )}
          {block.type === 'injection' && (
            <InjectionBlock block={block} isDark={isDark} />
          )}
          {block.type === 'output_format' && (
            <OutputFormatBlock block={block} isDark={isDark} />
          )}
          {block.type === 'context' && (
            <ContextBlock block={block} isDark={isDark} />
          )}
        </div>
      ))}
    </div>
    </PaletteContext.Provider>
  )
}

export const PromptComposer = memo(PromptComposerInner)
export default PromptComposer
