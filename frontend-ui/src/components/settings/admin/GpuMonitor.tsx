import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip } from 'recharts'
import { useThemeStore } from '../../../store/themeStore'
import { parseMemoryValue, formatBytes } from '../../../hooks/useServerMetrics'
import type { ServerMetrics, GpuDeviceMetrics, CapacityMeasurement } from '../../../lib/api-types'
import { CapacityModal } from './CapacityCard'

interface GpuMonitorProps {
  currentMetrics: ServerMetrics | null
  metricsHistory: ServerMetrics[]
  isConnected: boolean
  /** Measured voice capacity; shown in a modal behind the info icon next to the title. */
  capacity?: { measurements: CapacityMeasurement[]; isLoading: boolean }
}

const GPU_COLORS = ['#A855F7', '#EC4899', '#F97316', '#06B6D4', '#84CC16', '#EAB308']

function usageColor(value: number, base: string): string {
  if (value >= 90) return '#EF4444'
  if (value >= 70) return '#EAB308'
  return base
}

function tempClasses(temp: number, isDark: boolean): string {
  if (temp >= 85) return isDark ? 'bg-red-500/15 text-red-400' : 'bg-red-50 text-red-600'
  if (temp >= 70) return isDark ? 'bg-amber-500/15 text-amber-400' : 'bg-amber-50 text-amber-700'
  return isDark ? 'bg-emerald-500/15 text-emerald-400' : 'bg-emerald-50 text-emerald-700'
}

function shortName(name: string): string {
  return name.replace(/^NVIDIA\s+(GeForce\s+)?/i, '').trim() || name
}

// ---------------------------------------------------------------------------
// Full-size Gauge — matches ServerPerformanceMonitor exactly
// ---------------------------------------------------------------------------

interface GaugeProps {
  value: number
  label: string
  sublabel?: string
  color: string
}

