/**
 * The settings an agent type declares (#585), one control each, in tabs: a tab
 * per group, required keys first, advanced ones last, and a Custom tab for the
 * key/value pairs the agent does not declare. Controlled: `values` holds only
 * what is set; a setting missing from it follows the agent's default.
 */
import { useMemo, useState, type ReactNode } from 'react'
import {
  defaultLabel,
  settingsTabs,
  type EnvVarSetting,
} from '../../../lib/agentSettings'

export interface AgentSettingsFormProps {
  settings: EnvVarSetting[]
  values: Record<string, string>
  onChange: (key: string, value: string | undefined) => void
  isDark: boolean
  /** Per key: why its value does not fit. Marks the tab and the row. */
  invalid?: Record<string, string>
  /** Secrets a template already stores (values never reach the browser). */
  storedSecrets?: Set<string>
  /** Keys whose value comes from a template and cannot be unset here. */
  lockedKeys?: Set<string>
  /** The Custom tab's content, and how many variables it holds. */
  custom: ReactNode
  customCount: number
}

export default function AgentSettingsForm({
  settings,
  values,
  onChange,
  isDark,
  invalid = {},
  storedSecrets,
  lockedKeys,
  custom,
  customCount,
}: AgentSettingsFormProps) {
  const tabs = useMemo(() => settingsTabs(settings), [settings])
  const [active, setActive] = useState<string>(() => tabs.find((t) => t.id !== 'Keys')?.id ?? tabs[0]?.id ?? 'custom')

  const missingSecret = (s: EnvVarSetting) => s.required && !values[s.name] && !storedSecrets?.has(s.name)

  const tabButton = (id: string, label: string, badge: ReactNode) => (
    <button
      key={id}
      type="button"
      onClick={() => setActive(id)}
      className={`px-3 py-2 text-sm whitespace-nowrap flex items-center gap-1.5 border-b-2 -mb-px transition-colors ${
        active === id
          ? `border-primary-500 font-medium ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`
          : `border-transparent ${isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-neutral-500 hover:text-neutral-800'}`
      }`}
    >
      {label}
      {badge}
    </button>
  )

  return (
    <div>
      <div role="tablist" className={`flex border-b mb-1 overflow-x-auto ${isDark ? 'border-zinc-700' : 'border-neutral-200'}`}>
        {tabs.map((t) => {
          const changed = t.settings.filter((s) => s.type !== 'secret' && values[s.name] !== undefined).length
          const problem = t.settings.some((s) => invalid[s.name] || missingSecret(s))
          return tabButton(
            t.id,
            t.label,
            problem ? (
              <span className="w-1.5 h-1.5 rounded-full bg-red-500" aria-label="needs attention" />
            ) : changed > 0 ? (
              <Count tone="primary" isDark={isDark}>{changed}</Count>
            ) : null,
          )
        })}
        {tabButton('custom', 'Custom', customCount > 0 ? <Count tone="neutral" isDark={isDark}>{customCount}</Count> : null)}
      </div>

      <div className="min-h-[260px] max-h-[360px] overflow-y-auto pr-1">
        {tabs
          .filter((t) => t.id === active)
          .map((t) => (
            <div key={t.id}>
              {t.settings.map((s) => (
                <SettingRow
                  key={s.name}
                  setting={s}
                  value={values[s.name]}
                  onChange={(v) => onChange(s.name, v)}
                  isDark={isDark}
                  invalid={invalid[s.name] ?? (missingSecret(s) ? 'required' : undefined)}
                  stored={storedSecrets?.has(s.name) ?? false}
                  locked={lockedKeys?.has(s.name) ?? false}
                />
              ))}
            </div>
          ))}
        {/* Kept mounted so the editor's rows survive switching tabs. */}
        <div className={active === 'custom' ? 'pt-3' : 'hidden'}>
          <p className={`text-xs mb-2 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
            Anything the agent does not declare, as key/value pairs, passed to the agent as they are.
          </p>
          {custom}
        </div>
      </div>
    </div>
  )
}

function Count({ children, tone, isDark }: { children: ReactNode; tone: 'primary' | 'neutral'; isDark: boolean }) {
  const cls =
    tone === 'primary'
      ? isDark ? 'bg-primary-500/20 text-primary-300' : 'bg-primary-50 text-primary-700'
      : isDark ? 'bg-zinc-700 text-zinc-300' : 'bg-neutral-100 text-neutral-600'
  return <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${cls}`}>{children}</span>
}

function SettingRow({
  setting: s,
  value,
  onChange,
  isDark,
  invalid,
  stored,
  locked,
}: {
  setting: EnvVarSetting
  value: string | undefined
  onChange: (v: string | undefined) => void
  isDark: boolean
  invalid?: string
  stored: boolean
  locked: boolean
}) {
  const changed = value !== undefined && s.type !== 'secret'
  const muted = isDark ? 'text-zinc-500' : 'text-neutral-400'
  return (
    <div className={`flex items-start justify-between gap-4 py-3 border-b last:border-0 ${isDark ? 'border-zinc-700/70' : 'border-neutral-100'}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>{s.label ?? s.name}</span>
          {s.required && <Tag tone="amber" isDark={isDark}>Required</Tag>}
          {changed && <Tag tone="primary" isDark={isDark}>{locked ? 'From template' : 'Changed'}</Tag>}
        </div>
        {s.description && (
          <div className={`text-xs mt-0.5 leading-snug ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>{s.description}</div>
        )}
        <div className={`text-[11px] mt-1 font-mono ${muted}`}>
          {s.name}
          {s.type !== 'secret' && <> · default {defaultLabel(s)}</>}
          {changed && !locked && (
            <button type="button" onClick={() => onChange(undefined)} className="ml-2 underline font-sans text-primary-500">
              Reset
            </button>
          )}
        </div>
        {invalid && <div className="text-xs mt-1 text-red-500">{invalid === 'required' ? 'Required' : `Must ${invalid.replace(/^must /, '')}`}</div>}
      </div>
      <div className="shrink-0 pt-0.5">
        <Control setting={s} value={value} onChange={onChange} isDark={isDark} invalid={!!invalid} stored={stored} />
      </div>
    </div>
  )
}

function Tag({ children, tone, isDark }: { children: ReactNode; tone: 'primary' | 'amber'; isDark: boolean }) {
  const cls =
    tone === 'amber'
      ? isDark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-700'
      : isDark ? 'bg-primary-500/20 text-primary-300' : 'bg-primary-50 text-primary-700'
  return <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium whitespace-nowrap ${cls}`}>{children}</span>
}

function Control({
  setting: s,
  value,
  onChange,
  isDark,
  invalid,
  stored,
}: {
  setting: EnvVarSetting
  value: string | undefined
  onChange: (v: string | undefined) => void
  isDark: boolean
  invalid: boolean
  stored: boolean
}) {
  const input = `rounded-lg px-3 py-1.5 text-sm border outline-none focus:ring-2 focus:ring-primary-500/40 ${
    isDark ? 'bg-zinc-900 border-zinc-600 text-zinc-100' : 'bg-white border-neutral-300 text-neutral-900'
  } ${invalid ? '!border-red-500' : ''}`
  const fallback = s.default ?? s.agentDefault

  switch (s.type) {
    case 'boolean': {
      const on = (value ?? fallback) === 'true'
      return (
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={s.label ?? s.name}
          onClick={() => onChange(on ? 'false' : 'true')}
          className={`relative w-10 h-6 rounded-full transition-colors ${on ? 'bg-primary-500' : isDark ? 'bg-zinc-600' : 'bg-neutral-300'}`}
        >
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
        </button>
      )
    }
    case 'enum':
      return (
        <select
          aria-label={s.label ?? s.name}
          className={`${input} w-44`}
          value={value ?? fallback ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        >
          {fallback === undefined && <option value="">{s.unsetLabel ?? 'Agent default'}</option>}
          {(s.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label ?? o.value}</option>
          ))}
        </select>
      )
    case 'number':
    case 'integer': {
      const shown = value ?? ''
      const slider = s.type === 'number' && s.min !== undefined && s.max !== undefined
      return (
        <div className="flex items-center gap-2">
          {slider && (
            <input
              type="range"
              aria-hidden
              tabIndex={-1}
              min={s.min}
              max={s.max}
              step={s.step ?? 'any'}
              value={Number(value ?? fallback ?? s.min)}
              onChange={(e) => onChange(e.target.value)}
              className="w-28 accent-primary-500"
            />
          )}
          <input
            type="text"
            inputMode="decimal"
            aria-label={s.label ?? s.name}
            className={`${input} w-24 text-right`}
            value={shown}
            placeholder={fallback ?? s.unsetLabel ?? ''}
            onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          />
          {s.unit && <span className={`text-xs w-5 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>{s.unit}</span>}
        </div>
      )
    }
    case 'secret':
      return (
        <input
          type="password"
          aria-label={s.label ?? s.name}
          autoComplete="off"
          className={`${input} w-56 font-mono`}
          placeholder={stored ? '•••••••• stored — type to replace' : 'Paste value'}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value.replace(/[\r\n]/g, ''))}
        />
      )
    default:
      return (
        <input
          type="text"
          aria-label={s.label ?? s.name}
          className={`${input} w-56 font-mono`}
          placeholder={fallback ?? s.unsetLabel ?? ''}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        />
      )
  }
}
