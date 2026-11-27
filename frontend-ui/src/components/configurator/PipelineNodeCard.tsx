/**
 * PipelineNodeCard — hybrid pipeline node with per-stage summaries.
 *
 * Slightly larger than the original PipelineNode. Shows 1-2 line summaries
 * per stage type with plan data indicators. Click opens the NodeDetailOverlay.
 */

import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'

export interface PipelineNodeCardData {
  label: string
  icon?: string
  description?: string
  nodeId?: string
  isModified?: boolean
  isSelected?: boolean
  isDark?: boolean
  // Annotation nodes
  isAnnotation?: boolean
  annotationType?: 'input' | 'output'
  // Per-stage summary data
  stageSummary?: StageSummary
  [key: string]: unknown
}

export interface StageSummary {
  /** Short lines to render inside the node */
  lines: string[]
  /** Model badge text (e.g. "gpt-5.4-mini") */
  modelBadge?: string
  /** Expert name chips: the experts a stage holds, or the order verdicts are weighed in */
  chips?: string[]
}

function PipelineNodeCardComponent({ data }: NodeProps) {
  const {
    label,
    icon,
    description,
    isModified,
    isSelected,
    isDark,
    isAnnotation,
    annotationType,
    stageSummary,
  } = data as PipelineNodeCardData

  // ---- Annotation nodes (input/output flow labels) ----
  if (isAnnotation) {
    const isInput = annotationType === 'input'
    return (
      <div className="flex items-center gap-2">
        {!isInput && (
          <Handle type="target" position={Position.Left} className="!bg-transparent !border-0 !w-0 !h-0" />
        )}
        <div
          className={`flex items-center gap-2.5 px-4 py-2.5 rounded-xl ${
            isDark
              ? 'bg-zinc-800/60 border border-zinc-700/50'
              : 'bg-neutral-50 border border-neutral-200/60'
          }`}
        >
          <div
            className={`text-[11px] font-medium tracking-wide uppercase ${
              isDark ? 'text-zinc-500' : 'text-neutral-400'
            }`}
          >
            {label}
          </div>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={isDark ? 'text-zinc-600' : 'text-neutral-300'}
          >
            <path d="M5 12h14m-7-7 7 7-7 7" />
          </svg>
        </div>
        {isInput && (
          <Handle type="source" position={Position.Right} className="!bg-transparent !border-0 !w-0 !h-0" />
        )}
      </div>
    )
  }

  // ---- Pipeline stage nodes ----
  return (
    <>
      <Handle type="target" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-3 !h-3" />
      <div
        className={`
          px-5 py-4 rounded-2xl border-2 transition-all duration-200 cursor-pointer
          w-[240px] relative
          ${
            isSelected
              ? isDark
                ? 'border-primary-400 bg-primary-500/10 shadow-[0_0_24px_rgba(139,92,246,0.15)]'
                : 'border-primary-500 bg-primary-50 shadow-[0_0_24px_rgba(139,92,246,0.1)]'
              : isDark
                ? 'border-zinc-600/80 bg-zinc-800 hover:border-zinc-500 hover:shadow-[0_2px_16px_rgba(0,0,0,0.3)]'
                : 'border-neutral-200 bg-white hover:border-neutral-300 hover:shadow-[0_2px_16px_rgba(0,0,0,0.06)]'
          }
        `}
      >
        {/* Modified indicator */}
        {isModified && (
          <div className="absolute -top-1.5 -right-1.5 flex items-center justify-center">
            <div className="w-3.5 h-3.5 rounded-full bg-amber-500 border-2 border-white dark:border-zinc-900 shadow-sm" />
          </div>
        )}

        {/* Top row: icon + label + plan badge */}
        <div className="flex items-start gap-2.5">
          <div className="text-lg leading-none mt-0.5">{icon || '\u2699\uFE0F'}</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span
                className={`text-[13px] font-semibold leading-tight ${
                  isDark ? 'text-zinc-100' : 'text-neutral-900'
                }`}
              >
                {label}
              </span>
            </div>

            {/* Description preview — clamped to 3 lines so node height stays bounded
                and cards never overlap. The full text is in the NodeDetailOverlay. */}
            {!stageSummary && description && (
              <p
                className={`text-[10px] font-light leading-snug mt-1 line-clamp-3 break-words ${
                  isDark ? 'text-zinc-500' : 'text-neutral-400'
                }`}
              >
                {description}
              </p>
            )}
          </div>
        </div>

        {/* Stage-specific summary content */}
        {stageSummary && (
          <div className="mt-2.5 space-y-1.5">
            {/* Model badge */}
            {stageSummary.modelBadge && (
              <span
                className={`inline-block text-[9px] px-1.5 py-0.5 rounded font-mono ${
                  isDark ? 'bg-zinc-700 text-zinc-400' : 'bg-neutral-100 text-neutral-500'
                }`}
              >
                {stageSummary.modelBadge}
              </span>
            )}

            {/* Summary lines */}
            {stageSummary.lines.map((line, i) => (
              <p
                key={i}
                className={`text-[10px] font-light leading-snug ${
                  isDark ? 'text-zinc-500' : 'text-neutral-400'
                }`}
              >
                {line}
              </p>
            ))}

            {/* Expert/priority chips */}
            {stageSummary.chips && stageSummary.chips.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {stageSummary.chips.slice(0, 6).map((chip) => (
                  <span
                    key={chip}
                    className={`text-[8px] px-1.5 py-0.5 rounded-md font-medium ${
                      isDark ? 'bg-zinc-700/70 text-zinc-400' : 'bg-neutral-100 text-neutral-500'
                    }`}
                  >
                    {chip}
                  </span>
                ))}
                {stageSummary.chips.length > 6 && (
                  <span
                    className={`text-[8px] px-1.5 py-0.5 rounded-md ${
                      isDark ? 'text-zinc-600' : 'text-neutral-400'
                    }`}
                  >
                    +{stageSummary.chips.length - 6}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-3 !h-3" />
      <Handle type="target" position={Position.Top} id="top" className="!bg-transparent !border-0 !w-3 !h-3" />
      <Handle type="source" position={Position.Top} id="top-source" className="!bg-transparent !border-0 !w-3 !h-3" />
      <Handle type="target" position={Position.Bottom} id="bottom" className="!bg-transparent !border-0 !w-3 !h-3" />
      <Handle type="source" position={Position.Bottom} id="bottom-source" className="!bg-transparent !border-0 !w-3 !h-3" />
    </>
  )
}

export default memo(PipelineNodeCardComponent)
