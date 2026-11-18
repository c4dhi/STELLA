import { jest } from '@jest/globals'
import { AgentBuildService } from './agent-build.service.js'

// getBuildHistory/getBuildStatus/getBuildOutput read from AgentBuildLog rows
// that always carry the full buildOutput text (#961). These check the
// service maps each one down to the right shape — buildOutput included only
// when a single build is fetched by id, never in the history list.
function makeService(row: Record<string, unknown> | null) {
  const prisma = {
    agentBuildLog: {
      findUnique: jest.fn(() => Promise.resolve(row)),
      findMany: jest.fn(() => Promise.resolve(row ? [row] : [])),
    },
  }
  const service = new AgentBuildService({ get: jest.fn().mockReturnValue('local') } as any, prisma as any, {} as any, {} as any)
  return { service, prisma }
}

const row = {
  id: 'log1',
  agentTypeId: 'a1',
  status: 'failed',
  imageName: null,
  errorMessage: 'boom',
  startedAt: new Date('2026-11-18T10:00:00Z'),
  completedAt: new Date('2026-11-18T10:01:00Z'),
  buildOutput: 'Step 1/5 ...\nERROR: boom',
}

describe('AgentBuildService.getBuildStatus', () => {
  it('returns the stored status for a single build, by id', async () => {
    const { service } = makeService(row)
    const status = await service.getBuildStatus('log1')
    expect(status).toMatchObject({ id: 'log1', status: 'failed', errorMessage: 'boom' })
  })

  it('returns null for a build log that does not exist', async () => {
    const { service } = makeService(null)
    expect(await service.getBuildStatus('missing')).toBeNull()
  })
})

describe('AgentBuildService.getBuildOutput', () => {
  it('returns the stored output for a single build, by id', async () => {
    const { service } = makeService(row)
    expect(await service.getBuildOutput('log1')).toBe('Step 1/5 ...\nERROR: boom')
  })

  it('returns null when there is none', async () => {
    const { service } = makeService(null)
    expect(await service.getBuildOutput('missing')).toBeNull()
  })
})

describe('AgentBuildService.getBuildHistory', () => {
  it('never includes buildOutput, even though the row carries one', async () => {
    const { service } = makeService(row)
    const history = await service.getBuildHistory('a1')
    expect(history).toHaveLength(1)
    expect(history[0]).not.toHaveProperty('buildOutput')
    expect(history[0]).toMatchObject({ id: 'log1', status: 'failed', errorMessage: 'boom' })
  })
})
