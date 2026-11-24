import { jest } from '@jest/globals'
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common'
import { AgentUploadController } from './agent-upload.controller.js'
import { AgentAdminController } from './agent-admin.controller.js'
import { AgentReviewService } from './agent-review.service.js'

// request.user is an AuthUser ({ userId, ... }). The controller used to read
// req.user.id, which is always undefined: uploads got no owner, My Agents listed
// every upload, and the ownership checks never ran. These go through the
// controller with the real request shape.
const user = (userId: string, isSystemAdmin = false) => ({
  user: { userId, email: `${userId}@x`, name: null, isSystemAdmin, projectIds: [], projectRoles: {} },
})

function makeController() {
  const agentUploadService = {
    createFromPackage: jest.fn().mockResolvedValue({ id: 'new', slug: 'my-agent' }),
    getMyAgents: jest.fn().mockResolvedValue([]),
    triggerBuild: jest.fn().mockResolvedValue({ buildLogId: 'b1', message: 'Build started' }),
    getBuildStatus: jest.fn().mockResolvedValue(null),
    getBuildHistory: jest.fn().mockResolvedValue([]),
    latestBuildStatus: jest.fn().mockResolvedValue(null as Record<string, unknown> | null),
    getBuildOutput: jest.fn().mockResolvedValue(null as string | null),
    assertCanSeeBuilds: jest.fn().mockResolvedValue(undefined),
    getShares: jest.fn().mockResolvedValue({ projectIds: [], projects: [] }),
    updateShares: jest.fn().mockResolvedValue({ projectIds: [] }),
  }
  const prisma = {
    agentType: {
      findUnique: jest.fn().mockResolvedValue(null as Record<string, unknown> | null),
      delete: jest.fn().mockResolvedValue({}),
    },
    agentInstance: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    project: { count: jest.fn().mockResolvedValue(0) },
    envVarTemplate: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    agentConfiguration: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $transaction: jest.fn().mockImplementation((ops: unknown) => Promise.all(ops as Promise<unknown>[])),
  }
  const storage = { delete: jest.fn().mockResolvedValue(undefined) }
  const agents = {
    stopAgent: jest.fn().mockResolvedValue({}),
    runningAgentsOfType: jest.fn().mockResolvedValue({ live: [], stale: [] } as {
      live: { id: string; deployedByUserId: string | null }[]
      stale: string[]
    }),
  }
  const controller = new AgentUploadController(agentUploadService as any, storage as any, prisma as any, agents as any)
  return { controller, agentUploadService, prisma, storage, agents }
}

const zip = { originalname: 'a.zip', size: 1, buffer: Buffer.from('x') } as Express.Multer.File

describe('AgentUploadController: upload, my-agents, build and shares delegate to AgentUploadService', () => {
  it('refuses an upload without a signed-in user before touching the service', async () => {
    const { controller, agentUploadService } = makeController()
    await expect(controller.uploadPackage(zip, {} as any)).rejects.toThrow(UnauthorizedException)
    expect(agentUploadService.createFromPackage).not.toHaveBeenCalled()
  })

  it('refuses a missing file, and one that is not a .zip', async () => {
    const { controller, agentUploadService } = makeController()
    await expect(controller.uploadPackage(undefined as any, user('u1') as any)).rejects.toThrow(BadRequestException)
    await expect(
      controller.uploadPackage({ ...zip, originalname: 'a.tar' } as any, user('u1') as any),
    ).rejects.toThrow('must be a .zip archive')
    expect(agentUploadService.createFromPackage).not.toHaveBeenCalled()
  })

  it('passes the buffer and the signed-in user to the service, and returns its result', async () => {
    const { controller, agentUploadService } = makeController()
    await expect(controller.uploadPackage(zip, user('u1') as any)).resolves.toEqual({ id: 'new', slug: 'my-agent' })
    expect(agentUploadService.createFromPackage).toHaveBeenCalledWith(zip.buffer, 'u1')
  })

  it('my-agents, build, build-status, build-history and shares all delegate with the right user', async () => {
    const { controller, agentUploadService } = makeController()

    await controller.getMyAgents(user('u1') as any)
    expect(agentUploadService.getMyAgents).toHaveBeenCalledWith('u1')

    await controller.triggerBuild('a1', user('u1', true) as any)
    expect(agentUploadService.triggerBuild).toHaveBeenCalledWith('a1', 'u1', true)

    await controller.getBuildStatus('a1', user('u1') as any)
    expect(agentUploadService.getBuildStatus).toHaveBeenCalledWith('a1', 'u1', false)

    await controller.getBuildHistory('a1', user('u1') as any)
    expect(agentUploadService.getBuildHistory).toHaveBeenCalledWith('a1', 'u1', false)

    await controller.getShares('a1', user('u1') as any)
    expect(agentUploadService.getShares).toHaveBeenCalledWith('a1', 'u1')

    await controller.updateShares('a1', { projectIds: ['p1'] }, user('u1') as any)
    expect(agentUploadService.updateShares).toHaveBeenCalledWith('a1', 'u1', ['p1'])
  })
})

