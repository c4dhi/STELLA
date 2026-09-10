import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useThemeStore } from '../../../store/themeStore'
import type { StageLatency, StageDataPoint, SessionStagePoint } from '../../../lib/api-types'

// Stages that are ratios/summaries or non-latency events — excluded from timeline.
// These are handled by SummaryCards instead (safety_routing, state_transition have
// timing_ms=0 and no meaningful position on the latency timeline).
// Anchors and non-latency events excluded from the timeline visualization
const EXCLUDED_STAGES = new Set(['plan_completion', 'safety_routing', 'vad_trigger', 'stt_end'])

const LANE_COLORS = [
  '#8B5CF6', // purple
  '#3B82F6', // blue
  '#22C55E', // green
  '#F59E0B', // amber
  '#EF4444', // red
  '#06B6D4', // cyan
  '#EC4899', // pink
  '#F97316', // orange
]

const LANE_HEIGHT = 48
const LANE_GAP = 4
const AXIS_HEIGHT = 32
const LEFT_LABEL_WIDTH = 140
const RIGHT_PADDING = 24
const TOP_PADDING = 8

interface StageTimelineProps {
  stages: StageLatency[]
  mode: 'aggregate' | 'session'
  // Aggregate mode: drill-down data (per-session averages)
  selectedStage?: string | null
  onStageSelect?: (stageName: string | null) => void
  selectedStagePoints?: StageDataPoint[]
  // Session mode: individual raw measurements
  sessionPoints?: SessionStagePoint[]
  // Callback when a session row is clicked in the drill-down
  onSessionClick?: (sessionId: string) => void
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

/**
 * Largest timing across the stages, or 0 when there is nothing to plot.
 *
 * A stage row can legitimately exist with every timing at zero: the backend
 * keeps timeline events whose `elapsed_ms` is 0, and any turn recorded without
 * an analytics anchor produces a full set of them. Feeding that 0 to the axis
 * made `ms / maxMs` evaluate 0/0 = NaN, and SVG silently coerces a NaN
 * coordinate to 0 — so every marker, gridline and tick collapsed onto the
 * origin and the chart looked broken rather than empty.
 */
export function axisCeiling(stages: Array<Pick<StageLatency, 'p95_ms' | 'max_ms' | 'mean_ms'>>): number {
  if (stages.length === 0) return 0
  const max = Math.max(...stages.map(s => s.p95_ms || s.max_ms || s.mean_ms || 0))
  return Number.isFinite(max) && max > 0 ? max : 0
}

function getAxisTicks(maxMs: number): number[] {
  if (maxMs <= 0) return [0]
  const candidates = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]
  const step = candidates.find(c => maxMs / c <= 8) || Math.ceil(maxMs / 5 / 1000) * 1000
  const ticks: number[] = []
  for (let v = 0; v <= maxMs; v += step) {
    ticks.push(v)
  }
  if (ticks[ticks.length - 1] < maxMs) ticks.push(Math.ceil(maxMs / step) * step)
  return ticks
}

