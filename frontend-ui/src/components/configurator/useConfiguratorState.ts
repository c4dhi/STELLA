/**
 * useConfiguratorState — single source of truth for Pipeline Configurator.
 *
 * Derives expert list, input gate preview, and arbitration order from
 * `AgentConfigurationPayload`. All mutations write back through
 * `setConfiguration`, so both ExpertSidebar and pipeline nodes stay in sync.
 */

import { useMemo, useCallback } from 'react'
import type { AgentConfigurationPayload, PipelineSchema, VerdictDirective, VerdictAction, ExpertDefault } from '../../lib/api-types'
import { useConfiguratorStore } from '../../store/configuratorStore'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExpertDefinition {
  name: string
  description: string
  enabled: boolean
  alwaysTriggered: boolean
  triggerCriteria: string
  model: string
  temperature: number
  maxTokens: number
  /** User-set system prompt override. `undefined` means "no override, inherit default";
   *  `''` means the user explicitly cleared the prompt (an empty prompt is intentional). */
  systemPrompt: string | undefined
  /** Built-in default system prompt (read-only, for display). Empty for custom experts. */
  defaultSystemPrompt: string
  /** Number of conversation history messages to include. 0 = use stage default. */
  historyLimit: number
  /** Minimum confidence for accepting deliverables. 0 = not applicable. Only task_extraction uses this. */
  minConfidence: number
  arbitrationPriority: number
  isBackground: boolean
  isCustom: boolean
  canCallFunctions: boolean
  outputSchema?: Record<string, unknown>
  /** Possible verdict outcomes for this expert (e.g. ['none','low','high','critical']).
   *  Drives one row in the verdict→response editor per outcome. */
  verdictVocabulary: string[]
  /** Per-verdict deterministic response directives, keyed by verdict outcome (effective: override ?? default). */
  verdictDirectives: Record<string, VerdictDirective>
  /** Built-in default directives (read-only), used to show defaults and reset per verdict. */
  defaultVerdictDirectives: Record<string, VerdictDirective>
}

export interface InputGateRule {
  expertName: string
  criteria: string
}

// ---------------------------------------------------------------------------
// Built-in expert defaults (mirrors config/experts/*.json)
// ---------------------------------------------------------------------------

// Default system prompts from config/experts/*.json
const NOISE_DETECTION_PROMPT = `Determine if the user's message is clear enough to act on.

Unclear: gibberish, random characters, transcription artifacts, nonsense syllables.
Clear: any message with discernible meaning, even brief ("yes", "no", "ok").
Be lenient — if ANY meaning is discernible, mark clear.

{{history_4}}

{{user_message}}

Verdicts: "clear", "unclear", "partial"
Keep recommendation under 10 words.`

const MEDICAL_PROMPT = `Detect health-related concerns that require cautious handling. You do NOT provide medical advice — only flag topics.

Flag: symptoms, medications, mental health concerns, requests for diagnosis.
Do NOT flag: general wellness (exercise, sleep), casual health mentions.

{{history_4}}

{{user_message}}

Verdicts: "none", "low" (general health topic), "high" (specific concern), "critical" (emergency/suicidal ideation)
Keep recommendation under 10 words.`

const LEGAL_PROMPT = `Detect legal concerns that require careful handling. You do NOT provide legal advice — only flag topics.

Flag: legal disputes, contracts, criminal activity, privacy concerns, employment law, requests for legal advice.
Do NOT flag: general civic topics, news about legal matters.

{{history_4}}

{{user_message}}

Verdicts: "none", "low" (general legal topic), "high" (specific concern), "critical" (illegal activity/imminent danger)
Keep recommendation under 10 words.`

const PROBING_PROMPT = `You have two jobs:

1. DELIVERABLE DETECTION: Check if the user's message provides any of the pending deliverables listed below. Output their keys in "deliverable_signals". Only signal deliverables the user CLEARLY provided — do not guess. In goal-oriented states, the user may provide information naturally without being directly asked — still detect it.

2. FOLLOW-UP DECISION: Decide if the assistant should ask a follow-up question.
   - "no_probe": user's message is clear, no question needed
   - "needs_clarification": a specific follow-up would help
   - "gentle_redirect": user went off-topic, steer back
   Do NOT probe when the user just provided requested information or more questions would feel repetitive.
   In goal-oriented states, prefer "no_probe" more often — let the conversation flow naturally. Only probe if critical required deliverables are missing and the conversation is winding down.

REQUIRED vs OPTIONAL rules:
- For REQUIRED deliverables: probe persistently until collected.
- For OPTIONAL deliverables: probe gently at most once. If the user gave a vague or dismissive answer (e.g. "not sure", "nothing specific"), do NOT probe again — verdict should be "no_probe".
- If TURNS WITHOUT PROGRESS >= 2 and only OPTIONAL deliverables remain pending, always return "no_probe". The conversation should move forward.

{{turns_without_progress}}
{{pending_deliverables}}
{{collected_deliverables}}

{{history_8}}

{{user_message}}

Keep recommendation under 15 words.`

