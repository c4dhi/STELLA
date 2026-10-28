/**
 * The deploy modal's settings step (#585): start from the agent's defaults or
 * a saved template, change settings in tabs, add custom variables, and save
 * the result as a new template.
 *
 * A template's secrets and custom values never reach the browser, so the
 * deployment still names the template and sends only what was changed on top
 * (merged server-side, overrides winning). A setting the template sets can be
 * changed here but not unset: an empty override would reach the agent as an
 * explicit empty value, which is not the same as unset.
 */
import { useEffect, useMemo, useState } from 'react'
import type { EnvVarTemplate } from '../../../lib/api-types'
import { apiClient } from '../../../services/ApiClient'
import {
  invalidSettings,
  settingsFromSchema,
  type EnvVarSetting,
} from '../../../lib/agentSettings'
import { useEnvVarListEditor } from '../EnvVarListEditor/useEnvVarListEditor'
import EnvVarListEditor from '../EnvVarListEditor/EnvVarListEditor'
import AgentSettingsForm from './AgentSettingsForm'

export interface DeploySettingsState {
  templateId: string | undefined
  /** Only what differs from the template (or, without one, everything set). */
  envVars: Record<string, string>
  /** Every required key is provided and every value fits. */
  ready: boolean
}

interface Props {
  agentTypeId: string
  configSchema: Record<string, unknown> | null | undefined
  templates: EnvVarTemplate[]
  onTemplatesChange: (templates: EnvVarTemplate[]) => void
  isLoading: boolean
  isDark: boolean
  /** Settings another step of the modal decides (voice and language). */
  hiddenKeys?: string[]
  onChange: (state: DeploySettingsState) => void
}

