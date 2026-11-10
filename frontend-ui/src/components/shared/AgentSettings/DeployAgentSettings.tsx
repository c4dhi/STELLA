/**
 * The deploy wizards' settings (#585, #892), on two screens: first where to
 * start (the agent's defaults or a saved template), then the settings in tabs,
 * custom variables, and saving the result as a new template.
 *
 * The draft lives in the wizard (`useDeploySettings`), not in either screen, so
 * going Back to the template screen and on again keeps the edits as long as
 * the same template stays picked. Picking a different one starts over from it.
 *
 * A template's secrets and custom values never reach the browser, so the
 * deployment still names the template and sends only what was changed on top
 * (merged server-side, overrides winning). A setting the template sets can be
 * changed here but not unset: an empty override would reach the agent as an
 * explicit empty value, which is not the same as unset.
 */
import { useMemo, useState, type ReactNode } from 'react'
import type { EnvVarTemplate } from '../../../lib/api-types'
import { apiClient } from '../../../services/ApiClient'
import {
  invalidSettings,
  settingsFromEnv,
  type DeclaredEnv,
  type EnvVarSetting,
} from '../../../lib/agentSettings'
import { useEnvVarListEditor } from '../EnvVarListEditor/useEnvVarListEditor'
import EnvVarListEditor from '../EnvVarListEditor/EnvVarListEditor'
import AgentSettingsForm from './AgentSettingsForm'
import { WIZARD_CARD_GRID } from '../wizardLayout'
import { choiceCardClass, SelectedBadge } from '../wizardChoice'

export interface DeploySettingsState {
  templateId: string | undefined
  /** Only what differs from the template (or, without one, everything set). */
  envVars: Record<string, string>
  /** Every required key is provided and every value fits. */
  ready: boolean
}

/** The settings tab both wizards open on: what has to be filled in comes first. */
export const DEPLOY_SETTINGS_FIRST_TAB = 'Keys'

/**
 * The wizard's settings draft: the template it starts from and what was changed
 * on top. Call it in the wizard so it outlives both screens.
 */