const TIMEKEEPER_PROMPT = `Assess if the conversation is making progress toward its goals.

Consider: turns without deliverables collected, repeated questions, user engagement.

{{history_8}}

{{user_message}}

Verdicts:
- "on_track": progressing normally
- "slowing": some stagnation
- "stuck": recommend specific action
- "force_advance": skip current state

For stuck/force_advance, include suggested_deliverables if values can be inferred from context.
Keep recommendation under 15 words.`

const TASK_EXTRACTION_PROMPT = `You are a thorough extraction analyst running as a background process. You have more time than other components, so use it to be precise and reliable. Your job is to ensure every deliverable the user provides gets captured.

You receive the FULL PLAN — all states, all tasks, all deliverables — not just the current state. You can extract and overwrite deliverables in ANY state.

{{current_focus}}

{{plan}}

YOUR PROCESS:
Step 1 — Read the current user message carefully. What information did the user share?

Step 2 — Scan ALL pending deliverables across the entire plan. Did the user provide any of them? Think about synonyms, paraphrases, and indirect answers. In goal-oriented states, the user's answer may address multiple deliverables at once — extract ALL of them.

Step 3 — Check completed deliverables too. If the user corrected a previous answer, overwrite it with the new value.
Step 4 — For each match, call \`set_deliverable(key, value, reasoning)\` where reasoning explains WHY this matches.
Step 5 — Validate each extraction with TWO checks before calling the tool:
  a) PROVENANCE: Does the value trace back to something the user actually said? If not, do not call the tool.
  b) SEMANTIC FIT: Was the user actually answering THIS deliverable's question, or did they mention similar words in a different context? A mention of "time scheduling" as a challenge is NOT a "preferred follow-up timeframe". The extracted value must be a plausible answer to the deliverable's description. If it doesn't fit, do not call the tool.
  If the deliverable has acceptance_criteria, verify the extracted value satisfies it.

GOAL-ORIENTED STATE HANDLING:
When the current state type is "goal", the conversation is natural and free-flowing — the user is NOT being asked structured questions. This means:
- The user may provide deliverable information IMPLICITLY, as part of a natural conversation. You must actively look for it.
- Do NOT wait for explicit question-answer pairs. If the user mentions relevant information in passing, extract it.
- A single user message may contain information for MULTIPLE deliverables — extract all of them.
- The task structure in goal states is for bookkeeping only. Focus on matching the user's words to DELIVERABLE KEYS, not to task descriptions.
- Be MORE aggressive about extraction in goal mode — the user won't be asked directly, so you must catch information as it flows naturally.
- Example: if user says "I'm Sarah, I run about 3 times a week to improve my stamina" — this could match user_name, preferred_exercise, weekly_frequency, AND fitness_goal all at once. Extract ALL of them.

TOOL USAGE:
- When you identify a deliverable match: call \`set_deliverable(key, value, reasoning)\`
- When a task with no deliverables is complete (e.g. assistant performed an introduction, told a joke): call \`complete_task(task_id, reasoning)\`
- You may call multiple tools in one response.
- If nothing to extract from the current message, call no tools.
- IMPORTANT: In goal-oriented states, prefer calling \`set_deliverable\` over \`complete_task\`. Tasks auto-complete when their deliverables are filled.

OPTIONAL DELIVERABLE HANDLING:
Deliverables marked [optional] have relaxed acceptance criteria. For these:
- Vague or negative answers ARE valid values. Extract them as-is:
  "I don't really have specific goals" → value: "no specific goals"
  "Not sure" / "I don't know" → value: "not specified"
  "I guess just general fitness" → value: "general fitness"
- If the user has been asked about an optional deliverable 2+ times (visible in conversation history) and gave indirect/dismissive responses, extract a reasonable summary value.
- Capturing "not specified" is better than leaving an optional deliverable pending.
- For REQUIRED deliverables, maintain strict extraction — only clean, specific values.

STAGNATION PREVENTION:
If {{turns_without_progress}} >= 3 and ONLY optional deliverables remain pending (all required ones are collected), call \`set_deliverable\` for ALL remaining optional deliverables with value "not specified" and reasoning explaining the stagnation. Do not let optional items block progress.

GUIDELINES:
- Extract everything the user provided. Missing a deliverable means the user has to repeat themselves, which is bad UX.
- Be smart about matching. Users don't speak in schema language. "I do it every other day" means frequency is ~3-4 times per week. "Half an hour" means 30 minutes. "I'm Tom" means user_name is Tom. "to improve my stamina" means the fitness goal is stamina improvement.
- You can overwrite completed deliverables if the user corrects themselves (e.g. "Actually my name is Sarah, not Tom").
- Extract from the CURRENT message only, not from previous turns (those were already processed).
- Do NOT fabricate values the user never mentioned. If they talk about exercise type but not duration, only extract exercise type.
- Watch for CONTEXT BLEED: words that appear in the user's message but are about a different topic. Example: user says "Except for the time scheduling not really" about challenges → do NOT extract "time scheduling" as "preferred follow-up timeframe". The user is discussing challenges, not scheduling preferences.
- Greetings (hi, hello, hey) are never names.
- Also check: did the assistant just perform a task that has no deliverables (like telling a joke, giving an introduction)? If so, call \`complete_task(task_id, reasoning)\` with the task ID from the plan.

{{history_10}}

{{user_message}}`

