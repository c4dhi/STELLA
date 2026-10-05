/**
 * NodeDetailOverlay — click-to-edit overlay for pipeline node settings.
 *
 * Each stage uses a single PromptComposer editor with {{placeholder}} variables
 * for runtime-injected context, plus a SettingsGrid for model configuration.
 */

import { useState, Fragment } from 'react'
import type { JSX } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { PipelineNode as PipelineNodeType, AgentConfigurationPayload } from '../../lib/api-types'
import type { ExpertDefinition, InputGateRule } from './useConfiguratorState'
import { PromptComposer, type PromptBlock } from './PromptComposer'

// ---------------------------------------------------------------------------
// Default prompt templates for pipeline nodes (mirrors Python agent defaults)
// ---------------------------------------------------------------------------

const DEFAULT_INPUT_GATE_TEMPLATE = `You are a routing classifier. Select which expert modules to activate for this message.

{{trigger_rules}}

{{current_state}}
{{pending_deliverables}}
{{processing_mode}}

{{history_2}}

{{user_message}}`

const DEFAULT_RESPONSE_GENERATOR_TEMPLATE = `{{plan_persona}}

CONVERSATIONAL STYLE (spoken aloud via TTS — follow strictly):

LANGUAGE RULE (highest priority):
- You MUST respond in the same language the user speaks.
- If the user speaks German, your ENTIRE response must be in German. Not a single English word.
- If the user speaks English, respond in English.
- When in doubt, default to German.

All style rules below apply in WHATEVER LANGUAGE you are responding in. Use that language's natural spoken register.

Tone — Friendly Professional:
- Think of a skilled interviewer or consultant: warm, attentive, composed.
- Be genuinely interested without being overly enthusiastic or performative.
- Stay professional but never stiff. You can be personable without being casual.
- Adapt slightly to the user's energy — if they are relaxed, you can be a touch warmer. If they are formal, match that. But always stay on the professional side.

Name Usage — CRITICAL:
- Use the user's name at MOST once every 4-5 responses. Most responses should have NO name at all.
- Never put the name at the start of a sentence as a greeting pattern.
- When you do use it, place it mid-sentence or at the end, and only when it adds warmth to a specific moment.

Register:
- Use natural contractions — speak like a real person, not a document.
  DE: "hab ich", "ist's", "geht's", "gibt's" — never "habe ich", "ist es", "gibt es"
  EN: "don't", "it's", "I'm", "that's" — never "do not", "it is"
- Avoid slang, excessive fillers, and overly casual interjections.
- Use clean, professional connectors.
  DE: "also", "das heißt", "in dem Fall", "übrigens"
  EN: "actually", "so", "in that case", "that said"

Transitions — NEVER JUMP ABRUPTLY BETWEEN TOPICS:
- Connect what the user just said to where you're heading next.
- BAD (DE): "Verstehe. Welche Sportart magst du?"
- GOOD (DE): "Ja, wenn man müde ist, fällt alles schwerer. Gibt's eine Sportart, die sich dann machbar anfühlt?"

Variety — the most important rule:
- NEVER use the same opening pattern twice in a row.
- Do NOT always follow the pattern "acknowledge + question." Mix it up.

TTS Rhythm:
- Comma roughly every 7-10 words for natural breathing.
- Period at the end of statements for pitch drop.
- One question mark max, at the very end if you're asking something.

Response Shape — STRICT LENGTH:
- 1-2 sentences, max 3. Aim for 20-35 words.
- ONE direction per response. At most ONE question per response.
- Match the user's energy and length. If you can say it in fewer words, do.

Formatting:
- No markdown, bullets, numbered lists, or emojis.
- Write exactly as a professional interviewer would speak.

Bridge Continuation:
- A short bridge phrase (e.g. "Gute Frage.", "Absolut.", "Good question.") may already have been spoken aloud before your response.
- If so, you will be told what was said. Continue naturally from it — do NOT repeat it, re-greet, or add another acknowledgment.
- Just pick up mid-thought as if you already started talking.

{{current_state}}
{{pending_deliverables}}
{{collected_deliverables}}
{{progress_percentage}}

{{arbitration_directive}}

{{history_10}}

{{user_message}}`