export default function DeployAgentSettings({
  agentTypeId,
  configSchema,
  templates,
  onTemplatesChange,
  isLoading,
  isDark,
  hiddenKeys = [],
  onChange,
}: Props) {
  const settings: EnvVarSetting[] = useMemo(
    () => settingsFromSchema(configSchema).filter((s) => !hiddenKeys.includes(s.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [configSchema, hiddenKeys.join(',')],
  )
  const declared = useMemo(() => new Set(settings.map((s) => s.name)), [settings])

  const [template, setTemplate] = useState<EnvVarTemplate | null>(null)
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const customEditor = useEnvVarListEditor({ allowEmptyValues: false })

  const templateValues = useMemo(() => template?.settings ?? {}, [template])
  const values = { ...templateValues, ...overrides }
  const storedSecrets = useMemo(
    () => new Set((template?.variableKeys ?? []).filter((k) => declared.has(k))),
    [template, declared],
  )
  const lockedKeys = useMemo(
    () => new Set(Object.keys(templateValues).filter((k) => overrides[k] === undefined)),
    [templateValues, overrides],
  )
  const invalid = {
    // What the template stores, unless it is being replaced here…
    ...Object.fromEntries(Object.entries(template?.invalid ?? {}).filter(([k]) => overrides[k] === undefined)),
    // …and what was typed here.
    ...invalidSettings(settings, overrides),
  }

  const choose = (next: EnvVarTemplate | null) => {
    setTemplate(next)
    setOverrides({})
    const custom = (next?.variableKeys ?? []).filter((k) => !declared.has(k))
    customEditor.reset({ templateKeys: custom, initial: {} })
  }

  const customVars = customEditor.toVariablesMap()
  const missingRequired = settings.some((s) => s.required && !values[s.name] && !storedSecrets.has(s.name))
  const ready = customVars !== null && !missingRequired && Object.keys(invalid).length === 0
  const envVars = { ...(customVars ?? {}), ...overrides }

  useEffect(() => {
    onChange({ templateId: template?.id, envVars, ready })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template?.id, JSON.stringify(envVars), ready])

  // Save as template
  const [saving, setSaving] = useState<'idle' | 'naming' | 'busy'>('idle')
  const [newName, setNewName] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const save = async () => {
    if (!newName.trim()) return
    setSaving('busy')
    setSaveError(null)
    try {
      let saved: EnvVarTemplate
      if (template) {
        // Copied server-side, so the template's hidden values come along.
        const copy = await apiClient.duplicateEnvVarTemplate(template.id)
        saved = await apiClient.updateEnvVarTemplate(copy.id, { name: newName.trim(), variables: envVars })
      } else {
        saved = await apiClient.createEnvVarTemplate({ name: newName.trim(), agentTypeId, variables: envVars })
      }
      onTemplatesChange([saved, ...templates])
      choose(saved)
      setSaving('idle')
      setNewName('')
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save the template')
      setSaving('naming')
    }
  }

  const muted = isDark ? 'text-zinc-400' : 'text-neutral-500'
  const card = (selected: boolean) =>
    `p-3 rounded-xl text-left transition-all ${
      selected
        ? isDark ? 'bg-primary-500/20 border-2 border-primary-500' : 'bg-primary-50 border-2 border-primary-500'
        : isDark ? 'bg-zinc-700/50 border border-zinc-600 hover:border-zinc-500' : 'bg-white border border-neutral-200 hover:border-neutral-300'
    }`

  return (
    <div>
      <div className="mb-4">
        <div className={`text-xs font-light tracking-wider uppercase mb-2 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>Start from</div>
        {isLoading ? (
          <div className={`text-sm ${muted}`}>Loading templates…</div>
        ) : (
          <div className="grid grid-cols-3 gap-2 max-h-[140px] overflow-y-auto pr-1">
            <button type="button" onClick={() => choose(null)} className={card(template === null)}>
              <div className={`text-sm font-semibold truncate ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>Agent defaults</div>
              <div className={`text-xs mt-0.5 ${muted}`}>Nothing changed</div>
            </button>
            {templates.map((t) => {
              const settingCount = t.variableKeys.filter((k) => declared.has(k)).length
              const customCount = t.variableKeys.length - settingCount
              const broken = Object.keys(t.invalid ?? {}).length > 0
              return (
                <button key={t.id} type="button" onClick={() => choose(t)} className={card(template?.id === t.id)}>
                  <div className={`text-sm font-semibold truncate ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>{t.name}</div>
                  <div className={`text-xs mt-0.5 ${muted}`}>
                    {settingCount} setting{settingCount === 1 ? '' : 's'}
                    {customCount > 0 && ` · ${customCount} custom`}
                  </div>
                  {(broken || t.needsCheck) && (
                    <div className="mt-1.5">
                      <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${
                        broken
                          ? isDark ? 'bg-red-500/20 text-red-300' : 'bg-red-50 text-red-700'
                          : isDark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-700'
                      }`}>
                        {broken ? 'Needs a fix' : 'Migrated · check'}
                      </span>
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>

      <AgentSettingsForm
        settings={settings}
        values={values}
        onChange={(key, value) =>
          setOverrides((prev) => {
            const next = { ...prev }
            if (value === undefined) delete next[key]
            else next[key] = value
            return next
          })
        }
        isDark={isDark}
        invalid={invalid}
        storedSecrets={storedSecrets}
        lockedKeys={lockedKeys}
        custom={<EnvVarListEditor editor={customEditor} isDark={isDark} showOriginBadges={false} />}
        customCount={customEditor.rows.filter((r) => r.key.trim()).length}
      />

      <div className={`mt-3 text-xs ${muted}`}>
        {saving === 'idle' ? (
          <button type="button" onClick={() => setSaving('naming')} className="underline text-primary-500">
            Save as template…
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              aria-label="Template name"
              className={`rounded-lg px-2 py-1 text-sm border ${isDark ? 'bg-zinc-900 border-zinc-600 text-zinc-100' : 'bg-white border-neutral-300'}`}
              placeholder="Template name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save() } }}
            />
            <button type="button" disabled={!newName.trim() || saving === 'busy' || !ready} onClick={() => void save()} className="text-primary-500 underline disabled:opacity-50">
              {saving === 'busy' ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => { setSaving('idle'); setSaveError(null) }} className="underline">Cancel</button>
            {saveError && <span className="text-red-500">{saveError}</span>}
          </div>
        )}
      </div>
    </div>
  )
}