export default function StageTimeline({
  stages,
  mode,
  selectedStage,
  onStageSelect,
  selectedStagePoints,
  sessionPoints,
  onSessionClick,
}: StageTimelineProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(800)

  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  // Filter out non-latency stages and sort by median ascending (cascading flow)
  const timelineStages = useMemo(
    () => stages
      .filter(s => !EXCLUDED_STAGES.has(s.stage))
      .slice()
      .sort((a, b) => a.mean_ms - b.mean_ms),
    [stages],
  )

  // Compute the max value for the axis. `ceiling` is 0 when nothing is
  // plottable; fall back to a finite axis so no coordinate can become NaN.
  const ceiling = useMemo(() => axisCeiling(timelineStages), [timelineStages])
  const maxMs = ceiling > 0 ? ceiling * 1.1 : 100 // 10% padding

  const chartWidth = containerWidth - LEFT_LABEL_WIDTH - RIGHT_PADDING
  const svgHeight = TOP_PADDING + timelineStages.length * (LANE_HEIGHT + LANE_GAP) + AXIS_HEIGHT

  const msToX = useCallback(
    (ms: number) => LEFT_LABEL_WIDTH + (ms / maxMs) * chartWidth,
    [maxMs, chartWidth],
  )

  const ticks = useMemo(() => getAxisTicks(maxMs), [maxMs])

  const handleLaneClick = useCallback(
    (stageName: string) => {
      if (!onStageSelect) return
      onStageSelect(selectedStage === stageName ? null : stageName)
    },
    [onStageSelect, selectedStage],
  )

  // Two distinct empty states. "No stages at all" and "stages that carry no
  // timing" are different problems, and collapsing them into one message sent
  // people looking for a missing endpoint when the data was simply unmeasured.
  if (timelineStages.length === 0 || ceiling === 0) {
    return (
      <div className={`rounded-xl p-8 text-center ${isDark ? 'bg-surface-dark-secondary' : 'bg-white border border-neutral-200'}`}>
        <p className={isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}>
          {timelineStages.length === 0
            ? 'No analytics data available'
            : 'No timing data recorded for this session'}
        </p>
        {timelineStages.length > 0 && (
          <p className={`text-xs mt-2 ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
            {timelineStages.length} stage{timelineStages.length !== 1 ? 's' : ''} were recorded, but every
            measurement is 0ms — the turn had no analytics anchor.
          </p>
        )}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={`rounded-xl overflow-hidden ${isDark ? 'bg-surface-dark-secondary' : 'bg-white border border-neutral-200'}`}
    >
      {/* Header */}
      <div className={`flex items-center justify-between px-5 py-3 border-b ${isDark ? 'border-border-dark' : 'border-neutral-200'}`}>
        <div className="flex items-center gap-2">
          <h3 className={`text-sm font-semibold ${isDark ? 'text-content-inverse' : 'text-content'}`}>
            Pipeline Timeline
          </h3>
          <span className={`text-xs px-2 py-0.5 rounded-full ${isDark ? 'bg-surface-dark-tertiary text-content-inverse-secondary' : 'bg-neutral-100 text-content-secondary'}`}>
            {mode === 'aggregate' ? 'Aggregated' : 'Session'}
          </span>
        </div>
        <div className={`text-xs ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
          STT endpoint → ms
        </div>
      </div>

      {/* SVG Timeline */}
      <div className="p-5 overflow-x-auto">
        <svg
          width={containerWidth - 40}
          height={svgHeight}
          className="select-none"
        >
          {/* Grid lines */}
          {ticks.map((tick) => (
            <line
              key={tick}
              x1={msToX(tick)}
              y1={TOP_PADDING}
              x2={msToX(tick)}
              y2={svgHeight - AXIS_HEIGHT}
              stroke={isDark ? '#374151' : '#E5E7EB'}
              strokeDasharray="3 3"
            />
          ))}

          {/* Swim lanes */}
          {timelineStages.map((stage, i) => {
            const y = TOP_PADDING + i * (LANE_HEIGHT + LANE_GAP)
            const color = LANE_COLORS[i % LANE_COLORS.length]
            const isSelected = selectedStage === stage.stage
            const isDimmed = selectedStage != null && !isSelected

            return (
              <g
                key={stage.stage}
                opacity={isDimmed ? 0.15 : 1}
                style={{ cursor: onStageSelect ? 'pointer' : 'default', transition: 'opacity 0.2s' }}
                onClick={() => handleLaneClick(stage.stage)}
              >
                {/* Lane background */}
                <rect
                  x={LEFT_LABEL_WIDTH}
                  y={y}
                  width={chartWidth}
                  height={LANE_HEIGHT}
                  rx={6}
                  fill={isDark ? '#1F293780' : '#F9FAFB80'}
                />

                {/* Stage label */}
                <text
                  x={LEFT_LABEL_WIDTH - 8}
                  y={y + LANE_HEIGHT / 2}
                  textAnchor="end"
                  dominantBaseline="central"
                  fontSize={11}
                  fontFamily="monospace"
                  fill={isDark ? '#9CA3AF' : '#6B7280'}
                >
                  {stage.stage}
                </text>

                {mode === 'aggregate' ? (
                  <BoxPlotMarker stage={stage} y={y} color={color} msToX={msToX} />
                ) : (
                  <SessionMarkers
                    stageName={stage.stage}
                    sessionPoints={sessionPoints || []}
                    y={y}
                    color={color}
                    msToX={msToX}
                  />
                )}

                {/* Count badge */}
                <text
                  x={LEFT_LABEL_WIDTH + chartWidth + 4}
                  y={y + LANE_HEIGHT / 2}
                  dominantBaseline="central"
                  fontSize={10}
                  fill={isDark ? '#6B7280' : '#9CA3AF'}
                >
                  n={stage.count}
                </text>
              </g>
            )
          })}

          {/* X Axis */}
          <g transform={`translate(0, ${svgHeight - AXIS_HEIGHT + 4})`}>
            <line
              x1={LEFT_LABEL_WIDTH}
              y1={0}
              x2={LEFT_LABEL_WIDTH + chartWidth}
              y2={0}
              stroke={isDark ? '#4B5563' : '#D1D5DB'}
            />
            {/* Arrow */}
            <polygon
              points={`${LEFT_LABEL_WIDTH + chartWidth - 6},-4 ${LEFT_LABEL_WIDTH + chartWidth + 2},0 ${LEFT_LABEL_WIDTH + chartWidth - 6},4`}
              fill={isDark ? '#4B5563' : '#D1D5DB'}
            />
            {ticks.map((tick) => (
              <g key={tick} transform={`translate(${msToX(tick)}, 0)`}>
                <line y1={0} y2={5} stroke={isDark ? '#4B5563' : '#D1D5DB'} />
                <text
                  y={18}
                  textAnchor="middle"
                  fontSize={10}
                  fill={isDark ? '#9CA3AF' : '#6B7280'}
                >
                  {formatMs(tick)}
                </text>
              </g>
            ))}
          </g>
        </svg>

        {/* Drill-down overlay */}
        <AnimatePresence>
          {selectedStage && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <DrillDownPanel
                stageName={selectedStage}
                stage={timelineStages.find(s => s.stage === selectedStage)!}
                mode={mode}
                dataPoints={selectedStagePoints}
                sessionPoints={sessionPoints?.filter(p => p.stage === selectedStage)}
                msToX={msToX}
                chartWidth={chartWidth}
                isDark={isDark}
                onSessionClick={onSessionClick}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

// =============================================================================
// Sub-components
// =============================================================================

/** Box plot for aggregate latency stages */
function BoxPlotMarker({
  stage,
  y,
  color,
  msToX,
}: {
  stage: StageLatency
  y: number
  color: string
  msToX: (ms: number) => number
}) {
  const cy = y + LANE_HEIGHT / 2
  const boxH = 18
  const whiskerH = 10

  const x5 = msToX(stage.p5_ms)
  const x25 = msToX(stage.p25_ms)
  const x50 = msToX(stage.p50_ms)
  const x75 = msToX(stage.p75_ms)
  const x95 = msToX(stage.p95_ms)

  return (
    <g>
      {/* Whisker line p5 → p95 */}
      <line x1={x5} y1={cy} x2={x95} y2={cy} stroke={color} strokeWidth={1.5} />
      {/* Whisker caps */}
      <line x1={x5} y1={cy - whiskerH / 2} x2={x5} y2={cy + whiskerH / 2} stroke={color} strokeWidth={1.5} />
      <line x1={x95} y1={cy - whiskerH / 2} x2={x95} y2={cy + whiskerH / 2} stroke={color} strokeWidth={1.5} />
      {/* IQR box p25 → p75 */}
      <rect
        x={x25}
        y={cy - boxH / 2}
        width={Math.max(x75 - x25, 2)}
        height={boxH}
        rx={3}
        fill={color}
        opacity={0.25}
        stroke={color}
        strokeWidth={1.5}
      />
      {/* Median line */}
      <line x1={x50} y1={cy - boxH / 2} x2={x50} y2={cy + boxH / 2} stroke={color} strokeWidth={2.5} />
      {/* Median value label */}
      <text
        x={x50}
        y={cy - boxH / 2 - 5}
        textAnchor="middle"
        fontSize={9}
        fontWeight={600}
        fill={color}
      >
        {formatMs(stage.p50_ms)}
      </text>
    </g>
  )
}

/** Individual session measurement dots */
function SessionMarkers({
  stageName,
  sessionPoints,
  y,
  color,
  msToX,
}: {
  stageName: string
  sessionPoints: SessionStagePoint[]
  y: number
  color: string
  msToX: (ms: number) => number
}) {
  const points = sessionPoints.filter(p => p.stage === stageName)
  const cy = y + LANE_HEIGHT / 2

  if (points.length === 0) return null

  // If multiple points, show them as dots; compute the avg for a marker
  const avg = points.reduce((s, p) => s + p.timing_ms, 0) / points.length
  const cx = msToX(avg)

  return (
    <g>
      {points.length > 1 && points.map((p, i) => (
        <circle
          key={i}
          cx={msToX(p.timing_ms)}
          cy={cy}
          r={3}
          fill={color}
          opacity={0.4}
        />
      ))}
      {/* Average marker */}
      <circle cx={cx} cy={cy} r={5} fill={color} opacity={0.9} />
      <text
        x={cx}
        y={cy - 10}
        textAnchor="middle"
        fontSize={9}
        fontWeight={600}
        fill={color}
      >
        {formatMs(avg)}
      </text>
    </g>
  )
}

/** Drill-down panel showing individual data points + stats + session list */
function DrillDownPanel({
  stageName,
  stage,
  mode,
  dataPoints,
  sessionPoints,
  msToX,
  chartWidth,
  isDark,
  onSessionClick,
}: {
  stageName: string
  stage: StageLatency
  mode: 'aggregate' | 'session'
  dataPoints?: StageDataPoint[]
  sessionPoints?: SessionStagePoint[]
  msToX: (ms: number) => number
  chartWidth: number
  isDark: boolean
  onSessionClick?: (sessionId: string) => void
}) {
  const [sortBy, setSortBy] = useState<'timing' | 'name'>('timing')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const handleSort = (col: 'timing' | 'name') => {
    if (sortBy === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(col)
      setSortDir(col === 'timing' ? 'desc' : 'asc')
    }
  }

  // Outlier threshold: > 2x median
  const outlierThreshold = stage.p50_ms * 2

  if (mode === 'session') {
    const points = (sessionPoints || []).map(p => ({
      value: p.timing_ms,
      label: new Date(p.timestamp).toLocaleTimeString(),
    }))

    return (
      <div className={`mt-3 rounded-lg p-4 ${isDark ? 'bg-surface-dark-tertiary' : 'bg-neutral-50'}`}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <span className={`text-sm font-semibold font-mono ${isDark ? 'text-content-inverse' : 'text-content'}`}>
              {stageName}
            </span>
            <span className={`text-xs ml-2 ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
              Individual measurements
            </span>
          </div>
        </div>
        <StatsGrid stage={stage} isDark={isDark} />
        {points.length > 0 ? (
          <ScatterPlot points={points} msToX={msToX} chartWidth={chartWidth} isDark={isDark} />
        ) : (
          <p className={`text-xs ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
            No measurements for this stage
          </p>
        )}
      </div>
    )
  }

  // Aggregate mode: show per-session list
  const sortedSessions = useMemo(() => {
    const sessions = [...(dataPoints || [])]
    sessions.sort((a, b) => {
      if (sortBy === 'timing') {
        return sortDir === 'desc' ? b.avg_timing_ms - a.avg_timing_ms : a.avg_timing_ms - b.avg_timing_ms
      }
      return sortDir === 'asc'
        ? a.sessionName.localeCompare(b.sessionName)
        : b.sessionName.localeCompare(a.sessionName)
    })
    return sessions
  }, [dataPoints, sortBy, sortDir])

  const outlierCount = sortedSessions.filter(s => s.avg_timing_ms > outlierThreshold).length

  return (
    <div className={`mt-3 rounded-lg p-4 ${isDark ? 'bg-surface-dark-tertiary' : 'bg-neutral-50'}`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <span className={`text-sm font-semibold font-mono ${isDark ? 'text-content-inverse' : 'text-content'}`}>
            {stageName}
          </span>
          <span className={`text-xs ml-2 ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
            {sortedSessions.length} session{sortedSessions.length !== 1 ? 's' : ''}
          </span>
          {outlierCount > 0 && (
            <span className="text-xs ml-2 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-600 font-medium">
              {outlierCount} outlier{outlierCount !== 1 ? 's' : ''} (&gt;2x P50)
            </span>
          )}
        </div>
      </div>

      <StatsGrid stage={stage} isDark={isDark} />

      {/* Scatter plot */}
      {sortedSessions.length > 0 && (
        <ScatterPlot
          points={sortedSessions.map(s => ({
            value: s.avg_timing_ms,
            label: s.sessionName,
            isOutlier: s.avg_timing_ms > outlierThreshold,
          }))}
          msToX={msToX}
          chartWidth={chartWidth}
          isDark={isDark}
          outlierThreshold={outlierThreshold}
        />
      )}

      {/* Session list */}
      {sortedSessions.length > 0 ? (
        <div className="mt-3 max-h-48 overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className={isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}>
                <th
                  className="text-left pb-2 font-medium cursor-pointer select-none"
                  onClick={() => handleSort('name')}
                >
                  Session {sortBy === 'name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </th>
                <th
                  className="text-right pb-2 font-medium cursor-pointer select-none"
                  onClick={() => handleSort('timing')}
                >
                  Avg {sortBy === 'timing' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </th>
                <th className="text-right pb-2 font-medium">Turns</th>
                <th className="text-right pb-2 font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {sortedSessions.map((s) => {
                const isOutlier = s.avg_timing_ms > outlierThreshold
                const clickable = !!onSessionClick
                return (
                  <tr
                    key={s.sessionId}
                    onClick={clickable ? () => onSessionClick(s.sessionId) : undefined}
                    className={`border-t ${clickable ? 'cursor-pointer' : ''} ${
                      isOutlier
                        ? isDark
                          ? 'border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/10'
                          : 'border-amber-200 bg-amber-50/50 hover:bg-amber-50'
                        : isDark
                          ? 'border-border-dark hover:bg-surface-dark-secondary'
                          : 'border-neutral-100 hover:bg-neutral-50'
                    } transition-colors`}
                  >
                    <td className={`py-1.5 pr-3 truncate max-w-[200px] ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                      {isOutlier && <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 mr-1.5" />}
                      {s.sessionName}
                    </td>
                    <td className={`py-1.5 text-right tabular-nums font-mono ${
                      isOutlier
                        ? 'text-amber-600 font-semibold'
                        : isDark ? 'text-content-inverse' : 'text-content'
                    }`}>
                      {formatMs(s.avg_timing_ms)}
                    </td>
                    <td className={`py-1.5 text-right tabular-nums ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                      {s.count}
                    </td>
                    <td className={`py-1.5 text-right ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                      {new Date(s.timestamp).toLocaleDateString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={`text-xs ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
          Loading session data...
        </p>
      )}
    </div>
  )
}

/** Reusable stats grid for drill-down */
function StatsGrid({ stage, isDark }: { stage: StageLatency; isDark: boolean }) {
  return (
    <div className="grid grid-cols-4 sm:grid-cols-7 gap-3 mb-4">
      {[
        { label: 'Count', value: stage.count.toString() },
        { label: 'Mean', value: formatMs(stage.mean_ms) },
        { label: 'P5', value: formatMs(stage.p5_ms) },
        { label: 'P25', value: formatMs(stage.p25_ms) },
        { label: 'P50', value: formatMs(stage.p50_ms) },
        { label: 'P75', value: formatMs(stage.p75_ms) },
        { label: 'P95', value: formatMs(stage.p95_ms) },
      ].map(({ label, value }) => (
        <div key={label} className="text-center">
          <div className={`text-xs ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
            {label}
          </div>
          <div className={`text-sm font-semibold tabular-nums ${isDark ? 'text-content-inverse' : 'text-content'}`}>
            {value}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Scatter plot with optional outlier threshold line */
function ScatterPlot({
  points,
  msToX,
  chartWidth,
  isDark,
  outlierThreshold,
}: {
  points: Array<{ value: number; label: string; isOutlier?: boolean }>
  msToX: (ms: number) => number
  chartWidth: number
  isDark: boolean
  outlierThreshold?: number
}) {
  return (
    <div className="overflow-x-auto">
      <svg width={LEFT_LABEL_WIDTH + chartWidth + RIGHT_PADDING} height={52}>
        {/* Axis reference */}
        <line
          x1={LEFT_LABEL_WIDTH}
          y1={26}
          x2={LEFT_LABEL_WIDTH + chartWidth}
          y2={26}
          stroke={isDark ? '#374151' : '#E5E7EB'}
          strokeWidth={1}
        />
        {/* Outlier threshold line */}
        {outlierThreshold != null && (
          <>
            <line
              x1={msToX(outlierThreshold)}
              y1={8}
              x2={msToX(outlierThreshold)}
              y2={44}
              stroke="#F59E0B"
              strokeWidth={1}
              strokeDasharray="4 3"
              opacity={0.6}
            />
            <text
              x={msToX(outlierThreshold) + 4}
              y={14}
              fontSize={8}
              fill="#F59E0B"
              opacity={0.8}
            >
              2x P50
            </text>
          </>
        )}
        {points.map((p, i) => {
          const cx = msToX(p.value)
          return (
            <g key={i}>
              <circle
                cx={cx}
                cy={26}
                r={4}
                fill={p.isOutlier ? '#F59E0B' : (isDark ? '#8B5CF6' : '#7C3AED')}
                opacity={p.isOutlier ? 0.9 : 0.7}
              />
              <title>{`${formatMs(p.value)} — ${p.label}`}</title>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