const DEFAULT_BRIDGE_TEMPLATE = `You are the real-time speech reflex for a professional Voice AI interviewer. Generate an immediate, ultra-short conversational "bridge" sentence right after the user stops speaking. This bridge buys time for the main response to be composed.

Core Directives:

Complete Sentence: Your bridge MUST be a complete, self-contained sentence that ends with a period, exclamation mark, or question mark. It will be spoken aloud on its own before the main response follows.

Maximum Length: No more than 6 words.

Do Not Answer: Never attempt to answer the user's question, provide facts, or complete a task.

Tone — Friendly Professional:
- Sound like a composed, attentive interviewer — warm but not overly casual.
- Adapt slightly to the user's energy while staying professional.

Examples (German):
Sachlich/Komplex: "Gute Frage."
Aktion/Bitte: "Auf jeden Fall."
Persönlich/Emotional: "Das kann ich verstehen."
Gesprächig: "Ja, das stimmt."

Examples (English):
Factual/Complex: "Good question."
Action/Request: "Absolutely."
Empathetic/Personal: "I appreciate that."
Conversational: "That's a great point."

Natural Speech: Never say "Processing," "Checking," or "Thinking." Use natural acknowledgments.

Language Matching — CRITICAL:
- ALWAYS respond in the SAME LANGUAGE the user is speaking.
- If the user speaks German, your bridge MUST be in German. No English words.
- If the user speaks English, your bridge MUST be in English.
- When in doubt, default to German.
- Use natural, idiomatic phrasing for each language — do not translate literally.

IMPORTANT: Always end with a period, exclamation mark, or question mark. Never end with a comma, ellipsis, or connector word.

Output ONLY the bridge sentence. No quotes, no explanations.

{{history_2}}

{{user_message}}`

// Stage icon + accent color mapping
const STAGE_META: Record<string, { icon: JSX.Element; accent: string; accentBg: string; accentBgLight: string }> = {
  input_gate: {
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 3h5v5" /><path d="M4 20 21 3" /><path d="M21 16v5h-5" /><path d="M15 15l6 6" /><path d="M4 4l5 5" />
      </svg>
    ),
    accent: 'text-sky-400',
    accentBg: 'bg-sky-500/10 border-sky-500/20',
    accentBgLight: 'bg-sky-50 border-sky-100',
  },
  expert_pool: {
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    accent: 'text-emerald-400',
    accentBg: 'bg-emerald-500/10 border-emerald-500/20',
    accentBgLight: 'bg-emerald-50 border-emerald-100',
  },
  arbitration: {
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 6h18" /><path d="M7 12h10" /><path d="M10 18h4" />
      </svg>
    ),
    accent: 'text-violet-400',
    accentBg: 'bg-violet-500/10 border-violet-500/20',
    accentBgLight: 'bg-violet-50 border-violet-100',
  },
  response_generator: {
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    accent: 'text-amber-400',
    accentBg: 'bg-amber-500/10 border-amber-500/20',
    accentBgLight: 'bg-amber-50 border-amber-100',
  },
  bridge_generator: {
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    ),
    accent: 'text-rose-400',
    accentBg: 'bg-rose-500/10 border-rose-500/20',
    accentBgLight: 'bg-rose-50 border-rose-100',
  },
}

interface NodeDetailOverlayProps {
  node: PipelineNodeType
  configuration: AgentConfigurationPayload
  onUpdateNodeConfig: (nodeId: string, slotId: string, value: unknown) => void
  onClose: () => void
  isDark: boolean
  // Expert-derived data for cross-references
  experts?: ExpertDefinition[]
  inputGateRules?: InputGateRule[]
  arbitrationOrder?: string[]
}

/** Collapsible grouped settings card for model/temp/tokens.
 *  Extracted to module level so React preserves its identity (and open state)
 *  across parent re-renders triggered by config edits. */
