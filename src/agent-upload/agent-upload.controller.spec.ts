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
    deleteAgent: jest.fn().mockResolvedValue({ success: true, stoppedAgents: 0 }),
  }
  const controller = new AgentUploadController(agentUploadService as any)
  return { controller, agentUploadService }
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

    await controller.deleteAgent('a1', user('u1', true) as any)
    expect(agentUploadService.deleteAgent).toHaveBeenCalledWith('a1', 'u1', true)
  })

  it('refuses to delete without a signed-in user before touching the service', async () => {
    const { controller, agentUploadService } = makeController()
    await expect(controller.deleteAgent('a1', {} as any)).rejects.toThrow(UnauthorizedException)
    expect(agentUploadService.deleteAgent).not.toHaveBeenCalled()
  })

  it('surfaces a refusal from the service', async () => {
    const { controller, agentUploadService } = makeController()
    agentUploadService.deleteAgent.mockRejectedValue(new ForbiddenException('You do not own this agent'))
    await expect(controller.deleteAgent('a1', user('someone-else') as any)).rejects.toThrow(ForbiddenException)
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
