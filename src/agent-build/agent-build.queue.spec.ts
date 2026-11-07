import { jest } from '@jest/globals'
import { AgentBuildService, type BuildResult } from './agent-build.service.js'

// executeBuild itself shells out to Docker; these tests stub it out and check
// only the queueing it sits behind: never two builds of one agent type at
// once, a request while one runs queues behind it, and a further request
// while that one is still queued supersedes it rather than piling up.
function makeService(agentTypesById: Record<string, { id: string; packagePath: string | null }>) {
  const buildLogs: Record<string, { id: string; agentTypeId: string; status: string; errorMessage?: string }> = {}
  let nextId = 1

  const prisma = {
    agentType: {
      findUnique: jest.fn(({ where: { id } }: { where: { id: string } }) =>
        Promise.resolve(agentTypesById[id] ?? null),
      ),
    },
    agentBuildLog: {
      create: jest.fn(({ data }: { data: { agentTypeId: string; status: string } }) => {
        const id = `log${nextId++}`
        buildLogs[id] = { id, ...data }
        return Promise.resolve(buildLogs[id])
      }),
      update: jest.fn(({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (!buildLogs[id]) return Promise.reject(new Error('no such build log'))
        buildLogs[id] = { ...buildLogs[id], ...data } as typeof buildLogs[string]
        return Promise.resolve(buildLogs[id])
      }),
    },
  }

  const service = new AgentBuildService(
    { get: jest.fn().mockReturnValue('local') } as any,
    prisma as any,
    {} as any,
  )
  return { service, prisma, buildLogs }
}

/** A controllable stand-in for the real (Docker-shelling) executeBuild. */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const flush = () => new Promise((r) => setImmediate(r))

describe('AgentBuildService: never two builds of one agent type at once', () => {
  it('queues a second request behind the one already running', async () => {
    const { service, buildLogs } = makeService({ a1: { id: 'a1', packagePath: 'p' } })
    const first = deferred<BuildResult>()
    const executeBuild = jest.spyOn(service as any, 'executeBuild')
    executeBuild.mockReturnValueOnce(first.promise as any)

    const r1 = await service.startBuild('a1')
    const r2 = await service.startBuild('a1')

    expect(r1.buildLogId).not.toBe(r2.buildLogId)
    expect(executeBuild).toHaveBeenCalledTimes(1) // the second hasn't started yet
    expect(buildLogs[r2.buildLogId].status).toBe('pending')

    executeBuild.mockResolvedValueOnce({ success: true, buildLogId: r2.buildLogId })
    first.resolve({ success: true, buildLogId: r1.buildLogId })
    await flush()
    await flush()

    expect(executeBuild).toHaveBeenCalledTimes(2)
    expect(executeBuild).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a1' }), r2.buildLogId)
  })

  it('a request while one is already queued supersedes it, not piling both up', async () => {
    const { service, buildLogs } = makeService({ a1: { id: 'a1', packagePath: 'p' } })
    const first = deferred<BuildResult>()
    const executeBuild = jest.spyOn(service as any, 'executeBuild')
    executeBuild.mockReturnValueOnce(first.promise as any)

    const r1 = await service.startBuild('a1')
    const r2 = await service.startBuild('a1') // queued
    const r3 = await service.startBuild('a1') // supersedes r2's queue slot

    expect(buildLogs[r2.buildLogId].status).toBe('failed')
    expect(buildLogs[r2.buildLogId].errorMessage).toMatch(/superseded/i)
    expect(buildLogs[r3.buildLogId].status).toBe('pending')

    executeBuild.mockResolvedValueOnce({ success: true, buildLogId: r3.buildLogId })
    first.resolve({ success: true, buildLogId: r1.buildLogId })
    await flush()
    await flush()

    // r2 never runs; only r1 (the original) and r3 (the one that superseded r2) do.
    expect(executeBuild).toHaveBeenCalledTimes(2)
    expect(executeBuild).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a1' }), r3.buildLogId)
  })

  it('a queued build reads whatever is current on the agent type once it actually runs', async () => {
    const agentTypesById: Record<string, { id: string; packagePath: string | null; version?: string }> = {
      a1: { id: 'a1', packagePath: 'p', version: '1.0.0' },
    }
    const { service } = makeService(agentTypesById)
    const first = deferred<BuildResult>()
    const executeBuild = jest.spyOn(service as any, 'executeBuild')
    executeBuild.mockReturnValueOnce(first.promise as any)

    await service.startBuild('a1')
    const r2 = await service.startBuild('a1')

    // A new version lands (e.g. a re-upload) while the first build is still running.
    agentTypesById.a1 = { id: 'a1', packagePath: 'p2', version: '1.0.1' }

    executeBuild.mockResolvedValueOnce({ success: true, buildLogId: r2.buildLogId })
    first.resolve({ success: true, buildLogId: 'log1' })
    await flush()
    await flush()

    expect(executeBuild).toHaveBeenLastCalledWith(
      expect.objectContaining({ version: '1.0.1', packagePath: 'p2' }),
      r2.buildLogId,
    )
  })

  it('does not run two builds in parallel even under concurrent requests', async () => {
    const { service } = makeService({ a1: { id: 'a1', packagePath: 'p' } })
    let concurrentlyRunning = 0
    let maxConcurrent = 0
    jest.spyOn(service as any, 'executeBuild').mockImplementation(async (_agentType: any, buildLogId: string) => {
      concurrentlyRunning += 1
      maxConcurrent = Math.max(maxConcurrent, concurrentlyRunning)
      await flush()
      concurrentlyRunning -= 1
      return { success: true, buildLogId }
    })

    await Promise.all([service.startBuild('a1'), service.startBuild('a1'), service.startBuild('a1')])
    await flush()
    await flush()
    await flush()

    expect(maxConcurrent).toBe(1)
  })
})
