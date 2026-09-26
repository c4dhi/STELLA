import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import CapacityCard, { capacityHeadline, formatMeasuredDate } from './CapacityCard'
import type { CapacityMeasurement } from '../../../lib/api-types'

const base: CapacityMeasurement = {
  id: 'a',
  measuredAt: '2026-09-26T12:00:00.000Z',
  gpuName: 'Tesla T4',
  gpuMemoryMb: 15360,
  environment: 'development',
  sttProvider: 'whisper',
  ttsProvider: 'qwen3',
  gitRevision: 'abc',
  maxSessions: 4,
  limitedBy: ['voice starved 12.0% of playback (limit 5%)'],
  reachedTopLevel: false,
  durationSeconds: 60,
  levels: [
    { sessions: 1, stt_final_p95_ms: 600, tts_ttfa_p95_ms: 900, tts_starved_pct: 0, gpu_util_max_pct: 40, errors: 0 },
    { sessions: 4, stt_final_p95_ms: 1400, tts_ttfa_p95_ms: 2100, tts_starved_pct: 2.5, gpu_util_max_pct: 97, errors: 0 },
  ],
}

describe('CapacityCard', () => {
  it('shows the number with the GPU, environment and date', () => {
    const html = renderToStaticMarkup(<CapacityCard measurements={[base]} isLoading={false} />)
    expect(html).toContain('4 simultaneous conversations')
    expect(html).toContain('Tesla T4 (15 GB)')
    expect(html).toContain('measured 26 Sep 2026')
    expect(html).toContain('Next level failed: voice starved')
  })

  it('says "at least" when the test never found the limit', () => {
    expect(capacityHeadline({ maxSessions: 10, reachedTopLevel: true })).toBe('at least 10 simultaneous conversations')
    expect(capacityHeadline({ maxSessions: 1, reachedTopLevel: false })).toBe('1 simultaneous conversation')
    const html = renderToStaticMarkup(
      <CapacityCard measurements={[{ ...base, reachedTopLevel: true, limitedBy: [] }]} isLoading={false} />,
    )
    expect(html).toContain('without finding the limit')
  })

  it('tells the admin how to measure when nothing has been measured', () => {
    expect(renderToStaticMarkup(<CapacityCard measurements={[]} isLoading={false} />)).toContain('Not measured yet')
  })

  it('formats the date in UTC so it does not shift with the viewer', () => {
    expect(formatMeasuredDate('2026-09-26T23:30:00.000Z')).toBe('26 Sep 2026')
  })
})
