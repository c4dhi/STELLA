import { useState, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import type { PipelineSchema, AgentConfigurationPayload, PipelineNode as PipelineNodeType } from '../../lib/api-types'
import PipelineView from './PipelineView'
import ExpertSidebar from './ExpertSidebar'
import NodeDetailOverlay from './NodeDetailOverlay'
import { useConfiguratorState } from './useConfiguratorState'
import type { StageSummary } from './PipelineNodeCard'

/** Order-independent JSON serialization for a reliable dirty check. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const obj = value as Record<string, unknown>
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}

interface AgentConfiguratorModalProps {
  isOpen: boolean
  onClose: () => void
  pipelineSchema: PipelineSchema
  initialConfiguration?: AgentConfigurationPayload
  initialName?: string
  initialDescription?: string
  onSave: (name: string, description: string, configuration: AgentConfigurationPayload) => void
  saveLabel?: string
}

export default function AgentConfiguratorModal({
  isOpen,
  onClose,
  pipelineSchema,
  initialConfiguration,
  initialName = '',
  initialDescription = '',
  onSave,
  saveLabel = 'Save Configuration',
}: AgentConfiguratorModalProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [configuration, setConfiguration] = useState<AgentConfigurationPayload>(
    initialConfiguration || { nodes: {}, thresholds: {} },
  )
  const [overlayNodeId, setOverlayNodeId] = useState<string | null>(null)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)

  const state = useConfiguratorState(configuration, setConfiguration, pipelineSchema)

  // Unsaved-changes guard (#177): compare current name/description/config to the
  // values the modal opened with. Closing while dirty asks for confirmation first.
  const isDirty = useMemo(() => {
    const initialCfg = initialConfiguration || { nodes: {}, thresholds: {} }
    return (
      name !== initialName ||
      description !== initialDescription ||
      stableStringify(configuration) !== stableStringify(initialCfg)
    )
  }, [name, description, configuration, initialName, initialDescription, initialConfiguration])

  const requestClose = useCallback(() => {
    if (isDirty) setShowCloseConfirm(true)
    else onClose()
  }, [isDirty, onClose])

  const overlayNode: PipelineNodeType | null = overlayNodeId
    ? pipelineSchema.nodes.find((n) => n.id === overlayNodeId) || null
    : null

  const handleNodeClick = useCallback((nodeId: string) => {
    setOverlayNodeId(nodeId)
  }, [])

  const handleSave = () => {
    if (!name.trim()) return
    onSave(name.trim(), description.trim(), configuration)
  }

  // Build stage summaries for pipeline nodes
  const stageSummaries = useMemo((): Record<string, StageSummary> => {
    const nodeConfig = (id: string) => (configuration.nodes?.[id] ?? {}) as Record<string, unknown>

    return {
      input_gate: {
        type: 'input_gate',
        lines: [`${state.inputGateRules.length} trigger rules`],
        receivesPlanData: true,
        receivesProgressData: true,
        modelBadge: (nodeConfig('input_gate').model as string) || 'gpt-4o-mini',
      },
      expert_pool: {
        type: 'expert_pool',
        lines: [
          `${state.poolExperts.length} active${state.bgExperts.length > 0 ? ` (${state.bgExperts.length} bg)` : ''}`,
        ],
        receivesPlanData: true,
        receivesProgressData: true,
        chips: state.poolExperts.map((e) => e.name),
      },
      arbitration: {
        type: 'arbitration',
        lines: ['Priority-based resolution'],
        receivesPlanData: false,
        chips: state.arbitrationOrder,
      },
      response_generator: {
        type: 'response_generator',
        lines: ['Persona + guidelines'],
        receivesPlanData: true,
        modelBadge: (nodeConfig('response_generator').model as string) || 'gpt-4o-mini',
      },
      bridge_generator: {
        type: 'bridge_generator',
        lines: ['Ultra-short bridge phrase'],
        receivesPlanData: false,
        modelBadge: (nodeConfig('bridge_generator').model as string) || 'gpt-4o-mini',
      },
    }
  }, [state.inputGateRules, state.poolExperts, state.bgExperts, state.arbitrationOrder, configuration])

  const modifiedNodeCount = Object.keys(configuration.nodes || {}).filter(
    (k) => configuration.nodes?.[k] && Object.keys(configuration.nodes[k]).length > 0,
  ).length
  const modifiedThresholdCount = Object.keys(configuration.thresholds || {}).length
  const hasModifications = modifiedNodeCount > 0 || modifiedThresholdCount > 0

  if (!isOpen) return null

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm"
      onClick={requestClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        className={`
          rounded-[20px] w-full max-w-[1600px] h-[90vh] overflow-hidden flex flex-col
          ${isDark
            ? 'bg-zinc-900 border border-zinc-700 shadow-[0_8px_40px_rgba(0,0,0,0.5)]'
            : 'bg-white border border-neutral-200 shadow-[0_1px_40px_rgba(0,0,0,0.12)]'
          }
        `}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`px-4 py-3 border-b flex items-center gap-3 ${isDark ? 'border-zinc-700/80' : 'border-neutral-200'}`}>
          {/* Close (X) button — left */}
          <motion.button
            onClick={requestClose}
            className={`p-2 rounded-xl transition-colors ${
              isDark
                ? 'text-content-inverse-secondary hover:text-content-inverse hover:bg-surface-dark-secondary'
                : 'text-content-secondary hover:text-content hover:bg-surface-secondary'
            }`}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </motion.button>

          {/* Title + info */}
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isDark ? 'bg-primary-500/10' : 'bg-primary-50'}`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={isDark ? 'text-primary-400' : 'text-primary-600'}>
                <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
              </svg>
            </div>
            <div>
              <h2 className={`text-body-sm font-semibold ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                Pipeline Configurator
              </h2>
              <p className={`text-caption ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
                Click a pipeline stage to configure
                {hasModifications && (
                  <span className="ml-2 text-amber-500 font-medium">
                    {modifiedNodeCount} node{modifiedNodeCount !== 1 ? 's' : ''}, {modifiedThresholdCount} threshold{modifiedThresholdCount !== 1 ? 's' : ''} modified
                  </span>
                )}
              </p>
            </div>
          </div>

          {/* Name & description inputs */}
          <div className="flex-1 flex gap-2.5 ml-3">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Configuration name..."
              className={`flex-1 max-w-[220px] px-3 py-1.5 rounded-lg text-body-sm focus:outline-none transition-all ${
                isDark
                  ? 'bg-surface-dark-secondary border border-border-dark text-content-inverse placeholder:text-content-inverse-tertiary focus:border-border-dark-secondary'
                  : 'bg-surface-secondary border border-border text-content placeholder:text-content-tertiary focus:border-border-secondary'
              }`}
            />
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description (optional)"
              className={`flex-1 max-w-[280px] px-3 py-1.5 rounded-lg text-body-sm focus:outline-none transition-all ${
                isDark
                  ? 'bg-surface-dark-secondary border border-border-dark text-content-inverse placeholder:text-content-inverse-tertiary focus:border-border-dark-secondary'
                  : 'bg-surface-secondary border border-border text-content placeholder:text-content-tertiary focus:border-border-secondary'
              }`}
            />
          </div>

          {/* Save button — right */}
          <motion.button
            onClick={handleSave}
            disabled={!name.trim()}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-body-sm font-medium transition-all ${
              isDark
                ? 'bg-primary text-white shadow-lg shadow-primary/20 hover:bg-primary/90'
                : 'bg-neutral-900 text-white shadow-lg shadow-neutral-900/20 hover:bg-neutral-800'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
            whileHover={{ scale: 1.02, y: -1 }}
            whileTap={{ scale: 0.98 }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            {saveLabel}
          </motion.button>
        </div>

        {/* Body — horizontal split: pipeline left, expert sidebar right */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left: Pipeline visualization */}
          <div className="flex-1 min-w-0">
            <PipelineView
              schema={pipelineSchema}
              configuration={configuration}
              selectedNodeId={null}
              onNodeClick={handleNodeClick}
              stageSummaries={stageSummaries}
            />
          </div>

          {/* Right: Expert sidebar (always visible) */}
          <div className={`w-[440px] shrink-0 border-l overflow-hidden ${isDark ? 'border-zinc-700' : 'border-neutral-200'}`}>
            <ExpertSidebar
              experts={state.experts}
              poolExperts={state.poolExperts}
              bgExperts={state.bgExperts}
              disabledExperts={state.disabledExperts}
              taskExtractionEnabled={state.taskExtractionEnabled}
              companionRouter={state.companionRouter}
              onUpdateExpert={state.updateExpert}
              onReorderExperts={state.reorderExperts}
              onAddCustomExpert={state.addCustomExpert}
              onRemoveExpert={state.removeExpert}
              onToggleTaskExtraction={state.toggleTaskExtraction}
              isDark={isDark}
            />
          </div>
        </div>

        {/* Footer: Inline thresholds */}
        {pipelineSchema.thresholds.length > 0 && (
          <div className={`px-6 py-2.5 border-t flex items-center gap-5 shrink-0 ${isDark ? 'border-zinc-700/80' : 'border-neutral-200'}`}>
            <span className={`text-[10px] font-medium tracking-wide uppercase ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
              Thresholds
            </span>
            {pipelineSchema.thresholds.map((t) => {
              const configThresholds = (configuration.thresholds || {}) as Record<string, number>
              const val = configThresholds[t.id]
              const isModified = val !== undefined
              return (
                <div key={t.id} className="flex items-center gap-2">
                  <label className={`text-[11px] font-medium ${isModified ? 'text-amber-500' : isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                    {t.label}
                  </label>
                  <input
                    type="number"
                    value={val ?? t.default ?? 0}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value)
                      state.updateThreshold(t.id, v === t.default ? undefined : v)
                    }}
                    min={t.min ?? 0}
                    max={t.max ?? 100}
                    step={t.step ?? 1}
                    className={`w-16 px-2 py-1 rounded-lg text-xs font-mono text-center focus:outline-none transition-all ${
                      isDark
                        ? 'bg-zinc-800 border border-zinc-700 focus:border-zinc-500'
                        : 'bg-neutral-50 border border-neutral-200 focus:border-neutral-400'
                    } ${isModified ? 'text-amber-500' : isDark ? 'text-zinc-300' : 'text-neutral-700'}`}
                  />
                  {isModified && (
                    <button
                      onClick={() => state.updateThreshold(t.id, undefined)}
                      className={`text-[9px] px-1.5 py-0.5 rounded font-medium transition-colors ${
                        isDark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700' : 'text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100'
                      }`}
                    >
                      Reset
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Node detail overlay */}
        <AnimatePresence>
          {overlayNode && (
            <NodeDetailOverlay
              node={overlayNode}
              configuration={configuration}
              onUpdateNodeConfig={state.updateNodeConfig}
              onClose={() => setOverlayNodeId(null)}
              isDark={isDark}
              experts={state.experts}
              inputGateRules={state.inputGateRules}
              arbitrationOrder={state.arbitrationOrder}
            />
          )}
        </AnimatePresence>
      </motion.div>

      {/* Unsaved-changes confirmation (#177) — matches the Plan Builder pattern */}
      {showCloseConfirm && (
        <div
          className="absolute inset-0 z-[120] flex items-center justify-center bg-black/40"
          onClick={(e) => { e.stopPropagation(); setShowCloseConfirm(false) }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className={`rounded-2xl p-6 max-w-sm w-full mx-4 shadow-xl ${
              isDark ? 'bg-zinc-900 border border-zinc-700' : 'bg-white border border-neutral-200'
            }`}
          >
            <h4 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-neutral-800'}`}>
              Discard changes?
            </h4>
            <p className={`text-[13px] mt-1.5 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
              You have unsaved changes to this configuration. If you close now, they will be lost.
            </p>
            <div className="flex justify-end gap-2.5 mt-5">
              <button
                onClick={() => setShowCloseConfirm(false)}
                className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
                  isDark ? 'text-zinc-300 hover:bg-zinc-800' : 'text-neutral-600 hover:bg-neutral-100'
                }`}
              >
                Keep editing
              </button>
              <button
                onClick={() => { setShowCloseConfirm(false); onClose() }}
                className="px-4 py-2 rounded-lg text-xs font-medium bg-red-500 text-white hover:bg-red-600 transition-colors"
              >
                Discard changes
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  )
}