describe('AgentAdminController records the reviewing admin', () => {
  const pending = { id: 'a1', slug: 'my-agent', name: 'x', isBuiltIn: false, validationStatus: 'PENDING' }
  const make = () => {
    const prisma = {
      agentType: {
        findUnique: jest.fn().mockResolvedValue(pending),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...pending, ...data })),
      },
    }
    return { controller: new AgentAdminController(new AgentReviewService(prisma as any)), prisma }
  }

  it('on approve', async () => {
    const { controller, prisma } = make()
    await controller.approveAgent('a1', {}, user('admin', true) as any)
    expect(prisma.agentType.update.mock.calls[0][0].data.validatedBy).toBe('admin')
  })

  it('on reject', async () => {
    const { controller, prisma } = make()
    await controller.rejectAgent('a1', { reason: 'no' }, user('admin', true) as any)
    expect(prisma.agentType.update.mock.calls[0][0].data.validatedBy).toBe('admin')
  })
})

describe('the build-logs SSE event', () => {
  // A plain map() over an async callback emits the unresolved Promise as the
  // "event" (streamBuildLogs used to do exactly this): the browser's
  // EventSource requires a `data` field to fire onmessage at all, so every
  // polled update silently vanished and no card or log view ever updated live.
  // This asserts the per-tick event actually resolves to real, parseable data.
  it('resolves to the real build status, not an unawaited promise', async () => {
    const { controller, agentUploadService } = makeController()
    agentUploadService.latestBuildStatus.mockResolvedValue({ id: 'log1', status: 'success', imageName: 'img:1', errorMessage: null })
    agentUploadService.getBuildOutput.mockResolvedValue('built ok')

    const event = await (controller as any).buildLogEvent('a1')

    expect(typeof event.data).toBe('string')
    const payload = JSON.parse(event.data)
    expect(payload).toMatchObject({ status: 'success', imageName: 'img:1', output: 'built ok' })
  })

  it('reports no_build when the agent has never been built', async () => {
    const { controller, agentUploadService } = makeController()
    agentUploadService.latestBuildStatus.mockResolvedValue(null)

    const event = await (controller as any).buildLogEvent('a1')

    expect(event.data).toBe('no_build')
  })

  it('checks visibility once before opening the stream', async () => {
    const { controller, agentUploadService } = makeController()
    const stream = await controller.streamBuildLogs('a1', user('u1') as any)
    expect(agentUploadService.assertCanSeeBuilds).toHaveBeenCalledWith('a1', 'u1', false)
    expect(typeof stream.subscribe).toBe('function')
  })
})