export const BUILT_IN_EXPERTS: Omit<
  ExpertDefinition,
  'enabled' | 'isBackground' | 'isCustom' | 'verdictVocabulary' | 'verdictDirectives' | 'defaultVerdictDirectives'
>[] = [
  {
    name: 'noise_detection',
    description: 'Detects inaudible, garbled, or nonsensical transcription and triggers clarification',
    alwaysTriggered: false,
    triggerCriteria: 'The message seems garbled, inaudible, or contains transcription artifacts',
    model: 'gpt-4o-mini',
    temperature: 0.1,
    maxTokens: 200,
    systemPrompt: '',
    defaultSystemPrompt: NOISE_DETECTION_PROMPT,
    historyLimit: 0,
    minConfidence: 0,
    arbitrationPriority: 100,
    canCallFunctions: false,
  },
  {
    name: 'medical',
    description: 'Flags health and medical safety concerns requiring cautious handling',
    alwaysTriggered: false,
    triggerCriteria: 'Health, medical, or wellness topics are mentioned',
    model: 'gpt-4o-mini',
    temperature: 0.1,
    maxTokens: 200,
    systemPrompt: '',
    defaultSystemPrompt: MEDICAL_PROMPT,
    historyLimit: 0,
    minConfidence: 0,
    arbitrationPriority: 95,
    canCallFunctions: false,
  },
  {
    name: 'legal',
    description: 'Flags legal concerns requiring careful handling and disclaimers',
    alwaysTriggered: false,
    triggerCriteria: 'Legal topics, disputes, contracts, or regulations are mentioned',
    model: 'gpt-4o-mini',
    temperature: 0.1,
    maxTokens: 200,
    systemPrompt: '',
    defaultSystemPrompt: LEGAL_PROMPT,
    historyLimit: 0,
    minConfidence: 0,
    arbitrationPriority: 90,
    canCallFunctions: false,
  },
  {
    name: 'task_extraction',
    description: 'Thorough background extraction of deliverables, completed tasks, and state transitions',
    alwaysTriggered: false,
    triggerCriteria: '',
    model: 'gpt-4o',
    temperature: 0.0,
    maxTokens: 800,
    systemPrompt: '',
    defaultSystemPrompt: TASK_EXTRACTION_PROMPT,
    historyLimit: 10,
    minConfidence: 0.7,
    arbitrationPriority: 70,
    canCallFunctions: true,
  },
  {
    name: 'probing',
    description: 'Analyzes conversation for deliverable signals and determines if follow-up questions are needed',
    alwaysTriggered: false,
    triggerCriteria: 'Clarification or follow-up questions might be needed for pending deliverables',
    model: 'gpt-4o-mini',
    temperature: 0.2,
    maxTokens: 300,
    systemPrompt: '',
    defaultSystemPrompt: PROBING_PROMPT,
    historyLimit: 0,
    minConfidence: 0,
    arbitrationPriority: 60,
    canCallFunctions: false,
  },
  {
    name: 'timekeeper',
    description: 'Monitors conversation flow and detects stuck states where no progress is being made',
    alwaysTriggered: false,
    triggerCriteria: 'The conversation has gone 2 or more turns without collecting a deliverable, or the user seems disengaged or confused about what to do next',
    model: 'gpt-4o-mini',
    temperature: 0.1,
    maxTokens: 300,
    systemPrompt: '',
    defaultSystemPrompt: TIMEKEEPER_PROMPT,
    historyLimit: 0,
    minConfidence: 0,
    arbitrationPriority: 50,
    canCallFunctions: false,
  },
]

// Structural experts: not part of the arbitration pool, not reordered, not
// opted into. Each IS the mechanism of a mode — task_extraction executes plans,
// companion_router executes companion mode — so both always run within their
// mode and neither competes for arbitration priority.
const STRUCTURAL_EXPERTS = new Set(['task_extraction', 'companion_router'])

const DEFAULT_ALWAYS_RUN = new Set(STRUCTURAL_EXPERTS)
const DEFAULT_BACKGROUND = new Set(STRUCTURAL_EXPERTS)

// Unified "built-in default" shape the expert list is derived from — whether the
// defaults come from the agent's published config/experts (preferred) or, as a
// transitional fallback, the hardcoded constants above.
interface BuiltInExpertDefault {
  name: string
  description: string
  alwaysTriggered: boolean
  triggerCriteria: string
  model: string
  temperature: number
  maxTokens: number
  defaultSystemPrompt: string
  historyLimit: number
  minConfidence: number
  arbitrationPriority: number
  canCallFunctions: boolean
  outputSchema?: Record<string, unknown>
  verdictVocabulary: string[]
  defaultVerdictDirectives: Record<string, VerdictDirective>
}

