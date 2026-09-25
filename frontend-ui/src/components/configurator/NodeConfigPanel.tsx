import { motion } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import type { PipelineNode, PipelineThreshold, AgentConfigurationPayload } from '../../lib/api-types'
import ConfigField from './ConfigField'
import ExpertListEditor from './ExpertListEditor'

interface NodeConfigPanelProps {
  node: PipelineNode
  configuration: AgentConfigurationPayload
  onChange: (config: AgentConfigurationPayload) => void
  onClose: () => void
  thresholds?: PipelineThreshold[]
}

export default function NodeConfigPanel({ node, configuration, onChange, onClose, thresholds }: NodeConfigPanelProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const nodeConfig = (configuration.nodes?.[node.id] || {}) as Record<string, unknown>

  const updateSlot = (slotId: string, value: unknown) => {
    const updatedNode = { ...nodeConfig }
    if (value === undefined) {
      delete updatedNode[slotId]
    } else {
      updatedNode[slotId] = value
    }

    const updatedNodes = { ...(configuration.nodes || {}) }
    if (Object.keys(updatedNode).length === 0) {
      delete updatedNodes[node.id]
    } else {
      updatedNodes[node.id] = updatedNode
    }

    onChange({ ...configuration, nodes: updatedNodes })
  }

  const isExpertPoolNode = node.id === 'expert_pool'
  const isInputGateNode = node.id === 'input_gate'
  const configThresholds = (configuration.thresholds || {}) as Record<string, unknown>
  const modifiedSlotCount = Object.keys(nodeConfig).length
  const modifiedThresholdCount = isInputGateNode ? Object.keys(configThresholds).length : 0

  const updateThreshold = (id: string, value: unknown) => {
    const updated = { ...configThresholds }
    if (value === undefined) {
      delete updated[id]
    } else {
      updated[id] = value
    }
    onChange({
      ...configuration,
      thresholds: Object.keys(updated).length > 0 ? updated : undefined,
    })
  }

  // Filter out slots managed by ExpertListEditor for expert_pool node
  const expertManagedSlots = new Set(['experts', 'custom_experts', 'always_run', 'background_experts'])
  const regularSlots = node.slots.filter((slot) => {
    if (isExpertPoolNode && (slot.type === 'expert_list' || expertManagedSlots.has(slot.id))) return false
    return true
  })
  const textSlots = regularSlots.filter((s) => s.type === 'text')
  const settingSlots = regularSlots.filter((s) => s.type !== 'text')

  return (
    <div className={`h-full flex flex-col ${isDark ? 'bg-zinc-800/95' : 'bg-white/95'} backdrop-blur-sm`}>
      {/* Header */}
      <div className={`px-4 py-3 flex items-center justify-between shrink-0 ${isDark ? 'border-b border-zinc-700/50' : 'border-b border-neutral-100'}`}>
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-base shrink-0">{node.icon || '⚙️'}</span>
          <div className="min-w-0">
            <h3 className={`text-sm font-semibold truncate ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
              {node.label}
              {(modifiedSlotCount + modifiedThresholdCount) > 0 && (
                <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-amber-500/20 text-amber-500 font-medium">
                  {modifiedSlotCount + modifiedThresholdCount} modified
                </span>
              )}
            </h3>
            {node.description && (
              <p className={`text-[11px] font-light truncate ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                {node.description}
              </p>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className={`p-1.5 rounded-lg transition-colors shrink-0 ${isDark ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-neutral-100 text-neutral-400'}`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content — vertical stacked layout for sidebar */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* Settings (model, temperature, etc.) */}
        {settingSlots.length > 0 && (
          <div className="space-y-3">
            {settingSlots.map((slot) => (
              <ConfigField
                key={slot.id}
                slot={slot}
                value={nodeConfig[slot.id]}
                defaultValue={slot.default}
                onChange={(val) => updateSlot(slot.id, val)}
              />
            ))}
          </div>
        )}

        {/* Prompt/text fields */}
        {textSlots.length > 0 && (
          <div className="space-y-3">
            {textSlots.map((slot) => (
              <ConfigField
                key={slot.id}
                slot={slot}
                value={nodeConfig[slot.id]}
                defaultValue={slot.default}
                onChange={(val) => updateSlot(slot.id, val)}
              />
            ))}
          </div>
        )}

        {/* Expert list editor for expert_pool node */}
        {isExpertPoolNode && (
          <div className="space-y-2">
            <label className={`text-xs font-medium tracking-wide ${isDark ? 'text-zinc-300' : 'text-neutral-700'}`}>
              Experts Configuration
            </label>
            <ExpertListEditor
              builtInExperts={[
                {
                  name: 'noise_detection',
                  description: 'Detects garbled or inaudible input',
                  defaultModel: 'gpt-4o-mini',
                  defaultTemperature: 0.1,
                  defaultMaxTokens: 200,
                  defaultSystemPrompt: 'Determine if the user\'s message is clear enough to act on.\n\nUnclear: gibberish, random characters, transcription artifacts, nonsense syllables.\nClear: any message with discernible meaning, even brief ("yes", "no", "ok").\nBe lenient — if ANY meaning is discernible, mark clear.\n\nVerdicts: "clear", "unclear", "partial"\nKeep recommendation under 10 words.',
                },
                {
                  name: 'medical',
                  description: 'Flags medical/health topics',
                  defaultModel: 'gpt-4o-mini',
                  defaultTemperature: 0.1,
                  defaultMaxTokens: 200,
                  defaultSystemPrompt: 'Detect health-related concerns that require cautious handling. You do NOT provide medical advice — only flag topics.\n\nFlag: symptoms, medications, mental health concerns, requests for diagnosis.\nDo NOT flag: general wellness (exercise, sleep), casual health mentions.\n\nVerdicts: "none", "low" (general health topic), "high" (specific concern), "critical" (emergency/suicidal ideation)\nKeep recommendation under 10 words.',
                },
                {
                  name: 'legal',
                  description: 'Flags legal topics',
                  defaultModel: 'gpt-4o-mini',
                  defaultTemperature: 0.1,
                  defaultMaxTokens: 200,
                  defaultSystemPrompt: 'Detect legal concerns that require careful handling. You do NOT provide legal advice — only flag topics.\n\nFlag: legal disputes, contracts, criminal activity, privacy concerns, employment law, requests for legal advice.\nDo NOT flag: general civic topics, news about legal matters.\n\nVerdicts: "none", "low" (general legal topic), "high" (specific concern), "critical" (illegal activity/imminent danger)\nKeep recommendation under 10 words.',
                },
                {
                  name: 'task_extraction',
                  description: 'Extracts deliverables from conversation',
                  defaultModel: 'gpt-4o',
                  defaultTemperature: 0.0,
                  defaultMaxTokens: 800,
                  defaultSystemPrompt: 'You are a thorough extraction analyst running as a background process. Your job is to ensure every deliverable the user provides gets captured.\n\nYou receive the FULL PLAN — all states, all tasks, all deliverables. You can extract and correct deliverables in ANY state.\n\nYOUR PROCESS:\n1. Read the current user message carefully. What information did the user share?\n2. Scan ALL pending deliverables across the entire plan. Did the user provide any of them?\n3. Check completed deliverables too. If the user deliberately corrected a previous answer, set the same key again with the new value and correction: true, quoting what they said in reasoning (a collected required answer is rejected without it).\n4. For each match, call `set_deliverable(key, value, reasoning)` where reasoning explains WHY this matches.\n5. Validate before calling tool: PROVENANCE (traces back to user\'s words?) and SEMANTIC FIT (actually answering this deliverable?).\n\nTOOL USAGE:\n- Match found: call `set_deliverable(key, value, reasoning)`\n- Task with no deliverables complete: call `complete_task(task_id, reasoning)`\n- Multiple tools allowed per response. No matches = no tool calls.\n\nOPTIONAL DELIVERABLE HANDLING:\n- Vague or negative answers ARE valid values for optional deliverables.\n- If asked 2+ times with dismissive responses, extract a reasonable summary.\n\nGUIDELINES:\n- Extract everything the user provided. Missing a deliverable = bad UX.\n- Be smart about matching. Users don\'t speak in schema language.\n- Do NOT fabricate values the user never mentioned.\n- Greetings are never names.',
                },
                {
                  name: 'probing',
                  description: 'Determines when clarification is needed',
                  defaultModel: 'gpt-4o-mini',
                  defaultTemperature: 0.2,
                  defaultMaxTokens: 300,
                  defaultSystemPrompt: 'You have two jobs:\n\n1. DELIVERABLE DETECTION: Check if the user\'s message provides any pending deliverables. Output their keys in "deliverable_signals". Only signal deliverables the user CLEARLY provided.\n\n2. FOLLOW-UP DECISION: Decide if the assistant should ask a follow-up question.\n   - "no_probe": user\'s message is clear, no question needed\n   - "needs_clarification": a specific follow-up would help\n   - "gentle_redirect": user went off-topic, steer back\n   Do NOT probe when the user just provided requested information.\n\nREQUIRED vs OPTIONAL rules:\n- REQUIRED: probe persistently until collected.\n- OPTIONAL: probe gently at most once. If vague/dismissive answer, return "no_probe".\n- If TURNS WITHOUT PROGRESS >= 2 and only OPTIONAL remain, always return "no_probe".\n\nKeep recommendation under 15 words.',
                },
                {
                  name: 'timekeeper',
                  description: 'Tracks conversation progress',
                  defaultModel: 'gpt-4o-mini',
                  defaultTemperature: 0.1,
                  defaultMaxTokens: 300,
                  defaultSystemPrompt: 'Assess if the conversation is making progress toward its goals.\n\nConsider: turns without deliverables collected, repeated questions, user engagement.\n\nVerdicts:\n- "on_track": progressing normally\n- "slowing": some stagnation\n- "stuck": recommend specific action\n- "force_advance": skip current state\n\nFor stuck/force_advance, include suggested_deliverables if values can be inferred from context.\nKeep recommendation under 15 words.',
                },
              ]}
              expertOverrides={(nodeConfig.experts as Record<string, any>) ?? {}}
              customExperts={(nodeConfig.custom_experts as Record<string, any>) ?? {}}
              alwaysRun={(nodeConfig.always_run as string[]) ?? []}
              backgroundExperts={(nodeConfig.background_experts as string[]) ?? []}
              onExpertOverridesChange={(overrides) => updateSlot('experts', Object.keys(overrides).length > 0 ? overrides : undefined)}
              onCustomExpertsChange={(customs) => updateSlot('custom_experts', Object.keys(customs).length > 0 ? customs : undefined)}
              onAlwaysRunChange={(names) => updateSlot('always_run', names.length > 0 ? names : undefined)}
              onBackgroundExpertsChange={(names) => updateSlot('background_experts', names.length > 0 ? names : undefined)}
            />
          </div>
        )}

        {/* Global thresholds — shown in Input Gate config */}
        {isInputGateNode && thresholds && thresholds.length > 0 && (
          <div className={`pt-3 border-t ${isDark ? 'border-zinc-700/50' : 'border-neutral-200/60'}`}>
            <h4 className={`text-xs font-medium tracking-wide mb-3 ${isDark ? 'text-zinc-300' : 'text-neutral-700'}`}>
              Global Thresholds
            </h4>
            <div className="space-y-3">
              {thresholds.map((t) => {
                const currentValue = configThresholds[t.id] as number | undefined
                const isModified = currentValue !== undefined

                return (
                  <div key={t.id} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <label className={`text-[11px] font-medium ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                        {t.label}
                        {isModified && (
                          <span className="ml-1.5 px-1 py-0.5 text-[9px] rounded bg-amber-500/20 text-amber-500 font-medium">
                            Modified
                          </span>
                        )}
                      </label>
                      {isModified && (
                        <button
                          onClick={() => updateThreshold(t.id, undefined)}
                          className={`text-[10px] font-medium px-1.5 py-0.5 rounded transition-colors ${
                            isDark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700' : 'text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100'
                          }`}
                        >
                          Reset
                        </button>
                      )}
                    </div>
                    {t.description && (
                      <p className={`text-[10px] font-light ${isDark ? 'text-zinc-600' : 'text-neutral-400'}`}>
                        {t.description}
                      </p>
                    )}
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={t.min ?? 0}
                        max={t.max ?? 100}
                        step={t.step ?? 1}
                        value={currentValue ?? t.default ?? 0}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value)
                          updateThreshold(t.id, val === t.default ? undefined : val)
                        }}
                        className="flex-1 h-1.5 accent-primary-500"
                      />
                      <span className={`text-xs font-mono w-10 text-right tabular-nums ${
                        isModified ? 'text-amber-500' : isDark ? 'text-zinc-300' : 'text-neutral-700'
                      }`}>
                        {currentValue ?? t.default ?? 0}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