export function useDeploySettings(
  /** The agent's `requirements.env`. */
  env: DeclaredEnv | null | undefined,
  /** Settings another step of the wizard decides (voice and language). */
  hiddenKeys: string[] = [],
) {
  const settings: EnvVarSetting[] = useMemo(
    () => settingsFromEnv(env).filter((s) => !hiddenKeys.includes(s.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [env, hiddenKeys.join(',')],
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

  /** Start over from `next`, the agent's defaults when null. */
  const startFrom = (next: EnvVarTemplate | null) => {
    setTemplate(next)
    setOverrides({})
    const custom = (next?.variableKeys ?? []).filter((k) => !declared.has(k))
    customEditor.reset({ templateKeys: custom, initial: {} })
  }
  /** Pick where to start; picking the one already picked keeps the edits. */
  const choose = (next: EnvVarTemplate | null) => {
    if ((next?.id ?? null) === (template?.id ?? null)) return
    startFrom(next)
  }
  /** Back to nothing picked and nothing changed, as for a new agent. */
  const clear = () => startFrom(null)

  const setValue = (key: string, value: string | undefined) =>
    setOverrides((prev) => {
      const next = { ...prev }
      if (value === undefined) delete next[key]
      else next[key] = value
      return next
    })

  const customVars = customEditor.toVariablesMap()
  const missingRequired = settings.some((s) => s.required && !values[s.name] && !storedSecrets.has(s.name))
  const ready = customVars !== null && !missingRequired && Object.keys(invalid).length === 0
  const envVars = { ...(customVars ?? {}), ...overrides }
  const state: DeploySettingsState = { templateId: template?.id, envVars, ready }

  return {
    settings,
    declared,
    template,
    values,
    storedSecrets,
    lockedKeys,
    invalid,
    customEditor,
    state,
    choose,
    startFrom,
    clear,
    setValue,
  }
}

export type DeploySettingsDraft = ReturnType<typeof useDeploySettings>

/** Screen 1: where the settings start from. */
export function EnvTemplatePicker({
  draft,
  templates,
  isLoading,
  isDark,
}: {
  draft: DeploySettingsDraft
  templates: EnvVarTemplate[]
  isLoading: boolean
  isDark: boolean
}) {
  const muted = isDark ? 'text-zinc-400' : 'text-neutral-500'
  const title = isDark ? 'text-zinc-100' : 'text-neutral-900'
  const picked = draft.template

  if (isLoading) {
    return (
      <div className={`h-32 flex items-center justify-center text-sm ${muted}`}>
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
          Loading templates…
        </div>
      </div>
    )
  }

  const card = (key: string, selected: boolean, onClick: () => void, body: ReactNode) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className={`relative p-4 rounded-xl text-left transition-all duration-200 ${choiceCardClass(selected, isDark)}`}
    >
      {selected && (
        <div className="absolute top-3 right-3">
          <SelectedBadge isDark={isDark} />
        </div>
      )}
      {body}
    </button>
  )

  return (
    <div className={`${WIZARD_CARD_GRID} pr-2 pt-1 -mt-1`}>
      {card('defaults', picked === null, () => draft.choose(null), (
        <>
          <h3 className={`text-sm font-semibold truncate mb-1 pr-6 ${title}`}>Agent defaults</h3>
          <div className={`text-xs ${muted}`}>Nothing changed</div>
        </>
      ))}
      {templates.map((t) => {
        const settingCount = t.variableKeys.filter((k) => draft.declared.has(k)).length
        const customCount = t.variableKeys.length - settingCount
        const broken = Object.keys(t.invalid ?? {}).length > 0
        return card(t.id, picked?.id === t.id, () => draft.choose(t), (
          <>
            <h3 className={`text-sm font-semibold truncate mb-1 pr-6 ${title}`}>{t.name}</h3>
            <div className={`text-xs ${muted}`}>
              {settingCount} setting{settingCount === 1 ? '' : 's'}
              {customCount > 0 && ` · ${customCount} custom`}
            </div>
            {(broken || t.needsCheck) && (
              <div className="mt-2">
                <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${
                  broken
                    ? isDark ? 'bg-red-500/20 text-red-300' : 'bg-red-50 text-red-700'
                    : isDark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-700'
                }`}>
                  {broken ? 'Needs a fix' : 'Migrated · check'}
                </span>
              </div>
            )}
          </>
        ))
      })}
    </div>
  )
}

/** Screen 2: the settings in tabs, opening on Keys every time it is shown. */
export default function DeployAgentSettings({
  draft,
  agentTypeId,
  templates,
  onTemplatesChange,
  isDark,
}: {
  draft: DeploySettingsDraft
  agentTypeId: string
  templates: EnvVarTemplate[]
  onTemplatesChange: (templates: EnvVarTemplate[]) => void
  isDark: boolean
}) {
  const { state } = draft

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
      if (draft.template) {
        // Copied server-side, so the template's hidden values come along.
        const copy = await apiClient.duplicateEnvVarTemplate(draft.template.id)
        saved = await apiClient.updateEnvVarTemplate(copy.id, { name: newName.trim(), variables: state.envVars })
      } else {
        saved = await apiClient.createEnvVarTemplate({ name: newName.trim(), agentTypeId, variables: state.envVars })
      }
      onTemplatesChange([saved, ...templates])
      draft.startFrom(saved)
      setSaving('idle')
      setNewName('')
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save the template')
      setSaving('naming')
    }
  }

  const muted = isDark ? 'text-zinc-400' : 'text-neutral-500'

  return (
    <div>
      {templates.length > 0 && (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg mb-4 text-xs ${isDark ? 'bg-zinc-700/50 text-zinc-400' : 'bg-neutral-100 text-neutral-500'}`}>
          Starting from: <span className="font-medium">{draft.template?.name ?? 'Agent defaults'}</span>
        </div>
      )}

      <AgentSettingsForm
        settings={draft.settings}
        values={draft.values}
        onChange={draft.setValue}
        isDark={isDark}
        invalid={draft.invalid}
        storedSecrets={draft.storedSecrets}
        lockedKeys={draft.lockedKeys}
        initialTab={DEPLOY_SETTINGS_FIRST_TAB}
        custom={<EnvVarListEditor editor={draft.customEditor} isDark={isDark} showOriginBadges={false} />}
        customCount={draft.customEditor.rows.filter((r) => r.key.trim()).length}
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
            <button type="button" disabled={!newName.trim() || saving === 'busy' || !state.ready} onClick={() => void save()} className="text-primary-500 underline disabled:opacity-50">
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
