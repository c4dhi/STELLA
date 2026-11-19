/**
 * NodeDetailOverlay — click-to-edit overlay for one pipeline stage's settings.
 *
 * Drawn entirely from the settings the agent declares for the stage (#996):
 * the `settings` list its pipelineSchema carries, keyed `<stage>.<name>`. Which
 * control a setting gets follows from its type, never from the agent or the
 * stage: text is a PromptComposer block with {{placeholder}} support, numbers,
 * choices and switches sit in a settings grid, and an expert list shows the
 * experts the Expert Module sidebar edits. Defaults, ranges and choices come
 * from the declaration, so nothing here repeats an agent's defaults.
 */

import { useState, Fragment } from 'react'
import type { JSX } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { PipelineNode as PipelineNodeType, AgentConfigurationPayload, ConfigSetting } from '../../lib/api-types'
import type { ExpertDefinition } from './useConfiguratorState'
import { PromptComposer, type PromptBlock } from './PromptComposer'

/** Types drawn as one field each in a settings grid. */
const FIELD_TYPES = new Set(['number', 'integer', 'enum', 'boolean', 'string'])
/** Types shown, but not edited, here (#996 keeps their editors for later). */
const SHOWN_TYPES = new Set(['key_value', 'string_list'])

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
  /** The settings the agent declares for this stage (keys `<node.id>.<name>`). */
  settings: ConfigSetting[]
  configuration: AgentConfigurationPayload
  onUpdateNodeConfig: (nodeId: string, slotId: string, value: unknown) => void
  onClose: () => void
  isDark: boolean
  /** For a stage with an expert list: the experts, as the sidebar edits them. */
  experts?: ExpertDefinition[]
}

/** Collapsible grouped settings card.
 *  Extracted to module level so React preserves its identity (and open state)
 *  across parent re-renders triggered by config edits. */
function SettingsGrid({ children, isDark, title = 'Model Settings', defaultOpen = false }: {
  children: React.ReactNode
  isDark: boolean
  title?: string
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
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
          {title}
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
  settings,
  configuration,
  onUpdateNodeConfig,
  onClose,
  isDark,
  experts = [],
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

  /** A setting's name within the stage: `expert_pool.ask_threshold` → `ask_threshold`. */
  const nameOf = (s: ConfigSetting) => s.key.slice(node.id.length + 1)

  const getSlotDefault = (slotId: string) => {
    return settings.find((s) => nameOf(s) === slotId)?.default
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
    /** Turns the select's text into the stored value (a boolean for a switch). */
    parse?: (raw: string) => unknown
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
            onChange={(e) => onUpdateNodeConfig(node.id, slotId, e.target.value ? (options?.parse ? options.parse(e.target.value) : e.target.value) : undefined)}
            className={inputClass}
          >
            <option value="">Default{defaultVal !== undefined && defaultVal !== null && defaultVal !== '' ? ` (${String(defaultVal)})` : ''}</option>
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

  const renderExperts = () => {
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

  const renderField = (s: ConfigSetting) => {
    const name = nameOf(s)
    const label = (s.label ?? name) + (s.unit ? ` (${s.unit})` : '')
    const common = { helperText: s.description }
    switch (s.type) {
      case 'number':
        return renderSlotField(name, label, 'number', { ...common, min: s.min, max: s.max, step: s.step })
      case 'integer':
        return renderSlotField(name, label, 'number', { ...common, min: s.min, max: s.max, step: s.step ?? 1 })
      case 'enum':
        return renderSlotField(name, label, 'select', { ...common, selectOptions: (s.options ?? []).map((o) => o.value) })
      case 'boolean':
        return renderSlotField(name, label, 'select', { ...common, selectOptions: ['true', 'false'], parse: (raw) => raw === 'true' })
      default:
        return renderSlotField(name, label, 'text', common)
    }
  }

  const renderShown = (s: ConfigSetting) => {
    const value = (getSlotValue(nameOf(s)) ?? s.default) as unknown
    const entries = Array.isArray(value)
      ? value.map((v, i) => [String(i + 1), String(v)])
      : value && typeof value === 'object'
        ? Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])
        : []
    return (
      <ReadOnlySection key={s.key} title={s.label ?? nameOf(s)}>
        {entries.length === 0 ? (
          <span className="italic">Empty</span>
        ) : (
          <div className="space-y-1">
            {entries.map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <span className="font-mono shrink-0">{k}</span>
                <span className="truncate">{v}</span>
              </div>
            ))}
          </div>
        )}
      </ReadOnlySection>
    )
  }

  /** Every setting the stage declares, each drawn by its type. */
  const renderSettings = () => {
    const prompts = settings.filter((s) => s.type === 'text')
    const fields = settings.filter((s) => FIELD_TYPES.has(s.type))
    const shown = settings.filter((s) => SHOWN_TYPES.has(s.type))
    const hasExperts = settings.some((s) => s.type === 'expert_list')

    // Fields by their declared group, in order of appearance; advanced ones last.
    const groups = new Map<string, ConfigSetting[]>()
    for (const s of [...fields.filter((f) => !f.advanced), ...fields.filter((f) => f.advanced)]) {
      const title = s.group ?? 'Settings'
      groups.set(title, [...(groups.get(title) ?? []), s])
    }

    const blocks: PromptBlock[] = prompts.map((s) => {
      const v = getSlotValue(nameOf(s))
      const isOverridden = v !== undefined && v !== null
      return {
        id: s.key,
        type: 'editable' as const,
        label: s.label ?? nameOf(s),
        headerHint: s.description,
        value: isOverridden ? String(v) : undefined,
        defaultValue: typeof s.default === 'string' ? s.default : '',
        onChange: (val: string) => onUpdateNodeConfig(node.id, nameOf(s), val),
        onReset: () => onUpdateNodeConfig(node.id, nameOf(s), undefined),
        // A short text (a few sentences) needs a few rows, a prompt needs many.
        rows: s.maxLength !== undefined && s.maxLength <= 2000 ? 5 : 18,
      }
    })

    return (
      <div className="space-y-6">
        {hasExperts && renderExperts()}
        {blocks.length > 0 && <PromptComposer blocks={blocks} isDark={isDark} />}
        {[...groups.entries()].map(([title, group]) => (
          <SettingsGrid key={title} isDark={isDark} title={title} defaultOpen>
            {group.map((s) => (
              <Fragment key={s.key}>{renderField(s)}</Fragment>
            ))}
          </SettingsGrid>
        ))}
        {shown.map(renderShown)}
      </div>
    )
  }

  const editable = settings.some((s) => s.type !== 'verdict_directives')
  const renderContent = editable ? renderSettings : undefined

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
