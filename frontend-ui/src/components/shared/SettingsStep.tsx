import { useState } from 'react'
import { useThemeStore } from '../../store/themeStore'
import type { SettingField, SettingValues } from '../../lib/settingsForm'

interface SettingsStepProps {
  agentName: string
  fields: SettingField[]
  values: SettingValues
  onChange: (path: string, value: string | boolean) => void
}

/**
 * The agent's own settings, built from the configSchema in its agent.yaml.
 * Required fields come first; the rest are folded under "More settings" and
 * keep the agent's defaults unless changed.
 */
export default function SettingsStep({ agentName, fields, values, onChange }: SettingsStepProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const required = fields.filter((f) => f.required)
  const optional = fields.filter((f) => !f.required)
  const [showOptional, setShowOptional] = useState(required.length === 0)

  const inputClass = `
    w-full px-4 py-2.5 rounded-xl text-sm font-light border transition-colors
    focus:outline-none focus:ring-2 focus:ring-primary-500/40
    ${isDark ? 'bg-zinc-900 border-zinc-700 text-zinc-100' : 'bg-white border-neutral-300 text-neutral-900'}
  `
  const labelClass = `block text-sm font-medium mb-1.5 ${isDark ? 'text-zinc-200' : 'text-neutral-800'}`
  const hintClass = `text-xs font-light mt-1.5 ${isDark ? 'text-zinc-500' : 'text-neutral-500'}`

  const renderField = (field: SettingField) => {
    const id = `setting-${field.path}`
    const value = values[field.path]
    if (field.kind === 'boolean') {
      return (
        <label key={field.path} htmlFor={id} className="flex items-start gap-3 cursor-pointer">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(field.path, e.target.checked)}
            className="mt-1 h-4 w-4 rounded accent-primary-500"
          />
          <span>
            <span className={labelClass}>{field.label}</span>
            {field.description && <span className={hintClass}>{field.description}</span>}
          </span>
        </label>
      )
    }
    return (
      <div key={field.path}>
        <label htmlFor={id} className={labelClass}>
          {field.label}
          {field.required && <span className="text-rose-500"> *</span>}
        </label>
        {field.kind === 'enum' ? (
          <select id={id} value={String(value ?? '')} onChange={(e) => onChange(field.path, e.target.value)} className={inputClass}>
            {!field.required && <option value="">Agent default</option>}
            {field.required && !value && <option value="">Choose…</option>}
            {field.options?.map((option) => (
              <option key={String(option)} value={String(option)}>{String(option)}</option>
            ))}
          </select>
        ) : (
          <input
            id={id}
            type={field.kind === 'string' ? 'text' : 'number'}
            step={field.kind === 'integer' ? 1 : undefined}
            min={field.minimum}
            max={field.maximum}
            minLength={field.minLength}
            maxLength={field.maxLength}
            value={String(value ?? '')}
            onChange={(e) => onChange(field.path, e.target.value)}
            className={inputClass}
            placeholder={field.required ? '' : 'Agent default'}
          />
        )}
        {field.description && <p className={hintClass}>{field.description}</p>}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {required.length > 0 ? (
        <div className="space-y-4">{required.map(renderField)}</div>
      ) : (
        <p className={`text-sm font-light ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
          {agentName} needs no settings. You can change its defaults below.
        </p>
      )}
      {optional.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowOptional((v) => !v)}
            className={`text-sm font-medium ${isDark ? 'text-zinc-300 hover:text-white' : 'text-neutral-700 hover:text-neutral-900'}`}
          >
            {showOptional ? '▾' : '▸'} More settings ({optional.length})
          </button>
          {showOptional && <div className="space-y-4 mt-4">{optional.map(renderField)}</div>}
        </div>
      )}
    </div>
  )
}
