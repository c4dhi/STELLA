import { jest } from '@jest/globals'
import { AgentBuildService, firstLine } from './agent-build.service.js'

// executeBuild's failure path should tell whoever started the build (or the
// agent's owner, if nobody did) — never Docker itself, which these tests
// never reach: extractPackage is made to fail first.
function makeService(agentType: { id: string; packagePath: string | null; userId: string | null; slug?: string; version?: string }) {
  const buildLogs: Record<string, { id: string; agentTypeId: string; status: string; errorMessage?: string }> = {}
  let nextId = 1

  const prisma = {
    agentType: {
      findUnique: jest.fn(() => Promise.resolve({ slug: 'my-agent', name: 'My Agent', version: '1.0.0', ...agentType })),
      update: jest.fn(() => Promise.resolve({})),
    },
    agentBuildLog: {
      create: jest.fn(({ data }: { data: { agentTypeId: string; status: string } }) => {
        const id = `log${nextId++}`
        buildLogs[id] = { id, ...data }
        return Promise.resolve(buildLogs[id])
      }),
      update: jest.fn(({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        buildLogs[id] = { ...buildLogs[id], ...data } as (typeof buildLogs)[string]
        return Promise.resolve(buildLogs[id])
      }),
    },
  }

  const agentPackageService = {
    extractPackage: jest.fn(() => Promise.reject(new Error('Extraction failed: disk full\nsecond line of detail'))),
  }

  const userMessagesService = {
    createAgentBuildFailedMessage: jest.fn(() => Promise.resolve()),
  }

  const service = new AgentBuildService(
    { get: jest.fn().mockReturnValue('local') } as any,
    prisma as any,
    agentPackageService as any,
    userMessagesService as any,
  )

  return { service, userMessagesService, buildLogs }
}

describe('AgentBuildService: who hears about a failed build', () => {
  it('notifies whoever started the build', async () => {
    const { service, userMessagesService } = makeService({ id: 'a1', packagePath: 'p', userId: 'owner1' })

    await service.startBuild('a1', 'triggering-user')
    await new Promise((r) => setImmediate(r))

    expect(userMessagesService.createAgentBuildFailedMessage).toHaveBeenCalledWith(
      'triggering-user',
      'a1',
      'My Agent',
      'Extraction failed: disk full',
    )
  })

  it('falls back to the agent type owner when nobody is recorded as having started it', async () => {
    const { service, userMessagesService } = makeService({ id: 'a1', packagePath: 'p', userId: 'owner1' })

    await service.startBuild('a1')
    await new Promise((r) => setImmediate(r))

    expect(userMessagesService.createAgentBuildFailedMessage).toHaveBeenCalledWith(
      'owner1',
      'a1',
      'My Agent',
      expect.any(String),
    )
  })

  it('notifies nobody when there is no triggering user and no owner', async () => {
    const { service, userMessagesService } = makeService({ id: 'a1', packagePath: 'p', userId: null })

    await service.startBuild('a1')
    await new Promise((r) => setImmediate(r))

    expect(userMessagesService.createAgentBuildFailedMessage).not.toHaveBeenCalled()
  })

  it('marks the build log failed regardless of whether anyone could be notified', async () => {
    const { service, buildLogs } = makeService({ id: 'a1', packagePath: 'p', userId: null })

    const result = await service.startBuild('a1')
    await new Promise((r) => setImmediate(r))

    expect(buildLogs[result.buildLogId].status).toBe('failed')
  })
})

describe('firstLine', () => {
  it('keeps only the first line of a multi-line error', () => {
    expect(firstLine('Docker build failed: boom\nStep 3/5 ...\nERROR')).toBe('Docker build failed: boom')
  })

  it('returns a single-line message unchanged', () => {
    expect(firstLine('no newline here')).toBe('no newline here')
  })
})
