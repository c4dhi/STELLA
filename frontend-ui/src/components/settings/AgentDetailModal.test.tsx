import { describe, it, expect } from 'vitest'
import { storedBuildLog } from './AgentDetailModal'
import type { AgentBuildStatus } from '../../lib/api-types'

const status = (overrides: Partial<AgentBuildStatus> = {}): AgentBuildStatus => ({
  id: 'log1',
  status: 'failed',
  startedAt: '2026-11-18T10:00:00Z',
  ...overrides,
})

describe('storedBuildLog (#961: the log survives reopening the window)', () => {
  it('shows the stored output of a finished build', () => {
    expect(storedBuildLog(status({ buildOutput: 'Step 1/5 ...\nERROR: boom' }), false)).toEqual([
      'Step 1/5 ...\nERROR: boom',
    ])
  })

  it('shows nothing while a build is running — that streams live instead', () => {
    expect(storedBuildLog(status({ status: 'building', buildOutput: 'stale' }), true)).toEqual([])
  })

  it('shows nothing when there is no build at all', () => {
    expect(storedBuildLog(null, false)).toEqual([])
  })

  it('shows nothing for an old build with no stored output', () => {
    expect(storedBuildLog(status({ buildOutput: undefined }), false)).toEqual([])
  })
})