describe('deleting a custom agent', () => {
  const upload = { id: 'a1', slug: 'my-agent', name: 'My agent', isBuiltIn: false, packagePath: 'p', userId: 'owner' }

  it.each([
    ['the owner', user('owner'), true],
    ['a system admin', user('admin', true), true],
    ['another user', user('someone-else'), false],
  ])('delete: %s', async (_who, req, allowed) => {
    const { controller, prisma } = makeController()
    prisma.agentType.findUnique.mockResolvedValue(upload)
    const run = controller.deleteAgent('a1', req as any)
    if (allowed) await expect(run).resolves.toEqual({ success: true, stoppedAgents: 0 })
    else await expect(run).rejects.toThrow(ForbiddenException)
    expect(prisma.agentType.delete).toHaveBeenCalledTimes(allowed ? 1 : 0)
  })

  it('takes the type\'s templates and configurations with it, and the package last', async () => {
    const { controller, prisma, storage } = makeController()
    prisma.agentType.findUnique.mockResolvedValue(upload)
    const order: string[] = []
    prisma.$transaction.mockImplementation(async (ops: unknown) => {
      order.push('db')
      return Promise.all(ops as Promise<unknown>[])
    })
    storage.delete.mockImplementation(async () => {
      order.push('package')
    })
    await controller.deleteAgent('a1', user('owner') as any)
    expect(prisma.envVarTemplate.deleteMany).toHaveBeenCalledWith({ where: { agentTypeId: 'a1' } })
    expect(prisma.agentConfiguration.deleteMany).toHaveBeenCalledWith({ where: { agentTypeId: 'a1' } })
    expect(prisma.agentInstance.updateMany).toHaveBeenCalledWith({ where: { agentTypeId: 'a1' }, data: { agentTypeId: null } })
    expect(order).toEqual(['db', 'package'])
  })

  it('cleans up dead rows and stops the owner\'s own agents, then deletes it', async () => {
    const { controller, prisma, agents } = makeController()
    prisma.agentType.findUnique.mockResolvedValue(upload)
    const order: string[] = []
    agents.runningAgentsOfType.mockResolvedValue({ live: [{ id: 'mine', deployedByUserId: 'owner' }], stale: ['pod-gone'] })
    agents.stopAgent.mockImplementation(async (id: unknown) => {
      order.push(`stop ${id}`)
      return {}
    })
    prisma.$transaction.mockImplementation(async (ops: unknown) => {
      order.push('db')
      return Promise.all(ops as Promise<unknown>[])
    })
    await expect(controller.deleteAgent('a1', user('owner') as any)).resolves.toEqual({ success: true, stoppedAgents: 1 })
    expect(agents.runningAgentsOfType).toHaveBeenCalledWith('a1')
    expect(order).toEqual(['stop pod-gone', 'stop mine', 'db'])
  })

  it('refuses while another user\'s agent of it still runs, and stops nothing', async () => {
    const { controller, prisma, agents, storage } = makeController()
    prisma.agentType.findUnique.mockResolvedValue(upload)
    agents.runningAgentsOfType.mockResolvedValue({
      live: [{ id: 'mine', deployedByUserId: 'owner' }, { id: 'theirs', deployedByUserId: 'member' }, { id: 'old', deployedByUserId: null }],
      stale: ['pod-gone'],
    })
    await expect(controller.deleteAgent('a1', user('owner') as any)).rejects.toThrow('still runs in 2 sessions of other users')
    expect(agents.stopAgent).not.toHaveBeenCalled()
    expect(prisma.agentType.delete).not.toHaveBeenCalled()
    expect(storage.delete).not.toHaveBeenCalled()
  })

  it('refuses a type a public project uses, before stopping anything, and keeps its package', async () => {
    const { controller, prisma, agents, storage } = makeController()
    prisma.agentType.findUnique.mockResolvedValue(upload)
    prisma.project.count.mockResolvedValue(2)
    agents.runningAgentsOfType.mockResolvedValue({ live: [{ id: 'live', deployedByUserId: 'owner' }], stale: [] })
    await expect(controller.deleteAgent('a1', user('owner') as any)).rejects.toThrow('2 public projects use My agent')
    expect(agents.stopAgent).not.toHaveBeenCalled()
    expect(prisma.agentType.delete).not.toHaveBeenCalled()
    expect(storage.delete).not.toHaveBeenCalled()
  })
})
