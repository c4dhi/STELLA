import { motion } from 'framer-motion'
import { useThemeStore } from '../store/themeStore'
import type { ProcessingMessage, DecisionStreamData, PromptExecutionData, ExpertStatusData, SafetyCheckData, DebugData, AgentDecisionData } from '../lib/types'

interface ProcessingMessageViewProps {
  message: ProcessingMessage
}

/** Icon per decision kind. Unknown kinds still render — a new agent decision
 *  should show up as a tag, not disappear until the UI catches up.
 *
 *  One accent (the brand purple) for all of them, deliberately: this is the
 *  same class of event as someone joining or leaving, and those get one
 *  treatment, not a per-event palette. Colour here would be decoration
 *  competing with the safety/expert cards, where colour MEANS something. */
const DECISION_ICONS: Record<string, string> = {
  activities_offered: 'M4 6h16M4 12h16M4 18h10',                       // list
  activity_started: 'M8 5v14l11-7z',                                    // play
  activity_ended: 'M6 6h12v12H6z',                                      // stop
  activity_completed: 'M5 13l4 4L19 7',                                 // check
}

const DEFAULT_DECISION_ICON = 'M4 17h6l4-10h6M14 7l-4 10'               // fork

/** A decision the agent made, rendered as a tag in the conversation.
 *
 * Deliberately NOT the debug card: this is something the reader follows along
 * with, so it takes the same centred-pill shape as the join/leave notice —
 * accented, because unlike those it is the agent changing what it is doing. */
function DecisionTag({ decision, at, isDark }: { decision: AgentDecisionData; at: number; isDark: boolean }) {
  const icon = DECISION_ICONS[decision.kind] || DEFAULT_DECISION_ICON
  const hasOptions = !!decision.options?.length

  return (
    <motion.div
      className="flex justify-center w-full my-4"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.3 }}
    >
      <motion.div
        className={`
          inline-flex flex-col items-center gap-1.5 px-4 py-2 max-w-[85%]
          ${hasOptions ? 'rounded-2xl' : 'rounded-full'}
          text-caption font-light tracking-wide backdrop-blur-sm border
          ${isDark
            ? 'bg-primary-700/15 text-primary-200 border-primary-700/50'
            : 'bg-primary-50 text-primary-700 border-primary-200'
          }
        `}
        initial={{ y: 10 }}
        animate={{ y: 0 }}
        transition={{ delay: 0.1, duration: 0.3 }}
      >
        <span className="inline-flex items-center gap-2 whitespace-nowrap max-w-full">
          <motion.svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={isDark ? 'text-primary-400' : 'text-primary-500'}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.2, duration: 0.3 }}
          >
            <path d={icon} />
          </motion.svg>
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3, duration: 0.3 }}
            className="truncate"
          >
            <span className="font-medium">{decision.label}</span>
            {decision.detail && <span className="ml-1 opacity-70">· {decision.detail}</span>}
            <span className="ml-2 opacity-50">
              {new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </motion.span>
        </span>
        {hasOptions && (
          <span className="flex items-center gap-1.5 justify-center flex-wrap">
            {decision.options!.map(option => (
              <span
                key={option}
                className={`px-2 py-0.5 rounded-full ${isDark ? 'bg-primary-700/25' : 'bg-white/70'}`}
              >
                {option}
              </span>
            ))}
          </span>
        )}
      </motion.div>
    </motion.div>
  )
}

