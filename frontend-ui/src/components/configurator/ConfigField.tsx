import { useState } from 'react'
import { motion } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import type { ConfigurableSlot } from '../../lib/api-types'

interface ConfigFieldProps {
  slot: ConfigurableSlot
  value: unknown
  defaultValue: unknown
  onChange: (value: unknown) => void
}

export default function ConfigField({ slot, value, defaultValue, onChange }: ConfigFieldProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const isModified = value !== undefined && value !== null && JSON.stringify(value) !== JSON.stringify(defaultValue)
  const isShowingDefault = !isModified && defaultValue !== undefined && defaultValue !== null

  const inputClass = `w-full px-3 py-2 rounded-lg text-sm font-light focus:outline-none transition-all duration-200 ${
    isDark
      ? 'bg-zinc-700/50 border border-zinc-600 text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500'
      : 'bg-neutral-50/50 border border-neutral-200/60 text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400/60'
  }`

  const handleTextChange = (newValue: string) => {
    // Keep an explicit empty string — clearing the field stays empty and does not
    // snap the default back. Use "Reset to default" to inherit again (#174).
    onChange(newValue)
  }

  const renderField = () => {
    switch (slot.type) {
      case 'text': {
        const displayValue = (value as string) ?? (defaultValue as string) ?? ''
        return (
          <div className="relative">
            <textarea
              value={displayValue}
              onChange={(e) => handleTextChange(e.target.value)}
              placeholder={`Enter ${slot.label.toLowerCase()}...`}
              rows={Math.min(12, Math.max(3, Math.ceil((displayValue?.length || 0) / 60)))}
              maxLength={slot.maxLength}
              className={`${inputClass} resize-y min-h-[80px] ${
                isShowingDefault
                  ? isDark
                    ? '!text-zinc-400'
                    : '!text-neutral-400'
                  : ''
              }`}
            />
            {isShowingDefault && (
              <div className={`absolute top-2 right-2 text-[9px] font-medium px-1.5 py-0.5 rounded ${
                isDark ? 'bg-zinc-600/60 text-zinc-400' : 'bg-neutral-200/80 text-neutral-400'
              }`}>
                DEFAULT
              </div>
            )}
          </div>
        )
      }

      case 'number':
        return (
          <input
            type="number"
            value={(value as number) ?? (defaultValue as number) ?? ''}
            onChange={(e) => onChange(e.target.value ? parseFloat(e.target.value) : undefined)}
            min={slot.min}
            max={slot.max}
            step={slot.step}
            className={inputClass}
          />
        )

      case 'select':
        return (
          <select
            value={(value as string) ?? (defaultValue as string) ?? ''}
            onChange={(e) => onChange(e.target.value)}
            className={inputClass}
          >
            {slot.options?.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        )

      case 'string_list':
        return <StringListField value={value as string[] | undefined} defaultValue={defaultValue as string[] | undefined} onChange={onChange} isDark={isDark} />

      case 'key_value':
        return <KeyValueField value={value as Record<string, string> | undefined} defaultValue={defaultValue as Record<string, string> | undefined} onChange={onChange} isDark={isDark} />

      default:
        return (
          <input
            type="text"
            value={String(value ?? defaultValue ?? '')}
            onChange={(e) => onChange(e.target.value)}
            className={inputClass}
          />
        )
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className={`text-xs font-medium tracking-wide ${isDark ? 'text-zinc-300' : 'text-neutral-700'}`}>
          {slot.label}
          {isModified && (
            <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-amber-500/20 text-amber-500 font-medium">
              Modified
            </span>
          )}
        </label>
        {isModified && (
          <button
            onClick={() => onChange(undefined)}
            className={`text-[10px] font-medium px-2 py-0.5 rounded transition-colors ${
              isDark
                ? 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'
                : 'text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100'
            }`}
          >
            Reset to default
          </button>
        )}
      </div>
      {slot.description && (
        <p className={`text-[11px] font-light ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
          {slot.description}
        </p>
      )}
      {renderField()}
    </div>
  )
}

// Sub-component: String list (tags-style input)
function StringListField({
  value,
  defaultValue,
  onChange,
  isDark,
}: {
  value: string[] | undefined
  defaultValue: string[] | undefined
  onChange: (val: unknown) => void
  isDark: boolean
}) {
  const [input, setInput] = useState('')
  const items = value ?? defaultValue ?? []

  const addItem = () => {
    const trimmed = input.trim()
    if (trimmed && !items.includes(trimmed)) {
      onChange([...items, trimmed])
      setInput('')
    }
  }

  const removeItem = (item: string) => {
    onChange(items.filter((i) => i !== item))
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addItem())}
          placeholder="Type and press Enter..."
          className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-light focus:outline-none transition-all ${
            isDark ? 'bg-zinc-700/50 border border-zinc-600 text-zinc-100' : 'bg-neutral-50/50 border border-neutral-200/60 text-neutral-900'
          }`}
        />
        <button
          onClick={addItem}
          className={`px-3 py-1.5 rounded-lg text-xs font-light transition-colors ${
            isDark ? 'bg-zinc-600 text-zinc-200 hover:bg-zinc-500' : 'bg-neutral-200 text-neutral-700 hover:bg-neutral-300'
          }`}
        >
          Add
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <motion.span
            key={item}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-light ${
              isDark ? 'bg-zinc-700 text-zinc-300' : 'bg-neutral-100 text-neutral-600'
            }`}
          >
            {item}
            <button onClick={() => removeItem(item)} className="hover:opacity-70">
              ×
            </button>
          </motion.span>
        ))}
      </div>
    </div>
  )
}

// Sub-component: Key-value editor
function KeyValueField({
  value,
  defaultValue,
  onChange,
  isDark,
}: {
  value: Record<string, string> | undefined
  defaultValue: Record<string, string> | undefined
  onChange: (val: unknown) => void
  isDark: boolean
}) {
  const entries = value ?? defaultValue ?? {}
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')

  const updateEntry = (key: string, val: string) => {
    onChange({ ...entries, [key]: val })
  }

  const removeEntry = (key: string) => {
    const updated = { ...entries }
    delete updated[key]
    onChange(updated)
  }

  const addEntry = () => {
    if (newKey.trim()) {
      onChange({ ...entries, [newKey.trim()]: newValue })
      setNewKey('')
      setNewValue('')
    }
  }

  const cellClass = `px-2 py-1.5 text-xs font-light ${isDark ? 'border-zinc-600' : 'border-neutral-200'}`

  return (
    <div className="space-y-2">
      <div className={`rounded-lg overflow-hidden border ${isDark ? 'border-zinc-600' : 'border-neutral-200'}`}>
        <table className="w-full">
          <thead>
            <tr className={isDark ? 'bg-zinc-700/50' : 'bg-neutral-50'}>
              <th className={`${cellClass} text-left font-medium`}>Key</th>
              <th className={`${cellClass} text-left font-medium`}>Value</th>
              <th className={`${cellClass} w-8`}></th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(entries).map(([key, val]) => (
              <tr key={key} className={isDark ? 'border-t border-zinc-600' : 'border-t border-neutral-200'}>
                <td className={cellClass}>{key}</td>
                <td className={cellClass}>
                  {/* A textarea, so sentence-long values (reply instructions)
                      can be read and edited; short ones still take one row. */}
                  <textarea
                    rows={Math.min(8, Math.max(1, Math.ceil(String(val).length / 60)))}
                    value={val}
                    onChange={(e) => updateEntry(key, e.target.value)}
                    className={`w-full bg-transparent resize-y focus:outline-none ${isDark ? 'text-zinc-200' : 'text-neutral-900'}`}
                  />
                </td>
                <td className={cellClass}>
                  <button onClick={() => removeEntry(key)} className={`hover:opacity-70 ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="Key"
          className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-light focus:outline-none ${
            isDark ? 'bg-zinc-700/50 border border-zinc-600 text-zinc-100' : 'bg-neutral-50/50 border border-neutral-200/60 text-neutral-900'
          }`}
        />
        <input
          type="text"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          placeholder="Value"
          onKeyDown={(e) => e.key === 'Enter' && addEntry()}
          className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-light focus:outline-none ${
            isDark ? 'bg-zinc-700/50 border border-zinc-600 text-zinc-100' : 'bg-neutral-50/50 border border-neutral-200/60 text-neutral-900'
          }`}
        />
        <button
          onClick={addEntry}
          className={`px-3 py-1.5 rounded-lg text-xs font-light ${isDark ? 'bg-zinc-600 text-zinc-200 hover:bg-zinc-500' : 'bg-neutral-200 text-neutral-700 hover:bg-neutral-300'}`}
        >
          Add
        </button>
      </div>
    </div>
  )
}
