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

// Structural experts: not part of the arbitration pool, not reordered, not
// opted into. Each IS the mechanism of a mode — task_extraction executes plans,
// companion_router executes companion mode — so both always run within their
// mode and neither competes for arbitration priority.
const STRUCTURAL_EXPERTS = new Set(['task_extraction', 'companion_router'])

const DEFAULT_ALWAYS_RUN = new Set(STRUCTURAL_EXPERTS)
const DEFAULT_BACKGROUND = new Set(STRUCTURAL_EXPERTS)

// The built-in default shape the expert list is derived from: the agent's
// published config/experts/*.json.
interface BuiltInExpertDefault {
  name: string
  description: string
  alwaysTriggered: boolean
  triggerCriteria: string
  model: string
  temperature: number
  maxTokens: number
  defaultSystemPrompt: string
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
      model: raw.model ?? 'gpt-5.4-mini',
      temperature: raw.temperature ?? 0.1,
      maxTokens: raw.max_tokens ?? 200,
      defaultSystemPrompt: raw.system_prompt ?? '',
      minConfidence: raw.min_confidence ?? 0,
      arbitrationPriority: raw.priority ?? 50,
      canCallFunctions: Boolean(raw.can_call_functions),
      outputSchema: raw.output_schema,
      verdictVocabulary: vocab,
      defaultVerdictDirectives: directives,
    }
  })
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
      (a[k]?.description ?? '') !== (b[k]?.description ?? '') ||
      !templateI18nEqual(a[k]?.template_i18n, b[k]?.template_i18n)
    )
      return false
  }
  return true
}

function templateI18nEqual(a?: Record<string, string>, b?: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
  for (const k of keys) if (a?.[k] !== b?.[k]) return false
  return true
}

/** Parse "none|low|high|critical" (output_schema.verdict) into an ordered vocabulary. */
function parseVerdictVocabulary(outputSchema?: Record<string, unknown>): string[] {
  const verdict = outputSchema?.verdict
  if (typeof verdict !== 'string') return []
  return verdict.split('|').map((v) => v.trim()).filter(Boolean)
}

/** Read a stored verdict_directives override blob into the typed map. */
export function readVerdictDirectives(raw: unknown): Record<string, VerdictDirective> {
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
      const i18n = readTemplateI18n(d.template_i18n)
      if (i18n) result[verdict].template_i18n = i18n
    }
  }
  return result
}

/** Keep only string translations of a verdict template (#75); none → undefined. */
function readTemplateI18n(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (e): e is [string, string] => typeof e[1] === 'string',
  )
  return entries.length ? Object.fromEntries(entries) : undefined
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

// No agent reads always_run or background_experts and no agent declares them,
// so the backend refuses them (#996) and drops them from saved configurations.
// Nothing here writes them; a configuration saved before still shows its lists.
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
    // The agent's own config/experts/*.json, published on its agent type, are the
    // only defaults: the Configurator keeps no copy of an expert's prompt.
    const source = builtInsFromPublished(publishedExperts ?? [])
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
        model: (def.model as string) ?? 'gpt-5.4-mini',
        temperature: def.temperature !== undefined ? Number(def.temperature) : 0.3,
        maxTokens: def.max_tokens !== undefined ? Number(def.max_tokens) : 200,
        systemPrompt: def.system_prompt !== undefined ? (def.system_prompt as string) : undefined,
        defaultSystemPrompt: '',
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

      patchExpertPool({ custom_experts: current })
    },
    [configuration, patchExpertPool, builtInNames],
  )

  /** Toggle task_extraction on/off */
  const toggleTaskExtraction = useCallback(
    (enabled: boolean) => {
      updateExpert('task_extraction', { enabled })
    },
    [updateExpert],
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
    updateNodeConfig,
    updateThreshold,
  }
}