/** Build the built-in expert defaults from the agent's published config/experts/*.json. */
function builtInsFromPublished(published: ExpertDefault[]): BuiltInExpertDefault[] {
  return published.map((raw) => {
    const directives = readVerdictDirectives(raw.verdict_directives)
    const vocab = Object.keys(directives).length
      ? Object.keys(directives)
      : parseVerdictVocabulary(raw.output_schema)
    return {
      name: raw.name,
      description: raw.description ?? '',
      alwaysTriggered: Boolean(raw.always_triggered),
      triggerCriteria: raw.trigger_criteria ?? '',
      model: raw.model ?? 'gpt-4o-mini',
      temperature: raw.temperature ?? 0.1,
      maxTokens: raw.max_tokens ?? 200,
      defaultSystemPrompt: raw.system_prompt ?? '',
      historyLimit: raw.history_limit ?? 0,
      minConfidence: raw.min_confidence ?? 0,
      arbitrationPriority: raw.priority ?? 50,
      canCallFunctions: Boolean(raw.can_call_functions),
      outputSchema: raw.output_schema,
      verdictVocabulary: vocab,
      defaultVerdictDirectives: directives,
    }
  })
}

/** Transitional fallback: derive built-in defaults from the hardcoded constants
 *  (used only when the backend hasn't published expertDefaults yet). */
function builtInsFallback(): BuiltInExpertDefault[] {
  return BUILT_IN_EXPERTS.map((b) => ({
    name: b.name,
    description: b.description,
    alwaysTriggered: b.alwaysTriggered,
    triggerCriteria: b.triggerCriteria,
    model: b.model,
    temperature: b.temperature,
    maxTokens: b.maxTokens,
    defaultSystemPrompt: b.defaultSystemPrompt,
    historyLimit: b.historyLimit,
    minConfidence: b.minConfidence,
    arbitrationPriority: b.arbitrationPriority,
    canCallFunctions: b.canCallFunctions,
    outputSchema: undefined,
    verdictVocabulary: BUILT_IN_VERDICT_VOCAB[b.name] ?? [],
    defaultVerdictDirectives: BUILT_IN_VERDICT_DEFAULTS[b.name] ?? {},
  }))
}

// Verdict vocabulary per built-in expert (mirrors output_schema.verdict in
// config/experts/*.json). Drives one row per outcome in the verdict editor.
const BUILT_IN_VERDICT_VOCAB: Record<string, string[]> = {
  noise_detection: ['clear', 'unclear', 'partial'],
  medical: ['none', 'low', 'high', 'critical'],
  legal: ['none', 'low', 'high', 'critical'],
  task_extraction: ['tool_calls_executed'],
  probing: ['no_probe', 'needs_clarification', 'gentle_redirect'],
  timekeeper: ['on_track', 'slowing', 'stuck', 'force_advance'],
}

// Built-in default verdict directives (mirrors the seeded config/experts/*.json).
// These ship as defaults and can be overridden, adjusted, and reset per verdict.
const BUILT_IN_VERDICT_DEFAULTS: Record<string, Record<string, VerdictDirective>> = {
  noise_detection: {
    clear: { action: 'inform', template: '', description: 'The message has discernible meaning, even if brief.' },
    unclear: { action: 'short_circuit', template: '', description: 'Gibberish, random characters, transcription artifacts, or nonsense syllables.' },
    partial: { action: 'inform', template: '', description: 'Only partially intelligible.' },
  },
  medical: {
    none: { action: 'inform', template: '', description: 'No health topic is present.' },
    low: { action: 'inform', template: '', description: 'A general health or wellness topic is mentioned (e.g. exercise, sleep).' },
    high: {
      action: 'prepend',
      template:
        "I want to be careful here — I can't give medical advice, so please check anything important with a qualified professional.",
      description: 'A specific health concern: symptoms, medication, mental health, or a request for diagnosis.',
    },
    critical: {
      action: 'override',
      template:
        "It sounds like this could be serious. If you're in danger or this is an emergency, please contact emergency services or a medical professional right now. I'm not able to give medical advice, but I want to make sure you get the right help.",
      description: 'A medical emergency or suicidal ideation.',
    },
  },
  legal: {
    none: { action: 'inform', template: '', description: 'No legal topic is present.' },
    low: { action: 'inform', template: '', description: 'A general legal topic is mentioned.' },
    high: {
      action: 'prepend',
      template:
        "Just so you know, I can't give legal advice, so please confirm anything important with a qualified professional.",
      description: 'A specific legal concern: a dispute, contract, privacy/employment matter, or a request for legal advice.',
    },
    critical: {
      action: 'override',
      template:
        "This sounds like it could carry serious legal consequences. I'm not able to give legal advice — please reach out to a qualified legal professional or the appropriate authorities.",
      description: 'Illegal activity or imminent danger.',
    },
  },
  probing: {
    no_probe: { action: 'inform', template: '', description: "The user's message is clear; no follow-up question is needed." },
    needs_clarification: { action: 'inform', template: '', description: 'A specific follow-up question would help collect a pending deliverable.' },
    gentle_redirect: { action: 'inform', template: '', description: 'The user went off-topic and should be gently steered back.' },
  },
  timekeeper: {
    on_track: { action: 'inform', template: '', description: 'The conversation is progressing normally.' },
    slowing: { action: 'inform', template: '', description: 'Some stagnation — progress is slowing.' },
    stuck: { action: 'inform', template: '', description: 'No progress; a specific redirect toward the pending deliverable is needed.' },
    force_advance: { action: 'inform', template: '', description: 'Stuck enough that the current state should be skipped.' },
  },
}

