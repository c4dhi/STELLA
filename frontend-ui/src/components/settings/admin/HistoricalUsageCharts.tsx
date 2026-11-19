import { useState } from 'react'
import { motion } from 'framer-motion'
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid } from 'recharts'
import { useThemeStore } from '../../../store/themeStore'
import type { HistoricalUsageData } from '../../../lib/api-types'

interface HistoricalUsageChartsProps {
  data: HistoricalUsageData[]
  isLoading?: boolean
  onRangeChange?: (days: number) => void
}

const timeRanges = [
  { label: '7d', value: 7 },
  { label: '30d', value: 30 },
  { label: '90d', value: 90 },
]

export default function HistoricalUsageCharts({
  data,
  isLoading,
  onRangeChange,
}: HistoricalUsageChartsProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const [selectedRange, setSelectedRange] = useState(30)

  const handleRangeChange = (days: number) => {
    setSelectedRange(days)
    onRangeChange?.(days)
  }

  // Format date for chart labels
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  // Prepare chart data with formatted dates
  const chartData = data.map((d) => ({
    ...d,
    formattedDate: formatDate(d.date),
  }))

  // Take a sample of data points for x-axis labels (max 10)
  const tickCount = Math.min(chartData.length, 10)
  const tickInterval = Math.floor(chartData.length / tickCount)

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {[1, 2].map((i) => (
          <div
            key={i}
            className={`p-6 rounded-2xl ${
              isDark ? 'bg-surface-dark-secondary' : 'bg-white border border-neutral-200/60'
            }`}
          >
            <div className="animate-pulse">
              <div className={`h-6 w-40 rounded mb-4 ${isDark ? 'bg-neutral-700' : 'bg-neutral-200'}`} />
              <div className={`h-[200px] w-full rounded ${isDark ? 'bg-neutral-700' : 'bg-neutral-200'}`} />
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Time range selector */}
      <div className="flex justify-end">
        <div
          className={`inline-flex rounded-lg p-1 ${
            isDark ? 'bg-surface-dark-tertiary' : 'bg-surface-secondary'
          }`}
        >
          {timeRanges.map(({ label, value }) => (
            <motion.button
              key={value}
              onClick={() => handleRangeChange(value)}
              className={`px-3 coarse:px-4 py-1.5 text-caption font-medium rounded-md transition-colors ${
                selectedRange === value
                  ? isDark
                    ? 'bg-primary text-white'
                    : 'bg-white text-content shadow-sm'
                  : isDark
                    ? 'text-content-inverse-secondary hover:text-content-inverse'
                    : 'text-content-secondary hover:text-content'
              }`}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              {label}
            </motion.button>
          ))}
        </div>
      </div>

      {/* Charts grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Sessions Created Chart */}
        <div
          className={`p-6 rounded-2xl ${
            isDark ? 'bg-surface-dark-secondary' : 'bg-white border border-neutral-200/60'
          }`}
        >
          <h3
            className={`text-heading-sm font-semibold mb-4 ${
              isDark ? 'text-content-inverse' : 'text-content'
            }`}
          >
            Sessions Created
          </h3>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 10, right: 10, bottom: 20, left: 10 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={isDark ? '#374151' : '#E5E7EB'}
                  vertical={false}
                />
                <XAxis
                  dataKey="formattedDate"
                  tick={{ fontSize: 10, fill: isDark ? '#9CA3AF' : '#6B7280' }}
                  tickLine={false}
                  axisLine={{ stroke: isDark ? '#374151' : '#E5E7EB' }}
                  interval={tickInterval}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: isDark ? '#9CA3AF' : '#6B7280' }}
                  tickLine={false}
                  axisLine={false}
                  width={30}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: isDark ? '#1F2937' : '#FFFFFF',
                    borderColor: isDark ? '#374151' : '#E5E7EB',
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                  formatter={(value) => [value ?? 0, 'Sessions']}
                  labelFormatter={(label) => `Date: ${label}`}
                />
                <Bar
                  dataKey="sessionsCreated"
                  fill="#8B5CF6"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={20}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Peak Participants Chart */}
        <div
          className={`p-6 rounded-2xl ${
            isDark ? 'bg-surface-dark-secondary' : 'bg-white border border-neutral-200/60'
          }`}
        >
          <h3
            className={`text-heading-sm font-semibold mb-4 ${
              isDark ? 'text-content-inverse' : 'text-content'
            }`}
          >
            Peak Concurrent Participants
          </h3>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 10, right: 10, bottom: 20, left: 10 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={isDark ? '#374151' : '#E5E7EB'}
                  vertical={false}
                />
                <XAxis
                  dataKey="formattedDate"
                  tick={{ fontSize: 10, fill: isDark ? '#9CA3AF' : '#6B7280' }}
                  tickLine={false}
                  axisLine={{ stroke: isDark ? '#374151' : '#E5E7EB' }}
                  interval={tickInterval}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: isDark ? '#9CA3AF' : '#6B7280' }}
                  tickLine={false}
                  axisLine={false}
                  width={30}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: isDark ? '#1F2937' : '#FFFFFF',
                    borderColor: isDark ? '#374151' : '#E5E7EB',
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                  formatter={(value) => [value ?? 0, 'Peak']}
                  labelFormatter={(label) => `Date: ${label}`}
                />
                <Bar
                  dataKey="peakParticipants"
                  fill="#22C55E"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={20}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  )
}