function Gauge({ value, label, sublabel, color }: GaugeProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const radius = 40
  const circumference = 2 * Math.PI * radius
  const progress = (value / 100) * circumference

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-24 h-24">
        <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
          <circle
            cx="50" cy="50" r={radius} fill="none"
            stroke={isDark ? '#374151' : '#E5E7EB'} strokeWidth="8"
          />
          <motion.circle
            cx="50" cy="50" r={radius} fill="none"
            stroke={color} strokeWidth="8" strokeLinecap="round"
            initial={{ strokeDasharray: `0 ${circumference}` }}
            animate={{ strokeDasharray: `${progress} ${circumference}` }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <motion.span
            className={`text-xl font-bold ${isDark ? 'text-content-inverse' : 'text-content'}`}
            key={value}
            initial={{ scale: 1.1 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          >
            {Math.round(value)}%
          </motion.span>
        </div>
      </div>
      <div className={`text-body-sm font-medium mt-2 ${isDark ? 'text-content-inverse' : 'text-content'}`}>
        {label}
      </div>
      {sublabel && (
        <div className={`text-caption ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
          {sublabel}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-GPU widget — self-contained card with mini gauges + temperature
// ---------------------------------------------------------------------------

function GpuWidget({ gpu, color, isDark }: { gpu: GpuDeviceMetrics; color: string; isDark: boolean }) {
  const memUsed = parseMemoryValue(gpu.memoryUsed)
  const memTotal = parseMemoryValue(gpu.memoryTotal)
  const vramPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0

  const loadColor = usageColor(gpu.usage, color)
  const vramColor = usageColor(vramPct, color)

  const r = 28
  const circ = 2 * Math.PI * r
  const loadArc = (gpu.usage / 100) * circ
  const vramArc = (vramPct / 100) * circ

  return (
    <div
      className={`p-4 rounded-xl ${isDark ? 'bg-white/[0.03]' : 'bg-neutral-50/80'}`}
      style={{ borderLeft: `3px solid ${color}` }}
    >
      {/* Header: GPU name + temperature badge */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
          <span
            className={`text-body-sm font-semibold truncate ${
              isDark ? 'text-content-inverse' : 'text-content'
            }`}
          >
            GPU {gpu.index} — {shortName(gpu.name)}
          </span>
        </div>
        {gpu.temperature !== null && (
          <span
            className={`text-caption font-medium px-2 py-0.5 rounded-full shrink-0 ml-2 ${tempClasses(gpu.temperature, isDark)}`}
          >
            {Math.round(gpu.temperature)}°C
          </span>
        )}
      </div>

      {/* Mini gauge pair */}
      <div className="flex justify-center gap-5">
        {/* Load gauge */}
        <div className="flex flex-col items-center">
          <div className="relative w-[4.5rem] h-[4.5rem]">
            <svg className="w-full h-full transform -rotate-90" viewBox="0 0 72 72">
              <circle
                cx="36" cy="36" r={r} fill="none"
                stroke={isDark ? '#374151' : '#E5E7EB'} strokeWidth="6"
              />
              <motion.circle
                cx="36" cy="36" r={r} fill="none"
                stroke={loadColor} strokeWidth="6" strokeLinecap="round"
                initial={{ strokeDasharray: `0 ${circ}` }}
                animate={{ strokeDasharray: `${loadArc} ${circ}` }}
                transition={{ duration: 0.5, ease: 'easeOut' }}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span
                className={`text-base font-bold tabular-nums ${
                  isDark ? 'text-content-inverse' : 'text-content'
                }`}
              >
                {Math.round(gpu.usage)}%
              </span>
            </div>
          </div>
          <span
            className={`text-caption font-medium mt-1.5 ${
              isDark ? 'text-content-inverse' : 'text-content'
            }`}
          >
            Load
          </span>
        </div>

        {/* VRAM gauge */}
        <div className="flex flex-col items-center">
          <div className="relative w-[4.5rem] h-[4.5rem]">
            <svg className="w-full h-full transform -rotate-90" viewBox="0 0 72 72">
              <circle
                cx="36" cy="36" r={r} fill="none"
                stroke={isDark ? '#374151' : '#E5E7EB'} strokeWidth="6"
              />
              <motion.circle
                cx="36" cy="36" r={r} fill="none"
                stroke={vramColor} strokeWidth="6" strokeLinecap="round"
                initial={{ strokeDasharray: `0 ${circ}` }}
                animate={{ strokeDasharray: `${vramArc} ${circ}` }}
                transition={{ duration: 0.5, ease: 'easeOut' }}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span
                className={`text-base font-bold tabular-nums ${
                  isDark ? 'text-content-inverse' : 'text-content'
                }`}
              >
                {Math.round(vramPct)}%
              </span>
            </div>
          </div>
          <span
            className={`text-caption font-medium mt-1.5 ${
              isDark ? 'text-content-inverse' : 'text-content'
            }`}
          >
            VRAM
          </span>
          <span
            className={`text-caption ${
              isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
            }`}
          >
            {formatBytes(memUsed)} / {formatBytes(memTotal)}
          </span>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function GpuMonitor({
  currentMetrics,
  metricsHistory,
  isConnected,
  capacity,
}: GpuMonitorProps) {
  const [capacityOpen, setCapacityOpen] = useState(false)
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  const gpus = currentMetrics?.gpus ?? []
  const hasGpus = gpus.length > 0
  const isSingle = gpus.length === 1

  // Single-GPU derived values
  const sg = isSingle ? gpus[0] : null
  const sgColor = GPU_COLORS[0]
  const sgMemUsed = sg ? parseMemoryValue(sg.memoryUsed) : 0
  const sgMemTotal = sg ? parseMemoryValue(sg.memoryTotal) : 0
  const sgVramPct = sgMemTotal > 0 ? (sgMemUsed / sgMemTotal) * 100 : 0
  const sgSublabel =
    sg?.temperature != null
      ? `${shortName(sg.name)} · ${Math.round(sg.temperature)}°C`
      : sg ? shortName(sg.name) : ''

  // Chart data — all GPUs overlaid
  const chartData = useMemo(() => {
    if (!hasGpus) return []
    return metricsHistory.map((m, i) => {
      const pt: Record<string, number> = { index: i }
      for (const g of m.gpus ?? []) {
        pt[`gpu${g.index}_load`] = g.usage
        const used = parseMemoryValue(g.memoryUsed)
        const total = parseMemoryValue(g.memoryTotal)
        pt[`gpu${g.index}_vram`] = total > 0 ? (used / total) * 100 : 0
      }
      return pt
    })
  }, [metricsHistory, hasGpus])

  // Reusable chart
  const chart = (
    <div className="h-[140px]">
      {chartData.length > 1 ? (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
            <XAxis dataKey="index" hide />
            <YAxis domain={[0, 100]} hide />
            <Tooltip
              contentStyle={{
                backgroundColor: isDark ? '#1F2937' : '#FFFFFF',
                borderColor: isDark ? '#374151' : '#E5E7EB',
                borderRadius: '8px',
                fontSize: '12px',
              }}
              formatter={(value, name) => {
                const s = String(name)
                const idx = s.match(/gpu(\d+)/)?.[1] ?? '?'
                const type = s.includes('vram') ? 'VRAM' : 'Load'
                const label = gpus.length > 1 ? `GPU ${idx} ${type}` : type
                return [`${(value as number ?? 0).toFixed(1)}%`, label]
              }}
              labelFormatter={() => ''}
            />
            {gpus.map((g) => (
              <Line
                key={`load-${g.index}`}
                type="monotone"
                dataKey={`gpu${g.index}_load`}
                stroke={GPU_COLORS[g.index % GPU_COLORS.length]}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            ))}
            {gpus.map((g) => (
              <Line
                key={`vram-${g.index}`}
                type="monotone"
                dataKey={`gpu${g.index}_vram`}
                stroke={GPU_COLORS[g.index % GPU_COLORS.length]}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div
          className={`h-full flex items-center justify-center ${
            isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
          }`}
        >
          <span className="text-caption">Collecting data...</span>
        </div>
      )}
    </div>
  )

  // Reusable legend
  const legend = (
    <div className="flex flex-wrap justify-center gap-4 mt-3">
      {gpus.length > 1 &&
        gpus.map((g) => (
          <div key={g.index} className="flex items-center gap-1.5">
            <div
              className="w-2.5 h-2.5 rounded-full"
              style={{ backgroundColor: GPU_COLORS[g.index % GPU_COLORS.length] }}
            />
            <span
              className={`text-caption ${
                isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
              }`}
            >
              GPU {g.index}
            </span>
          </div>
        ))}
      <div className="flex items-center gap-1.5">
        <svg width="14" height="2" className="shrink-0">
          <line x1="0" y1="1" x2="14" y2="1" stroke={isDark ? '#9CA3AF' : '#6B7280'} strokeWidth="2" />
        </svg>
        <span className={`text-caption ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
          Load
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <svg width="14" height="2" className="shrink-0">
          <line x1="0" y1="1" x2="14" y2="1" stroke={isDark ? '#9CA3AF' : '#6B7280'} strokeWidth="2" strokeDasharray="4 3" />
        </svg>
        <span className={`text-caption ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
          VRAM
        </span>
      </div>
    </div>
  )

  return (
    <div
      className={`p-6 rounded-2xl ${
        isDark ? 'bg-surface-dark-secondary' : 'bg-white border border-neutral-200/60'
      } ${!hasGpus ? 'opacity-50' : ''}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h3
          className={`text-heading-sm font-semibold ${
            isDark ? 'text-content-inverse' : 'text-content'
          }`}
        >
          GPU Performance
          {capacity && (
            <button
              type="button"
              onClick={() => setCapacityOpen(true)}
              aria-label="How many conversations this GPU carries"
              title="How many conversations this GPU carries"
              data-testid="capacity-info"
              className={`ml-2 inline-flex align-middle ${
                isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
              }`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
            </button>
          )}
        </h3>
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${
              !hasGpus
                ? isDark ? 'bg-neutral-600' : 'bg-neutral-300'
                : isConnected ? 'bg-green-500' : 'bg-red-500'
            }`}
          />
          <span
            className={`text-caption ${
              isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
            }`}
          >
            {hasGpus ? (isConnected ? 'Live' : 'Disconnected') : 'No GPU detected'}
          </span>
        </div>
      </div>

      {/* No GPU */}
      {!hasGpus && (
        <div
          className={`flex flex-col items-center justify-center py-8 ${
            isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
          }`}
        >
          <svg
            width="40" height="40" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="1.5"
            className="mb-3 opacity-40"
          >
            <rect x="2" y="6" width="20" height="12" rx="2" />
            <path d="M6 10h4v4H6z" />
            <path d="M14 10h4" />
            <path d="M14 14h4" />
          </svg>
          <p className="text-body-sm">No NVIDIA GPU available on this server</p>
          <p className="text-caption mt-1">
            GPU metrics will appear automatically when a GPU is detected
          </p>
        </div>
      )}

      {/* Single GPU — full-size gauges left | chart right */}
      {isSingle && sg && (
        <div className="flex gap-8">
          <div
            className={`flex gap-6 shrink-0 pr-8 border-r ${
              isDark ? 'border-border-dark' : 'border-border'
            }`}
          >
            <Gauge
              value={sg.usage}
              label="Load"
              sublabel={sgSublabel}
              color={usageColor(sg.usage, sgColor)}
            />
            <Gauge
              value={sgVramPct}
              label="VRAM"
              sublabel={`${formatBytes(sgMemUsed)} / ${formatBytes(sgMemTotal)}`}
              color={usageColor(sgVramPct, sgColor)}
            />
          </div>
          <div className="flex-1 min-w-0">
            {chart}
            {legend}
          </div>
        </div>
      )}

      {/* Multiple GPUs — per-GPU widget cards + shared chart */}
      {gpus.length > 1 && (
        <>
          <div
            className={`grid gap-3 mb-5 grid-cols-1 sm:grid-cols-2 ${
              gpus.length === 3 ? 'lg:grid-cols-3' : ''
            }`}
          >
            {gpus.map((g) => (
              <GpuWidget
                key={g.index}
                gpu={g}
                color={GPU_COLORS[g.index % GPU_COLORS.length]}
                isDark={isDark}
              />
            ))}
          </div>
          {chart}
          {legend}
        </>
      )}
      {capacity && capacityOpen && (
        <CapacityModal
          measurements={capacity.measurements}
          isLoading={capacity.isLoading}
          onClose={() => setCapacityOpen(false)}
        />
      )}
    </div>
  )
}