export default function ProcessingMessageView({ message }: ProcessingMessageViewProps) {
  // A decision replaces the whole card, so this check comes before any of the
  // per-type styling below — none of which applies to a tag.
  const { resolvedTheme } = useThemeStore()
  const decision = message.type === 'debug'
    ? (message.data as DebugData).decision
    : undefined
  if (decision) {
    return <DecisionTag decision={decision} at={message.startedAt} isDark={resolvedTheme === 'dark'} />
  }

  const getIcon = () => {
    switch (message.type) {
      case 'decision': return '🧠'
      case 'prompt_execution': return '🤖'
      case 'expert_status': return '👨‍💼'
      case 'safety_check': return '🛡️'
      case 'debug': return '🔧'
      default: return '⚙️'
    }
  }

  const getColor = () => {
    switch (message.type) {
      case 'decision': return 'bg-blue-50/90 dark:bg-blue-950/90 border-blue-200/50 dark:border-blue-800/50 backdrop-blur-sm shadow-sm'
      case 'prompt_execution': return 'bg-emerald-50/90 dark:bg-emerald-950/90 border-emerald-200/50 dark:border-emerald-800/50 backdrop-blur-sm shadow-sm'
      case 'expert_status': return 'bg-amber-50/90 dark:bg-amber-950/90 border-amber-200/50 dark:border-amber-800/50 backdrop-blur-sm shadow-sm'
      case 'safety_check': return 'bg-red-50/90 dark:bg-red-950/90 border-red-200/50 dark:border-red-800/50 backdrop-blur-sm shadow-sm'
      case 'debug': return 'bg-purple-50/90 dark:bg-purple-950/90 border-purple-200/50 dark:border-purple-800/50 backdrop-blur-sm shadow-sm'
      default: return 'bg-neutral-50/90 dark:bg-neutral-900/90 border-neutral-200/50 dark:border-neutral-700/50 backdrop-blur-sm shadow-sm'
    }
  }

  const renderContent = () => {
    switch (message.type) {
      case 'decision':
        return <DecisionContent data={message.data as DecisionStreamData} />
      case 'prompt_execution':
        return <PromptExecutionContent data={message.data as PromptExecutionData} />
      case 'expert_status':
        return <ExpertStatusContent data={message.data as ExpertStatusData} />
      case 'safety_check':
        return <SafetyCheckContent data={message.data as SafetyCheckData} />
      case 'debug':
        return <DebugContent data={message.data as DebugData} />
      default:
        return <div>Unknown processing message type</div>
    }
  }

  const getParticipantName = () => {
    // Try to get participant_id from the data
    const data = message.data as any
    return data.participant_id || 'System'
  }

  return (
    <div className={`max-w-[80%] max-h-[70vh] overflow-y-auto px-3 py-2 rounded-xl border ${getColor()} text-sm`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm opacity-80">{getIcon()}</span>
        <span className="font-medium text-neutral-600 dark:text-neutral-300 text-xs">
          {getParticipantName()} • {message.type?.replace?.('_', ' ') || 'unknown'}
        </span>
        <span className="text-xs text-neutral-500 dark:text-neutral-400 ml-auto">
          {new Date(message.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      {renderContent()}
    </div>
  )
}

function DecisionContent({ data }: { data: DecisionStreamData }) {
  const isInputGateComplete = data.step === 'input_gate_complete'

  return (
    <div className="space-y-1">
      <div className="font-light text-blue-800 dark:text-blue-300 text-xs">
        {data.step.replace(/_/g, ' ')}
      </div>

      {!isInputGateComplete &&
        <div className="text-blue-700 dark:text-blue-300 text-xs font-light leading-relaxed">
          {data.decision}
        </div>
      }

      {isInputGateComplete && data.metadata && (
        <div className="border-t border-neutral-200/60 dark:border-neutral-700/60 pt-1 space-y-1">
          <div className="text-xs font-light text-neutral-600 dark:text-neutral-400">Analysis:</div>

          {data.metadata.verdict && (
            <div className="text-xs text-neutral-600 dark:text-neutral-300 bg-neutral-100/60 dark:bg-neutral-800/60 p-1.5 rounded">
              <span className="font-light text-neutral-500 dark:text-neutral-400">Verdict:</span>
              <span className={`ml-1 px-1.5 py-0.5 rounded text-xs font-light ${data.metadata.verdict === 'safe' ? 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300' : 'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300'
                }`}>
                {data.metadata.verdict}
              </span>
            </div>
          )}

          {data.metadata.route && (
            <div className="text-xs text-neutral-600 dark:text-neutral-300 bg-neutral-100/60 dark:bg-neutral-800/60 p-1.5 rounded">
              <span className="font-light text-neutral-500 dark:text-neutral-400">Route:</span>
              <div className="mt-0.5 font-light">{data.metadata.route}</div>
            </div>
          )}

          {data.metadata.intent && (
            <div className="text-xs text-neutral-600 dark:text-neutral-300 bg-neutral-100/60 dark:bg-neutral-800/60 p-1.5 rounded">
              <span className="font-light text-neutral-500 dark:text-neutral-400">Intent:</span>
              <div className="mt-0.5 font-light">{data.metadata.intent}</div>
            </div>
          )}

          {data.metadata.risk_score !== undefined && (
            <div className="text-xs text-neutral-600 dark:text-neutral-300 bg-neutral-100/60 dark:bg-neutral-800/60 p-1.5 rounded">
              <span className="font-light text-neutral-500 dark:text-neutral-400">Risk:</span>
              <div className="mt-0.5 font-light">{data.metadata.risk_score.toFixed(2)}</div>
            </div>
          )}

          {data.metadata.expert_configuration?.experts && (
            <div className="text-xs text-neutral-600 dark:text-neutral-300 bg-neutral-100/60 dark:bg-neutral-800/60 p-1.5 rounded">
              <span className="font-light text-neutral-500 dark:text-neutral-400">Experts:</span>
              <div className="mt-0.5 font-light">{data.metadata.expert_configuration.experts.join(', ')}</div>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-4 text-xs text-blue-500 dark:text-blue-400 font-light">
        <span>{data.timing_ms}ms</span>
      </div>

      {!isInputGateComplete && Object.keys(data.metadata).length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-neutral-400 dark:text-neutral-500 font-light hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors">
            Details
          </summary>
          <div className="max-h-64 overflow-y-auto mt-1 border-t border-neutral-200/40 dark:border-neutral-700/40 pt-1">
            <pre className="text-xs text-neutral-500 dark:text-neutral-400 font-light whitespace-pre-wrap break-words">
              {JSON.stringify(data.metadata, null, 2)}
            </pre>
          </div>
        </details>
      )}
    </div>
  )
}


function PromptExecutionContent({ data }: { data: PromptExecutionData }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="font-light text-emerald-800 dark:text-emerald-300 text-xs">
          {data.agent_name}
        </span>
        <span className="text-xs px-1.5 py-0.5 bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 rounded font-light">
          {data.prompt_type}
        </span>
      </div>
      <div className="text-emerald-700 dark:text-emerald-300 text-xs font-light leading-relaxed">
        {data.prompt_preview}
      </div>
      <div className="flex items-center gap-3 text-xs text-emerald-500 dark:text-emerald-400 font-light">
        <span>{data.model}</span>
        <span>•</span>
        <span>{data.temperature}</span>
        <span>•</span>
        <span>{Math.round(data.estimated_duration_ms / 1000)}s</span>
      </div>
    </div>
  )
}

function ExpertStatusContent({ data }: { data: ExpertStatusData }) {
  const getStatusColor = () => {
    switch (data.status) {
      case 'started': return 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300'
      case 'progress': return 'bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-300'
      case 'completed': return 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300'
      case 'timeout': return 'bg-orange-100 dark:bg-orange-900/50 text-orange-700 dark:text-orange-300'
      case 'error': return 'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300'
      default: return 'bg-neutral-100 dark:bg-neutral-800/50 text-neutral-700 dark:text-neutral-300'
    }
  }

  const hasCompletionData = data.status === 'completed' && data.metadata?.result
  const hasErrorData = data.status === 'error' && data.metadata?.error_message

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="font-light text-amber-800 dark:text-amber-300 text-xs">
          {data.expert_name}
        </span>
        <span className={`text-xs px-1.5 py-0.5 rounded font-light ${getStatusColor()}`}>
          {data.status}
        </span>
      </div>

      {data.progress_percent !== undefined && (
        <div className="w-full bg-amber-200/40 dark:bg-amber-800/40 rounded-full h-1">
          <div
            className="bg-gradient-to-r from-amber-400 to-amber-500 dark:from-amber-500 dark:to-amber-400 h-1 rounded-full transition-all duration-300"
            style={{ width: `${data.progress_percent}%` }}
          />
        </div>
      )}

      {data.intermediate_finding && (
        <div className="text-amber-700 dark:text-amber-300 text-xs font-light leading-relaxed">
          {data.intermediate_finding}
        </div>
      )}

      {hasCompletionData && data.metadata?.result?.findings && (
        <div className="border-t border-neutral-200/60 dark:border-neutral-700/60 pt-1">
          <details>
            <summary className="cursor-pointer text-xs font-light text-neutral-600 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200">
              Analysis ({data.metadata?.success ? '✓' : '✗'})
            </summary>
            <div className="mt-1 text-xs text-neutral-600 dark:text-neutral-300 bg-neutral-100/60 dark:bg-neutral-800/60 p-1.5 rounded whitespace-pre-wrap font-light leading-relaxed">
              {data.metadata.result.findings}
            </div>
          </details>
        </div>
      )}

      {hasErrorData && (
        <div className="border-t border-red-200/60 dark:border-red-800/60 pt-1">
          <div className="text-xs text-red-600 dark:text-red-400 font-light">
            <span className="font-medium">Error:</span> {data.metadata?.error_message}
          </div>
          {data.metadata?.error_type && (
            <div className="text-xs text-red-500 dark:text-red-400 mt-0.5 font-light">
              Type: {data.metadata.error_type}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SafetyCheckContent({ data }: { data: SafetyCheckData }) {
  const getStatusColor = () => {
    switch (data.status) {
      case 'checking': return 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300'
      case 'passed': return 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300'
      case 'warning': return 'bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-300'
      case 'blocked': return 'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300'
      default: return 'bg-neutral-100 dark:bg-neutral-800/50 text-neutral-700 dark:text-neutral-300'
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="font-light text-red-800 dark:text-red-300 text-xs">
          {data.check_type.replace(/_/g, ' ')}
        </span>
        <span className={`text-xs px-1.5 py-0.5 rounded font-light ${getStatusColor()}`}>
          {data.status}
        </span>
      </div>
      <div className="text-red-700 dark:text-red-300 text-xs font-light leading-relaxed">
        {data.details}
      </div>
    </div>
  )
}

function DebugContent({ data }: { data: DebugData }) {
  const getLevelColor = () => {
    switch (data.level) {
      case 'info': return 'bg-purple-100 dark:bg-purple-800/60 text-purple-700 dark:text-purple-200'
      case 'debug': return 'bg-neutral-100 dark:bg-neutral-700/60 text-neutral-700 dark:text-neutral-200'
      case 'warn': return 'bg-yellow-100 dark:bg-yellow-800/60 text-yellow-700 dark:text-yellow-200'
      case 'error': return 'bg-red-100 dark:bg-red-800/60 text-red-700 dark:text-red-200'
      default: return 'bg-neutral-100 dark:bg-neutral-700/60 text-neutral-700 dark:text-neutral-200'
    }
  }

  const hasMetadata = data.metadata && Object.keys(data.metadata).length > 0

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="font-mono font-medium text-purple-800 dark:text-purple-200 text-xs">
          [{data.component}]
        </span>
        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${getLevelColor()}`}>
          {data.level}
        </span>
      </div>
      <div className="text-purple-700 dark:text-purple-100 text-xs font-normal leading-relaxed">
        {data.message}
      </div>
      {hasMetadata && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-purple-500 dark:text-purple-300 font-medium hover:text-purple-700 dark:hover:text-purple-100 transition-colors">
            Metadata
          </summary>
          <div className="max-h-48 overflow-y-auto mt-1 border-t border-purple-200/40 dark:border-purple-600/40 pt-1">
            <pre className="text-xs text-purple-600 dark:text-purple-200 whitespace-pre-wrap break-words font-mono">
              {JSON.stringify(data.metadata, null, 2)}
            </pre>
          </div>
        </details>
      )}
    </div>
  )
}