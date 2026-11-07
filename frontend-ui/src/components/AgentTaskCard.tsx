import { motion } from 'framer-motion'
import { useStore } from '../store'
import TaskProgressBar from './TaskProgressBar'
import StateList from './StateList'
import { TodoList } from '../lib/types'

interface AgentTaskCardProps {
  agentId: string
  agentName?: string
  todoList: TodoList & { agentName?: string }
  isHistoryMode?: boolean
}

// Agent color mapping based on agentId hash
const getAgentColor = (agentId: string): string => {
  const colors = [
    'blue',
    'green',
    'purple',
    'orange',
    'pink',
    'teal',
  ]
  const hash = agentId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
  return colors[hash % colors.length]
}

export default function AgentTaskCard({ agentId, agentName, todoList, isHistoryMode = false }: AgentTaskCardProps) {
  const hideAgentTaskList = useStore(s => s.hideAgentTaskList)

  const color = getAgentColor(agentId)
  const displayName = agentName || todoList.agentName || `Agent ${agentId.slice(0, 6)}`

  const currentState = todoList.current_state
  const states = todoList.states || []

  // Calculate deliverables progress from todoList structure (for accurate historical replay)
  let totalDeliverables = 0
  let completedOrSkippedDeliverables = 0

  states.forEach(state => {
    state.tasks?.forEach(task => {
      task.deliverables?.forEach(deliverable => {
        totalDeliverables++
        if (deliverable.status === 'completed' || deliverable.status === 'skipped') {
          completedOrSkippedDeliverables++
        }
      })
    })
  })

  const deliverablesProgress = totalDeliverables > 0
    ? Math.round((completedOrSkippedDeliverables / totalDeliverables) * 100)
    : 0

  return (
    <motion.div
      animate={{
        filter: isHistoryMode ? 'grayscale(100%)' : 'grayscale(0%)'
      }}
      transition={{
        duration: 0.4,
        ease: [0.16, 1, 0.3, 1]
      }}
      className={`w-72 xl:w-96 h-full flex flex-col ${isHistoryMode ? 'opacity-75' : 'opacity-100'} transition-[opacity] duration-300`}
    >
      {/* Card Container */}
      <div className={`
        bg-white/95 dark:bg-neutral-900/95 backdrop-blur-xl border
        border-${color}-200/60 dark:border-neutral-700/60
        rounded-[16px] shadow-[0_1px_30px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_30px_rgba(0,0,0,0.3)]
        h-full flex flex-col overflow-hidden
      `}>
        {/* Header with Agent Name and Close Button */}
        <div className={`
          p-3 border-b
          border-${color}-200/60 dark:border-neutral-700/60
          flex items-center justify-between
        `}>
          <h3 className="text-sm font-light text-neutral-900 dark:text-neutral-100 tracking-wide flex items-center gap-1.5">
            <span className="text-base">{todoList.agentIcon || '🤖'}</span>
            <span>{displayName}</span>
          </h3>

          {/* Hide Button */}
          <button
            onClick={() => hideAgentTaskList(agentId)}
            className={`
              w-6 h-6 rounded-lg
              text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 hover:bg-${color}-50 dark:hover:bg-neutral-800
              transition-all duration-200
              flex items-center justify-center
            `}
            title="Hide task panel"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
              <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          </button>
        </div>

        {/* Progress Section */}
        <div className="p-3 pb-2">
          <div className="text-[10px] text-neutral-500 dark:text-neutral-400 font-light tracking-wider uppercase mb-3">
            {totalDeliverables} Deliverables
          </div>

          <TaskProgressBar
            progress={deliverablesProgress}
            currentState={completedOrSkippedDeliverables}
            totalStates={totalDeliverables}
            currentTask={todoList.current_task}
            processingMode={todoList.current_state?.type || null}
            isVisible={true}
          />
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-5 min-h-0">
          <StateList
            states={states}
            currentStateId={todoList.current_state?.id || null}
            deliverables={{}}
            lastTransition={todoList.last_transition || null}
          />
        </div>

        {/* Footer */}
        <div className={`
          px-3 py-2 border-t
          border-${color}-200/60 dark:border-neutral-700/60
          flex-shrink-0
        `}>
          <div className="text-[9px] text-neutral-500 dark:text-neutral-400 text-center tracking-wider uppercase font-light">
            {Math.round(todoList.conversation_age_minutes || 0)}m elapsed
          </div>
        </div>
      </div>
    </motion.div>
  )
}
