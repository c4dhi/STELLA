import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'

interface PlanCanvasNodeData {
  stateId: string
  title: string
  stateNumber: number
  taskCount: number
  isSelected: boolean
  isDark: boolean
  onDelete: (stateId: string) => void
}

function PlanCanvasNodeComponent({ data }: NodeProps) {
  const nodeData = data as unknown as PlanCanvasNodeData

  return (
    <div
      className={`group relative w-[240px] rounded-2xl border-2 px-5 py-4 transition-all ${
        nodeData.isSelected
          ? nodeData.isDark
            ? 'border-primary-400 bg-primary-500/10 shadow-[0_0_24px_rgba(139,92,246,0.15)]'
            : 'border-primary-500 bg-primary-50 shadow-[0_0_24px_rgba(139,92,246,0.1)]'
          : nodeData.isDark
            ? 'border-zinc-600/80 bg-zinc-800 hover:border-zinc-500 hover:shadow-[0_2px_16px_rgba(0,0,0,0.3)]'
            : 'border-neutral-200 bg-white hover:border-neutral-300 hover:shadow-[0_2px_16px_rgba(0,0,0,0.06)]'
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="left"
        className="!w-4 !h-4 !rounded-full !border-2 !border-white dark:!border-zinc-900 !bg-zinc-400 dark:!bg-zinc-500"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className="!w-4 !h-4 !rounded-full !border-2 !border-white dark:!border-zinc-900 !bg-zinc-400 dark:!bg-zinc-500"
      />

      <button
        onClick={(e) => {
          e.stopPropagation()
          nodeData.onDelete(nodeData.stateId)
        }}
        className={`absolute right-2 top-2 h-6 w-6 rounded-full border text-[10px] font-semibold transition-all opacity-0 group-hover:opacity-100 coarse:opacity-100 ${
          nodeData.isDark
            ? 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-red-300'
            : 'border-neutral-200 bg-white text-neutral-500 hover:text-red-600'
        }`}
        title="Delete state"
      >
        x
      </button>

      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 h-6 w-6 shrink-0 rounded-full text-center text-[11px] leading-6 font-semibold ${
            nodeData.isSelected
              ? nodeData.isDark
                ? 'bg-primary text-white'
                : 'bg-neutral-900 text-white'
              : nodeData.isDark
                ? 'bg-zinc-700 text-zinc-300'
                : 'bg-neutral-100 text-neutral-600'
          }`}
        >
          {nodeData.stateNumber}
        </div>
        <div className="min-w-0">
          <div
            className={`truncate text-[13px] font-semibold ${
              nodeData.isDark ? 'text-zinc-100' : 'text-neutral-900'
            }`}
          >
            {nodeData.title || `State ${nodeData.stateNumber}`}
          </div>
          <div
            className={`mt-1 text-[10px] font-light ${
              nodeData.isDark ? 'text-zinc-500' : 'text-neutral-400'
            }`}
          >
            {nodeData.taskCount} {nodeData.taskCount === 1 ? 'task' : 'tasks'}
          </div>
        </div>
      </div>
    </div>
  )
}

export default memo(PlanCanvasNodeComponent)