/** Deep-equality for a verdict directive map (used to detect overrides vs defaults). */
export function verdictDirectivesEqual(
  a: Record<string, VerdictDirective>,
  b: Record<string, VerdictDirective>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (
      a[k]?.action !== b[k]?.action ||
      a[k]?.template !== b[k]?.template ||
      (a[k]?.description ?? '') !== (b[k]?.description ?? '')
    )
      return false
  }
  return true
}

/** Parse "none|low|high|critical" (output_schema.verdict) into an ordered vocabulary. */
function parseVerdictVocabulary(outputSchema?: Record<string, unknown>): string[] {
  const verdict = outputSchema?.verdict
  if (typeof verdict !== 'string') return []
  return verdict.split('|').map((v) => v.trim()).filter(Boolean)
}

/** Read a stored verdict_directives override blob into the typed map. */
function readVerdictDirectives(raw: unknown): Record<string, VerdictDirective> {
  if (!raw || typeof raw !== 'object') return {}
  const result: Record<string, VerdictDirective> = {}
  for (const [verdict, dir] of Object.entries(raw as Record<string, unknown>)) {
    if (dir && typeof dir === 'object') {
      const d = dir as Record<string, unknown>
      const action = d.action
      const isValidAction =
        action === 'inform' || action === 'prepend' || action === 'override' || action === 'short_circuit'
      if (action !== undefined && !isValidAction) {
        // Don't silently downgrade a saved safety directive — surface the typo so
        // it gets noticed rather than quietly becoming "inform" (see base.py).
        console.warn(
          `Verdict "${verdict}" has unknown action "${String(action)}" — falling back to "inform".`,
        )
      }
      result[verdict] = {
        action: isValidAction ? (action as VerdictAction) : 'inform',
        template: typeof d.template === 'string' ? d.template : '',
        description: typeof d.description === 'string' ? d.description : '',
      }
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Helpers to read / write the nested configuration payload
// ---------------------------------------------------------------------------

function getExpertPoolConfig(cfg: AgentConfigurationPayload) {
  return (cfg.nodes?.expert_pool ?? {}) as Record<string, unknown>
}

function getExpertOverrides(cfg: AgentConfigurationPayload): Record<string, Record<string, unknown>> {
  const pool = getExpertPoolConfig(cfg)
  return (pool.experts ?? {}) as Record<string, Record<string, unknown>>
}

function getCustomExperts(cfg: AgentConfigurationPayload): Record<string, Record<string, unknown>> {
  const pool = getExpertPoolConfig(cfg)
  return (pool.custom_experts ?? {}) as Record<string, Record<string, unknown>>
}

function getAlwaysRun(cfg: AgentConfigurationPayload): string[] {
  const pool = getExpertPoolConfig(cfg)
  return (pool.always_run ?? [...DEFAULT_ALWAYS_RUN]) as string[]
}

function getBackgroundExperts(cfg: AgentConfigurationPayload): string[] {
  const pool = getExpertPoolConfig(cfg)
  return (pool.background_experts ?? [...DEFAULT_BACKGROUND]) as string[]
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useConfiguratorState(
  configuration: AgentConfigurationPayload,
  setConfiguration: (cfg: AgentConfigurationPayload) => void,
  _pipelineSchema: PipelineSchema,
) {
  // ----- Built-in expert defaults sourced from the agent's published declaration -----
  // The agent declares its default experts in config/experts/*.json; the backend
  // publishes them on AgentType.expertDefaults. Fall back to the hardcoded constants
  // only until the backend has been re-seeded.
  const publishedExperts = useConfiguratorStore((s) => s.expertDefaults)
  // Capability gating: task_extraction rides on `plans`, companion_router on
  // `companion`, the assessment pool on `experts`. When capabilities aren't
  // provided (older flow), show everything.
  const capabilities = useConfiguratorStore((s) => s.capabilities)
  const hasPlans = !capabilities || capabilities.includes('plans')
  const hasExperts = !capabilities || capabilities.includes('experts')
  const hasCompanion = !capabilities || capabilities.includes('companion')
  const builtInDefaults = useMemo(() => {
    const source =
      publishedExperts && publishedExperts.length
        ? builtInsFromPublished(publishedExperts)
        : builtInsFallback()
    return source.filter((e) =>
      e.name === 'task_extraction'
        ? hasPlans
        : e.name === 'companion_router'
          ? hasCompanion
          : hasExperts,
    )
  }, [publishedExperts, hasPlans, hasExperts, hasCompanion])
  const builtInNames = useMemo(() => new Set(builtInDefaults.map((e) => e.name)), [builtInDefaults])

  // ----- Raw reads from configuration -----
  const overrides = useMemo(() => getExpertOverrides(configuration), [configuration])
  const customs = useMemo(() => getCustomExperts(configuration), [configuration])
  const alwaysRun = useMemo(() => getAlwaysRun(configuration), [configuration])
  const backgroundExperts = useMemo(() => getBackgroundExperts(configuration), [configuration])

  const alwaysRunSet = useMemo(() => new Set(alwaysRun), [alwaysRun])
  const backgroundSet = useMemo(() => new Set(backgroundExperts), [backgroundExperts])

  // ----- Unified expert list -----
  const experts: ExpertDefinition[] = useMemo(() => {
    const result: ExpertDefinition[] = []

    // Built-in experts
    for (const builtin of builtInDefaults) {
      const ov = overrides[builtin.name] ?? {}
      result.push({
        name: builtin.name,
        description: (ov.description as string) ?? builtin.description,
        enabled: ov.enabled !== undefined ? Boolean(ov.enabled) : true,
        alwaysTriggered: ov.always_triggered !== undefined ? Boolean(ov.always_triggered) : builtin.alwaysTriggered,
        triggerCriteria: (ov.trigger_criteria as string) ?? builtin.triggerCriteria,
        model: (ov.model as string) ?? builtin.model,
        temperature: ov.temperature !== undefined ? Number(ov.temperature) : builtin.temperature,
        maxTokens: ov.max_tokens !== undefined ? Number(ov.max_tokens) : builtin.maxTokens,
        // Preserve override presence: a missing key inherits the default,
        // while an explicit '' is kept as an intentional empty prompt (#174).
        systemPrompt: ov.system_prompt !== undefined ? (ov.system_prompt as string) : undefined,
        defaultSystemPrompt: builtin.defaultSystemPrompt,
        historyLimit: ov.history_limit !== undefined ? Number(ov.history_limit) : builtin.historyLimit,
        minConfidence: ov.min_confidence !== undefined ? Number(ov.min_confidence) : builtin.minConfidence,
        arbitrationPriority: ov.priority !== undefined ? Number(ov.priority) : builtin.arbitrationPriority,
        isBackground: backgroundSet.has(builtin.name),
        isCustom: false,
        canCallFunctions: builtin.canCallFunctions,
        outputSchema: (ov.output_schema as Record<string, unknown> | undefined) ?? builtin.outputSchema,
        verdictVocabulary: builtin.verdictVocabulary,
        verdictDirectives:
          ov.verdict_directives !== undefined
            ? readVerdictDirectives(ov.verdict_directives)
            : builtin.defaultVerdictDirectives,
        defaultVerdictDirectives: builtin.defaultVerdictDirectives,
      })
    }

    // Custom experts (assessment experts → gated on the `experts` capability)
    for (const [name, def] of hasExperts ? Object.entries(customs) : []) {
      result.push({
        name,
        description: (def.description as string) ?? '',
        enabled: def.enabled !== undefined ? Boolean(def.enabled) : true,
        alwaysTriggered: Boolean(def.always_triggered),
        triggerCriteria: (def.trigger_criteria as string) ?? '',
        model: (def.model as string) ?? 'gpt-4o-mini',
        temperature: def.temperature !== undefined ? Number(def.temperature) : 0.3,
        maxTokens: def.max_tokens !== undefined ? Number(def.max_tokens) : 200,
        systemPrompt: def.system_prompt !== undefined ? (def.system_prompt as string) : undefined,
        defaultSystemPrompt: '',
        historyLimit: def.history_limit !== undefined ? Number(def.history_limit) : 0,
        minConfidence: def.min_confidence !== undefined ? Number(def.min_confidence) : 0,
        arbitrationPriority: def.priority !== undefined ? Number(def.priority) : 50,
        isBackground: backgroundSet.has(name),
        isCustom: true,
        canCallFunctions: false,
        outputSchema: def.output_schema as Record<string, unknown> | undefined,
        verdictVocabulary: parseVerdictVocabulary(def.output_schema as Record<string, unknown> | undefined),
        verdictDirectives: readVerdictDirectives(def.verdict_directives),
        defaultVerdictDirectives: {},
      })
    }

    // Sort by priority descending
    result.sort((a, b) => b.arbitrationPriority - a.arbitrationPriority)

    return result
  }, [overrides, customs, backgroundSet, builtInDefaults, hasExperts])

  // ----- Derived views -----

  /** Enabled foreground experts sorted by priority */
  const poolExperts = useMemo(
    () => experts.filter((e) => e.enabled && !e.isBackground),
    [experts],
  )

  /** Enabled background experts */
  const bgExperts = useMemo(
    () => experts.filter((e) => e.enabled && e.isBackground),
    [experts],
  )

  /** Disabled experts */
  const disabledExperts = useMemo(
    () => experts.filter((e) => !e.enabled),
    [experts],
  )

  /** Input gate trigger rules (excludes task_extraction and always_triggered experts) */
  const inputGateRules: InputGateRule[] = useMemo(
    () =>
      experts
        .filter((e) => e.enabled && !e.isBackground && !e.alwaysTriggered && e.triggerCriteria)
        .map((e) => ({ expertName: e.name, criteria: e.triggerCriteria })),
    [experts],
  )

  /** Arbitration priority order (only foreground enabled experts) */
  const arbitrationOrder = useMemo(
    () => poolExperts.map((e) => e.name),
    [poolExperts],
  )

  /** Task extraction enabled state */
  const taskExtractionEnabled = useMemo(
    () => experts.find((e) => e.name === 'task_extraction')?.enabled ?? true,
    [experts],
  )

  /** The companion router, when this agent supports companion mode.
   *
   * Deliberately has NO enabled state here. The agent forces it on in companion
   * mode and off otherwise, AFTER applying this configuration, so any toggle the
   * Configurator offered would be a lie: the deploy mode decides. What IS worth
   * editing is how it decides — its model and its prompt. */
  const companionRouter = useMemo(
    () => experts.find((e) => e.name === 'companion_router'),
    [experts],
  )

  // ----- Mutation helpers -----

  const patchExpertPool = useCallback(
    (patch: Record<string, unknown>) => {
      const pool = { ...getExpertPoolConfig(configuration), ...patch }
      setConfiguration({
        ...configuration,
        nodes: {
          ...(configuration.nodes ?? {}),
          expert_pool: pool,
        },
      })
    },
    [configuration, setConfiguration],
  )

  /** Update a single built-in expert's overrides */
  const updateExpert = useCallback(
    (name: string, updates: Partial<ExpertDefinition>) => {
      if (builtInNames.has(name)) {
        const current = { ...getExpertOverrides(configuration) }
        const existing = { ...(current[name] ?? {}) }

        if (updates.enabled !== undefined) existing.enabled = updates.enabled
        if (updates.alwaysTriggered !== undefined) {
          existing.always_triggered = updates.alwaysTriggered
          // Always-triggered bypasses the input gate, so trigger criteria is moot.
          // Clear any stale rule so it isn't fed back into the input-gate prompt,
          // matching the create path (#175).
          if (updates.alwaysTriggered) existing.trigger_criteria = ''
        }
        if (updates.triggerCriteria !== undefined) existing.trigger_criteria = updates.triggerCriteria
        if (updates.model !== undefined) existing.model = updates.model
        if (updates.temperature !== undefined) existing.temperature = updates.temperature
        if (updates.maxTokens !== undefined) existing.max_tokens = updates.maxTokens
        // `systemPrompt: undefined` removes the override (inherit default);
        // `''` keeps an explicit empty prompt (#174). A missing key = no change.
        if ('systemPrompt' in updates) {
          if (updates.systemPrompt === undefined) delete existing.system_prompt
          else existing.system_prompt = updates.systemPrompt
        }
        if (updates.historyLimit !== undefined) existing.history_limit = updates.historyLimit
        if (updates.minConfidence !== undefined) existing.min_confidence = updates.minConfidence
        if (updates.arbitrationPriority !== undefined) existing.priority = updates.arbitrationPriority
        if (updates.description !== undefined) existing.description = updates.description
        // `verdictDirectives: undefined` clears the override (revert to shipped defaults);
        // a map persists the full effective set. A missing key = no change.
        if ('verdictDirectives' in updates) {
          if (updates.verdictDirectives === undefined) delete existing.verdict_directives
          else existing.verdict_directives = updates.verdictDirectives
        }

        current[name] = existing
        patchExpertPool({ experts: current })
      } else {
        // Custom expert
        const current = { ...getCustomExperts(configuration) }
        const existing = { ...(current[name] ?? {}) }

        if (updates.enabled !== undefined) existing.enabled = updates.enabled
        if (updates.alwaysTriggered !== undefined) {
          existing.always_triggered = updates.alwaysTriggered
          // Always-triggered bypasses the input gate, so trigger criteria is moot.
          // Clear any stale rule so it isn't fed back into the input-gate prompt,
          // matching the create path (#175).
          if (updates.alwaysTriggered) existing.trigger_criteria = ''
        }
        if (updates.triggerCriteria !== undefined) existing.trigger_criteria = updates.triggerCriteria
        if (updates.model !== undefined) existing.model = updates.model
        if (updates.temperature !== undefined) existing.temperature = updates.temperature
        if (updates.maxTokens !== undefined) existing.max_tokens = updates.maxTokens
        if ('systemPrompt' in updates) {
          if (updates.systemPrompt === undefined) delete existing.system_prompt
          else existing.system_prompt = updates.systemPrompt
        }
        if (updates.historyLimit !== undefined) existing.history_limit = updates.historyLimit
        if (updates.minConfidence !== undefined) existing.min_confidence = updates.minConfidence
        if (updates.arbitrationPriority !== undefined) existing.priority = updates.arbitrationPriority
        if (updates.description !== undefined) existing.description = updates.description
        // `verdictDirectives: undefined` clears the override (revert to shipped defaults);
        // a map persists the full effective set. A missing key = no change.
        if ('verdictDirectives' in updates) {
          if (updates.verdictDirectives === undefined) delete existing.verdict_directives
          else existing.verdict_directives = updates.verdictDirectives
        }

        current[name] = existing
        patchExpertPool({ custom_experts: current })
      }
    },
    [configuration, patchExpertPool, builtInNames],
  )

  /** Reorder experts by name array — derives priorities from position.
   *  Two-way: used by both sidebar drag and arbitration node drag. */
  const reorderExperts = useCallback(
    (orderedNames: string[]) => {
      const builtinOverrides = { ...getExpertOverrides(configuration) }
      const customDefs = { ...getCustomExperts(configuration) }

      orderedNames.forEach((name, index) => {
        const priority = 100 - index * 5
        if (builtInNames.has(name)) {
          builtinOverrides[name] = { ...(builtinOverrides[name] ?? {}), priority }
        } else if (customDefs[name]) {
          customDefs[name] = { ...customDefs[name], priority }
        }
      })

      patchExpertPool({ experts: builtinOverrides, custom_experts: customDefs })
    },
    [configuration, patchExpertPool, builtInNames],
  )

  /** Add a new custom expert */
  const addCustomExpert = useCallback(
    (expert: { name: string; description: string; model: string; temperature: number; maxTokens: number; systemPrompt: string; triggerCriteria?: string; alwaysTriggered?: boolean }) => {
      const current = { ...getCustomExperts(configuration) }
      const alwaysTriggered = Boolean(expert.alwaysTriggered)
      current[expert.name] = {
        name: expert.name,
        description: expert.description,
        priority: 50,
        model: expert.model,
        temperature: expert.temperature,
        max_tokens: expert.maxTokens,
        system_prompt: expert.systemPrompt,
        output_format: '{"verdict":"...","confidence":0.0,"recommendation":"short"}',
        // When always-triggered, the input gate ignores it, so trigger criteria is moot (#175).
        trigger_criteria: alwaysTriggered ? '' : (expert.triggerCriteria ?? ''),
        enabled: true,
        always_triggered: alwaysTriggered,
      }
      patchExpertPool({ custom_experts: current })
    },
    [configuration, patchExpertPool],
  )

  /** Remove a custom expert */
  const removeExpert = useCallback(
    (name: string) => {
      if (builtInNames.has(name)) return // Cannot remove built-in experts

      const current = { ...getCustomExperts(configuration) }
      delete current[name]

      // Also remove from always_run and background
      const ar = getAlwaysRun(configuration).filter((n) => n !== name)
      const bg = getBackgroundExperts(configuration).filter((n) => n !== name)

      patchExpertPool({ custom_experts: current, always_run: ar, background_experts: bg })
    },
    [configuration, patchExpertPool, builtInNames],
  )

  /** Toggle task_extraction on/off */
  const toggleTaskExtraction = useCallback(
    (enabled: boolean) => {
      updateExpert('task_extraction', { enabled })

      if (enabled) {
        // Ensure it's in always_run and background
        const ar = getAlwaysRun(configuration)
        const bg = getBackgroundExperts(configuration)
        const patch: Record<string, unknown> = {}
        if (!ar.includes('task_extraction')) patch.always_run = [...ar, 'task_extraction']
        if (!bg.includes('task_extraction')) patch.background_experts = [...bg, 'task_extraction']
        if (Object.keys(patch).length > 0) patchExpertPool(patch)
      }
    },
    [configuration, patchExpertPool, updateExpert],
  )

  /** Move an expert to/from background */
  const setExpertBackground = useCallback(
    (name: string, isBackground: boolean) => {
      const bg = getBackgroundExperts(configuration)
      if (isBackground && !bg.includes(name)) {
        patchExpertPool({ background_experts: [...bg, name] })
      } else if (!isBackground && bg.includes(name)) {
        patchExpertPool({ background_experts: bg.filter((n) => n !== name) })
      }
    },
    [configuration, patchExpertPool],
  )

  /** Toggle always_run for an expert */
  const toggleAlwaysRun = useCallback(
    (name: string) => {
      const ar = getAlwaysRun(configuration)
      if (ar.includes(name)) {
        patchExpertPool({ always_run: ar.filter((n) => n !== name) })
      } else {
        patchExpertPool({ always_run: [...ar, name] })
      }
    },
    [configuration, patchExpertPool],
  )

  /** Update a non-expert pipeline node config (e.g. input_gate.model, response_generator.persona) */
  const updateNodeConfig = useCallback(
    (nodeId: string, slotId: string, value: unknown) => {
      const currentNode = { ...((configuration.nodes?.[nodeId] ?? {}) as Record<string, unknown>) }

      // `undefined`/`null` removes the override (inherit default). An explicit ''
      // is a deliberate empty value and must be persisted, not collapsed (#174).
      if (value === undefined || value === null) {
        delete currentNode[slotId]
      } else {
        currentNode[slotId] = value
      }

      setConfiguration({
        ...configuration,
        nodes: {
          ...(configuration.nodes ?? {}),
          [nodeId]: currentNode,
        },
      })
    },
    [configuration, setConfiguration],
  )

  /** Update a threshold value */
  const updateThreshold = useCallback(
    (thresholdId: string, value: number | undefined) => {
      const current = { ...((configuration.thresholds ?? {}) as Record<string, unknown>) }

      if (value === undefined) {
        delete current[thresholdId]
      } else {
        current[thresholdId] = value
      }

      setConfiguration({
        ...configuration,
        thresholds: current,
      })
    },
    [configuration, setConfiguration],
  )

  return {
    // Derived state
    experts,
    poolExperts,
    bgExperts,
    disabledExperts,
    inputGateRules,
    arbitrationOrder,
    taskExtractionEnabled,
    companionRouter,
    alwaysRunSet,

    // Mutations
    updateExpert,
    reorderExperts,
    addCustomExpert,
    removeExpert,
    toggleTaskExtraction,
    setExpertBackground,
    toggleAlwaysRun,
    updateNodeConfig,
    updateThreshold,
  }
}