function SettingsGrid({ children, isDark }: { children: React.ReactNode; isDark: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`rounded-xl border ${
      isDark ? 'bg-zinc-800/30 border-zinc-700/40' : 'bg-neutral-50/50 border-neutral-200/40'
    }`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center gap-2 px-4 py-3 text-left transition-colors rounded-xl ${
          isDark ? 'hover:bg-zinc-800/60' : 'hover:bg-neutral-100/60'
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className={isDark ? 'text-zinc-500' : 'text-neutral-400'}
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
        <span className={`flex-1 text-[11px] font-semibold tracking-wide uppercase ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
          Model Settings
        </span>
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
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
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="grid grid-cols-2 gap-4 px-4 pb-4">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default function NodeDetailOverlay({
  node,
  configuration,
  onUpdateNodeConfig,
  onClose,
  isDark,
  experts = [],
  inputGateRules = [],
  arbitrationOrder = [],
}: NodeDetailOverlayProps) {
  const nodeConfig = (configuration.nodes?.[node.id] ?? {}) as Record<string, unknown>
  const meta = STAGE_META[node.id]

  const inputClass = `w-full px-3.5 py-2.5 rounded-xl text-[13px] font-light focus:outline-none transition-all ${
    isDark
      ? 'bg-zinc-800/80 border border-zinc-700/80 text-zinc-100 focus:border-zinc-500 focus:bg-zinc-800'
      : 'bg-white border border-neutral-200 text-neutral-900 focus:border-neutral-400'
  }`

  const labelClass = `text-[13px] font-medium ${isDark ? 'text-zinc-300' : 'text-neutral-600'}`

  const getSlotValue = (slotId: string) => {
    return nodeConfig[slotId]
  }

  const getSlotDefault = (slotId: string) => {
    return node.slots.find((s) => s.id === slotId)?.default
  }

  /**
   * Render a configurable slot field.
   * - `defaultValue`: if provided, shown in the actual field (dimmed) when no override is set.
   *   Editing the default value writes it as an override. "Reset to default" clears the override.
   * - `emptyWhenDefault`: if true, the field shows empty when no override (used for plan-overridden fields).
   * - Falls back to schema slot default as placeholder for fields without a defaultValue.
   */
  const renderSlotField = (slotId: string, label: string, type: 'text' | 'textarea' | 'select' | 'number', options?: {
    placeholder?: string
    selectOptions?: string[]
    min?: number
    max?: number
    step?: number
    rows?: number
    defaultValue?: string
    emptyWhenDefault?: boolean
    helperText?: string
  }) => {
    const value = getSlotValue(slotId)
    const defaultVal = getSlotDefault(slotId)
    const isOverridden = value !== undefined && value !== null
    const showDefault = !isOverridden && options?.defaultValue && !options?.emptyWhenDefault

    // Display value: user override > defaultValue (shown dimmed) > empty
    const displayValue = isOverridden
      ? String(value)
      : showDefault
        ? options!.defaultValue!
        : ''

    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          {label && (
            <label className={labelClass}>
              {label}
            </label>
          )}
          <div className="flex items-center gap-2">
            {showDefault && (
              <span className={`text-[11px] font-medium px-2 py-0.5 rounded-md ${
                isDark ? 'bg-zinc-800 text-zinc-500' : 'bg-neutral-100 text-neutral-400'
              }`}>
                default
              </span>
            )}
            {isOverridden && (
              <button
                onClick={() => onUpdateNodeConfig(node.id, slotId, undefined)}
                className={`text-[11px] font-medium px-2.5 py-1 rounded-lg transition-colors ${
                  isDark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800' : 'text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100'
                }`}
              >
                Reset to default
              </button>
            )}
          </div>
        </div>
        {type === 'textarea' ? (
          <textarea
            value={displayValue}
            onChange={(e) => onUpdateNodeConfig(node.id, slotId, e.target.value)}
            placeholder={options?.emptyWhenDefault ? options?.placeholder : (typeof defaultVal === 'string' ? defaultVal : options?.placeholder)}
            rows={options?.rows ?? 6}
            className={`${inputClass} resize-y ${showDefault ? (isDark ? '!text-zinc-300' : '!text-neutral-500') : ''} ${
              options?.emptyWhenDefault
                ? isDark ? 'placeholder:text-zinc-600 placeholder:font-light' : 'placeholder:text-neutral-300 placeholder:font-light'
                : ''
            }`}
            style={{ fontSize: '12px', lineHeight: '1.7' }}
          />
        ) : type === 'select' ? (
          <select
            value={isOverridden ? String(value) : ''}
            onChange={(e) => onUpdateNodeConfig(node.id, slotId, e.target.value || undefined)}
            className={inputClass}
          >
            <option value="">Default{defaultVal ? ` (${defaultVal})` : ''}</option>
            {options?.selectOptions?.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        ) : type === 'number' ? (
          <input
            type="number"
            value={isOverridden ? Number(value) : (options?.defaultValue !== undefined ? options.defaultValue : '')}
            onChange={(e) => onUpdateNodeConfig(node.id, slotId, e.target.value ? Number(e.target.value) : undefined)}
            placeholder={defaultVal !== undefined ? String(defaultVal) : undefined}
            min={options?.min}
            max={options?.max}
            step={options?.step}
            className={`${inputClass} ${!isOverridden && options?.defaultValue !== undefined ? (isDark ? '!text-zinc-300' : '!text-neutral-500') : ''}`}
          />
        ) : (
          <input
            type="text"
            value={displayValue}
            onChange={(e) => onUpdateNodeConfig(node.id, slotId, e.target.value)}
            placeholder={typeof defaultVal === 'string' ? defaultVal : options?.placeholder}
            className={`${inputClass} ${showDefault ? (isDark ? '!text-zinc-300' : '!text-neutral-500') : ''}`}
          />
        )}
        {options?.helperText && (
          <p className={`text-[11px] mt-2 leading-relaxed ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
            {options.helperText}
          </p>
        )}
        {showDefault && (
          <p className={`text-[11px] mt-2 ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}>
            Showing built-in default. Edit to override.
          </p>
        )}
      </div>
    )
  }

  const ReadOnlySection = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <label className={`text-[13px] font-medium block mb-2 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
        {title}
      </label>
      <div
        className={`px-4 py-3.5 rounded-xl text-[12px] font-light leading-relaxed ${
          isDark ? 'bg-zinc-800/40 border border-zinc-700/40 text-zinc-400' : 'bg-neutral-50/80 border border-neutral-200/50 text-neutral-500'
        }`}
      >
        {children}
      </div>
    </div>
  )

  // Per-stage content renderers
  const renderInputGate = () => {
    const systemPromptValue = getSlotValue('system_prompt')
    const isOverridden = systemPromptValue !== undefined && systemPromptValue !== null

    const blocks: PromptBlock[] = [
      {
        id: 'system_prompt',
        type: 'editable',
        label: 'Prompt Template',
        value: isOverridden ? String(systemPromptValue) : undefined,
        defaultValue: DEFAULT_INPUT_GATE_TEMPLATE,
        onChange: (v) => onUpdateNodeConfig(node.id, 'system_prompt', v),
        onReset: () => onUpdateNodeConfig(node.id, 'system_prompt', undefined),
        rows: 18,
        outputFormat: '{"experts": ["name1", "name2"]}',
      },
    ]

    return (
      <div className="space-y-6">
        <PromptComposer blocks={blocks} isDark={isDark} />

        <SettingsGrid isDark={isDark}>
          {renderSlotField('model', 'Model', 'select', { selectOptions: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1-nano'] })}
          {renderSlotField('temperature', 'Temperature', 'number', { min: 0, max: 1, step: 0.1 })}
          {renderSlotField('max_tokens', 'Max Tokens', 'number', { min: 20, max: 500, step: 10 })}
        </SettingsGrid>
      </div>
    )
  }

  const renderExpertPool = () => {
    const foreground = experts.filter((e) => e.enabled && !e.isBackground)
    const background = experts.filter((e) => e.enabled && e.isBackground)

    return (
      <div className="space-y-6">
        <ReadOnlySection title={`Active Experts (${foreground.length})`}>
          <div className="space-y-1.5">
            {foreground.map((e) => (
              <div key={e.name} className="flex items-center gap-2.5 py-1">
                <span className="font-medium">{e.name}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-mono ${isDark ? 'bg-zinc-700 text-zinc-400' : 'bg-neutral-200 text-neutral-500'}`}>
                  {e.model}
                </span>
                {e.alwaysTriggered && (
                  <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-md ${isDark ? 'bg-sky-500/20 text-sky-400' : 'bg-sky-100 text-sky-600'}`}>
                    always
                  </span>
                )}
              </div>
            ))}
          </div>
        </ReadOnlySection>

        {background.length > 0 && (
          <ReadOnlySection title={`Background Experts (${background.length})`}>
            <div className="space-y-1.5">
              {background.map((e) => (
                <div key={e.name} className="flex items-center gap-2.5 py-1">
                  <span className="font-medium">{e.name}</span>
                </div>
              ))}
            </div>
          </ReadOnlySection>
        )}

        <p className={`text-[12px] font-light italic text-center py-2 ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}>
          Edit individual experts in the sidebar
        </p>
      </div>
    )
  }

  const renderArbitration = () => (
    <div className="space-y-6">
      <ReadOnlySection title="Priority Order (from sidebar drag order)">
        <div className="flex flex-wrap gap-2">
          {arbitrationOrder.map((name, i) => (
            <span key={name} className="flex items-center gap-1.5">
              <span className={`font-medium px-2 py-0.5 rounded-md ${
                isDark ? 'bg-zinc-700/60 text-zinc-300' : 'bg-neutral-200/60 text-neutral-600'
              }`}>
                {name}
              </span>
              {i < arbitrationOrder.length - 1 && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  className={isDark ? 'text-zinc-600' : 'text-neutral-300'}
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              )}
            </span>
          ))}
        </div>
      </ReadOnlySection>

      {renderSlotField('gate_failure_message', 'Gate Failure Message', 'textarea', { rows: 2 })}

      <div className={`flex items-center gap-2.5 text-[12px] font-light ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-60">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
        Deterministic Python — no LLM, no plan data. Priority-based conflict resolution.
      </div>
    </div>
  )

  const renderResponseGenerator = () => {
    const systemPromptValue = getSlotValue('system_prompt')
    const isOverridden = systemPromptValue !== undefined && systemPromptValue !== null

    const blocks: PromptBlock[] = [
      {
        id: 'system_prompt',
        type: 'editable',
        label: 'Prompt Template',
        headerHint: 'The bridge phrase (from Bridge Generator) is automatically prepended to every response. The model is instructed to continue naturally from it — do not repeat or re-acknowledge.',
        headerHintLabel: 'Bridge Phrase Injection',
        value: isOverridden ? String(systemPromptValue) : undefined,
        defaultValue: DEFAULT_RESPONSE_GENERATOR_TEMPLATE,
        onChange: (v) => onUpdateNodeConfig(node.id, 'system_prompt', v),
        onReset: () => onUpdateNodeConfig(node.id, 'system_prompt', undefined),
        rows: 22,
      },
    ]

    return (
      <div className="space-y-6">
        <PromptComposer blocks={blocks} isDark={isDark} />

        <SettingsGrid isDark={isDark}>
          {renderSlotField('model', 'Model', 'select', { selectOptions: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1-nano'] })}
          {renderSlotField('temperature', 'Temperature', 'number', { min: 0, max: 1.5, step: 0.1 })}
          {renderSlotField('max_tokens', 'Max Tokens', 'number', { min: 50, max: 1000, step: 10 })}
        </SettingsGrid>
      </div>
    )
  }

  const renderBridgeGenerator = () => {
    const systemPromptValue = getSlotValue('system_prompt')
    const isOverridden = systemPromptValue !== undefined && systemPromptValue !== null

    const blocks: PromptBlock[] = [
      {
        id: 'system_prompt',
        type: 'editable',
        label: 'Prompt Template',
        value: isOverridden ? String(systemPromptValue) : undefined,
        defaultValue: DEFAULT_BRIDGE_TEMPLATE,
        onChange: (v) => onUpdateNodeConfig(node.id, 'system_prompt', v),
        onReset: () => onUpdateNodeConfig(node.id, 'system_prompt', undefined),
        rows: 18,
      },
    ]

    return (
      <div className="space-y-6">
        <PromptComposer blocks={blocks} isDark={isDark} />

        <SettingsGrid isDark={isDark}>
          {renderSlotField('model', 'Model', 'select', { selectOptions: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1-nano'] })}
          {renderSlotField('temperature', 'Temperature', 'number', { min: 0, max: 1, step: 0.1 })}
          {renderSlotField('max_tokens', 'Max Tokens', 'number', { min: 10, max: 100, step: 5 })}
          {renderSlotField('fast_path', 'Fast Bridge (skip LLM)', 'select', { selectOptions: ['off', 'on'] })}
          {renderSlotField('timeout_ms', 'LLM Bridge Timeout (ms)', 'number', { min: 200, max: 5000, step: 100 })}
        </SettingsGrid>

        <div className={`flex items-center gap-2.5 text-[12px] font-light ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-60">
            <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
          Parallel path — no plan data. Fast Bridge "on" serves an instant templated ack (no LLM); "off" generates a contextual bridge from the prompt, falling back after the timeout.
        </div>
      </div>
    )
  }

  // Generic fallback: render any stage's editable slots straight from the
  // manifest — `text` slots as PromptComposer blocks (supporting {{variable}}
  // placeholders), and number/select slots as a settings grid. This lets new
  // pipeline stages (e.g. barge_in) be fully configurable without a bespoke
  // renderer, instead of falling through to "No configuration available".
  const renderGenericStage = () => {
    const textSlots = node.slots.filter((s) => s.type === 'text')
    const settingSlots = node.slots.filter((s) => s.type === 'number' || s.type === 'select')

    const blocks: PromptBlock[] = textSlots.map((s) => {
      const v = getSlotValue(s.id)
      const isOverridden = v !== undefined && v !== null
      return {
        id: s.id,
        type: 'editable' as const,
        label: s.label,
        headerHint: s.description,
        value: isOverridden ? String(v) : undefined,
        defaultValue: typeof s.default === 'string' ? s.default : '',
        onChange: (val: string) => onUpdateNodeConfig(node.id, s.id, val),
        onReset: () => onUpdateNodeConfig(node.id, s.id, undefined),
        rows: 18,
      }
    })

    return (
      <div className="space-y-6">
        {blocks.length > 0 && <PromptComposer blocks={blocks} isDark={isDark} />}
        {settingSlots.length > 0 && (
          <SettingsGrid isDark={isDark}>
            {settingSlots.map((s) => (
              <Fragment key={s.id}>
                {renderSlotField(
                  s.id,
                  s.label,
                  s.type === 'select' ? 'select' : 'number',
                  {
                    selectOptions: s.options,
                    min: s.min,
                    max: s.max,
                    step: s.step,
                    helperText: s.type === 'select' ? s.description : undefined,
                  },
                )}
              </Fragment>
            ))}
          </SettingsGrid>
        )}
      </div>
    )
  }

  const stageRenderers: Record<string, () => JSX.Element> = {
    input_gate: renderInputGate,
    expert_pool: renderExpertPool,
    arbitration: renderArbitration,
    response_generator: renderResponseGenerator,
    bridge_generator: renderBridgeGenerator,
  }

  // Use a bespoke renderer when one exists; otherwise fall back to the generic
  // slot-driven renderer so every manifest-defined stage is configurable.
  const renderContent =
    stageRenderers[node.id] || (node.slots.length > 0 ? renderGenericStage : undefined)

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-[110] flex items-center justify-center p-8 bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 12 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        className={`rounded-2xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col ${
          isDark
            ? 'bg-zinc-900 border border-zinc-700/80 shadow-[0_12px_48px_rgba(0,0,0,0.7)]'
            : 'bg-white border border-neutral-200 shadow-[0_12px_48px_rgba(0,0,0,0.12)]'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`px-6 py-5 border-b shrink-0 ${isDark ? 'border-zinc-800' : 'border-neutral-100'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              {/* Stage icon */}
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center border ${
                isDark
                  ? `${meta?.accentBg || 'bg-zinc-800 border-zinc-700'}`
                  : `${meta?.accentBgLight || 'bg-neutral-50 border-neutral-200'}`
              }`}>
                <span className={meta?.accent || (isDark ? 'text-zinc-400' : 'text-neutral-500')}>
                  {meta?.icon || <span className="text-lg">{node.icon || '\u2699\uFE0F'}</span>}
                </span>
              </div>
              <div>
                <h3 className={`text-[16px] font-semibold tracking-tight ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                  {node.label}
                </h3>
                {node.description && (
                  <p className={`text-[12px] font-light mt-0.5 ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                    {node.description}
                  </p>
                )}
              </div>
            </div>
            <button
              onClick={onClose}
              className={`p-2.5 rounded-xl transition-colors ${
                isDark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800' : 'text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100'
              }`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {renderContent ? renderContent() : (
            <p className={`text-[13px] font-light ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
              No configuration available for this stage.
            </p>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}
