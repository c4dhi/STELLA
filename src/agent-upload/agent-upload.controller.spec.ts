import { jest } from '@jest/globals'
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common'
import { AgentUploadController } from './agent-upload.controller.js'
import { AgentAdminController } from './agent-admin.controller.js'
import { AgentReviewService } from './agent-review.service.js'
import { agentManifestSchema } from '../agent-package/schemas/agent-manifest.schema.js'

// request.user is an AuthUser ({ userId, ... }). The controllers used to read
// req.user.id, which is always undefined: uploads got no owner, My Agents listed
// every upload, and the ownership checks never ran. These go through the
// controllers with the real request shape.
const user = (userId: string, isSystemAdmin = false) => ({
  user: { userId, email: `${userId}@x`, name: null, isSystemAdmin, projectIds: [], projectRoles: {} },
})

// A real parsed manifest, so the mapping runs on what upload actually gets.
const manifest = (image: Record<string, unknown> = { dockerfile: 'Dockerfile' }) =>
  agentManifestSchema.parse({
    version: '2.0',
    metadata: { slug: 'my-agent', name: 'My agent', version: '0.1.0', description: 'd' },
    image,
    capabilities: ['voice'],
  })

function makeUpload(agentRecord: Record<string, unknown> | null = null, m = manifest()) {
  const prisma = {
    agentTypeProjectShare: {
      findMany: jest.fn().mockResolvedValue([] as { projectId: string }[]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn().mockResolvedValue({}),
    },
    projectMembership: { findMany: jest.fn().mockResolvedValue([] as unknown[]) },
    agentType: {
      findUnique: jest.fn().mockResolvedValue(agentRecord),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'new', ...data })),
      update: jest.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
      delete: jest.fn().mockResolvedValue({}),
    },
    agentInstance: {
      findMany: jest.fn().mockResolvedValue([] as { id: string }[]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    project: { count: jest.fn().mockResolvedValue(0) },
    envVarTemplate: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    agentConfiguration: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $transaction: jest.fn().mockImplementation((ops: unknown) => Promise.all(ops as Promise<unknown>[])),
  }
  const pkg = {
    validatePackage: jest.fn().mockResolvedValue({ valid: true, manifest: m, errors: [], warnings: [] }),
    storePackage: jest.fn().mockResolvedValue({ path: 'p', size: 1, hash: 'h' }),
    readExpertDefaults: jest.fn().mockReturnValue(null),
  }
  const build = { startBuild: jest.fn().mockResolvedValue({ buildLogId: 'b1' }) }
  const storage = { delete: jest.fn().mockResolvedValue(undefined) }
  const agents = {
    stopAgent: jest.fn().mockResolvedValue({}),
    runningAgentsOfType: jest.fn().mockResolvedValue({ live: [], stale: [] } as {
      live: { id: string; deployedByUserId: string | null }[]
      stale: string[]
    }),
  }
  const controller = new AgentUploadController(pkg as any, build as any, storage as any, prisma as any, agents as any)
  return { controller, prisma, pkg, build, storage, agents }
}

const zip = { originalname: 'a.zip', size: 1, buffer: Buffer.from('x') } as Express.Multer.File

describe('AgentUploadController identity and ownership', () => {
  it('stores the uploader as owner, and no image until a build', async () => {
    const { controller, prisma } = makeUpload()
    await controller.uploadPackage(zip, user('u1') as any)
    const data = prisma.agentType.create.mock.calls[0][0].data
    expect(data.userId).toBe('u1')
    expect(data.imageUrl).toBeNull()
  })

  it('refuses an upload without a signed-in user before storing anything', async () => {
    const { controller, pkg } = makeUpload()
    await expect(controller.uploadPackage(zip, {} as any)).rejects.toThrow(UnauthorizedException)
    expect(pkg.storePackage).not.toHaveBeenCalled()
  })

  it('refuses a manifest that points at a prebuilt image', async () => {
    const { controller, pkg } = makeUpload(null, manifest({ dockerfile: 'Dockerfile', imageUrl: 'evil/image:1' }))
    await expect(controller.uploadPackage(zip, user('u1') as any)).rejects.toThrow(/image.imageUrl is not allowed/)
    expect(pkg.storePackage).not.toHaveBeenCalled()
  })

  it('refuses a Dockerfile path the build would refuse', async () => {
    const { controller } = makeUpload(null, manifest({ dockerfile: 'Dockerfile; rm -rf /' }))
    await expect(controller.uploadPackage(zip, user('u1') as any)).rejects.toThrow(BadRequestException)
  })

  it('lists only the caller’s own uploads in My Agents', async () => {
    const { controller, prisma } = makeUpload()
    await controller.getMyAgents(user('u1') as any)
    expect(prisma.agentType.findMany.mock.calls[0][0].where).toEqual({ isBuiltIn: false, userId: 'u1' })
  })

  it('tells the uploader what the reviewer wrote (#153)', async () => {
    const { controller, prisma } = makeUpload()
    const validatedAt = new Date('2026-11-07T15:00:00Z')
    prisma.agentType.findMany.mockResolvedValueOnce([
      {
        id: 'a1', slug: 'my-agent', name: 'My agent', validationStatus: 'REJECTED',
        validationNotes: 'Opens a shell', validatedAt, buildLogs: [], projectShares: [],
      },
    ])
    const [mine] = await controller.getMyAgents(user('u1') as any)
    expect(mine).toMatchObject({ validationStatus: 'REJECTED', validationNotes: 'Opens a shell', validatedAt })
  })

  const upload = { id: 'a1', slug: 'my-agent', name: 'My agent', isBuiltIn: false, packagePath: 'p', userId: 'owner' }

  it.each([
    ['the owner', user('owner'), true],
    ['a system admin', user('admin', true), true],
    ['another user', user('someone-else'), false],
  ])('build: %s', async (_who, req, allowed) => {
    const { controller, build } = makeUpload(upload)
    const run = controller.triggerBuild('a1', req as any)
    if (allowed) await expect(run).resolves.toMatchObject({ buildLogId: 'b1' })
    else await expect(run).rejects.toThrow(ForbiddenException)
    expect(build.startBuild).toHaveBeenCalledTimes(allowed ? 1 : 0)
  })

  it.each([
    ['the owner', user('owner'), true],
    ['a system admin', user('admin', true), true],
    ['another user', user('someone-else'), false],
  ])('delete: %s', async (_who, req, allowed) => {
    const { controller, prisma } = makeUpload(upload)
    const run = controller.deleteAgent('a1', req as any)
    if (allowed) await expect(run).resolves.toEqual({ success: true, stoppedAgents: 0 })
    else await expect(run).rejects.toThrow(ForbiddenException)
    expect(prisma.agentType.delete).toHaveBeenCalledTimes(allowed ? 1 : 0)
  })

  it('delete takes the type\'s templates and configurations with it, and the package last', async () => {
    const { controller, prisma, storage } = makeUpload(upload)
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

  it('delete cleans up dead rows and stops the owner\'s own agents, then deletes it', async () => {
    const { controller, prisma, agents } = makeUpload(upload)
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

  it('delete refuses while another user\'s agent of it still runs, and stops nothing', async () => {
    const { controller, prisma, agents, storage } = makeUpload(upload)
    agents.runningAgentsOfType.mockResolvedValue({
      live: [{ id: 'mine', deployedByUserId: 'owner' }, { id: 'theirs', deployedByUserId: 'member' }, { id: 'old', deployedByUserId: null }],
      stale: ['pod-gone'],
    })
    await expect(controller.deleteAgent('a1', user('owner') as any)).rejects.toThrow('still runs in 2 sessions of other users')
    expect(agents.stopAgent).not.toHaveBeenCalled()
    expect(prisma.agentType.delete).not.toHaveBeenCalled()
    expect(storage.delete).not.toHaveBeenCalled()
  })

  it('delete refuses a type a public project uses, before stopping anything, and keeps its package', async () => {
    const shared = makeUpload(upload)
    shared.prisma.project.count.mockResolvedValue(2)
    shared.agents.runningAgentsOfType.mockResolvedValue({ live: [{ id: 'live', deployedByUserId: 'owner' }], stale: [] })
    await expect(shared.controller.deleteAgent('a1', user('owner') as any)).rejects.toThrow('2 public projects use My agent')
    expect(shared.agents.stopAgent).not.toHaveBeenCalled()
    expect(shared.prisma.agentType.delete).not.toHaveBeenCalled()
    expect(shared.storage.delete).not.toHaveBeenCalled()
  })

  it('treats an upload stored without an owner as admin-only', async () => {
    const { controller } = makeUpload({ ...upload, userId: null })
    await expect(controller.triggerBuild('a1', user('u1') as any)).rejects.toThrow(ForbiddenException)
    await expect(controller.triggerBuild('a1', user('admin', true) as any)).resolves.toBeDefined()
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

describe('uploading an agent again', () => {
  const mine = {
    id: 'a1', slug: 'my-agent', name: 'My agent', version: '0.0.9', isBuiltIn: false, userId: 'u1',
    packagePath: 'old.zip', imageUrl: 'img:0.0.9', validationStatus: 'APPROVED',
  }

  it('with a new version replaces the uploader\'s own agent in place', async () => {
    const { controller, prisma, storage } = makeUpload(mine)
    const res = await controller.uploadPackage(zip, user('u1') as any)
    expect(prisma.agentType.create).not.toHaveBeenCalled()
    const call = prisma.agentType.update.mock.calls[0][0]
    expect(call.where).toEqual({ id: 'a1' })
    expect(call.data).toMatchObject({
      version: '0.1.0', userId: 'u1', packagePath: 'p', imageUrl: null, sdkVersion: null,
      validationStatus: 'PENDING', validatedAt: null, validatedBy: null,
    })
    expect(storage.delete).toHaveBeenCalledWith('old.zip')
    expect(res).toMatchObject({ id: 'a1', version: '0.1.0', replacedVersion: '0.0.9' })
  })

  it('with the same version is refused, and stores nothing', async () => {
    const { controller, prisma, pkg } = makeUpload({ ...mine, version: '0.1.0' })
    await expect(controller.uploadPackage(zip, user('u1') as any)).rejects.toThrow('raise metadata.version')
    expect(pkg.storePackage).not.toHaveBeenCalled()
    expect(prisma.agentType.update).not.toHaveBeenCalled()
  })

  it.each([
    ['another user\'s agent', { ...mine, userId: 'u2' }],
    ['a built-in agent', { ...mine, userId: null, isBuiltIn: true }],
  ])('never replaces %s', async (_what, row) => {
    const { controller, prisma, pkg } = makeUpload(row)
    await expect(controller.uploadPackage(zip, user('u1') as any)).rejects.toThrow('Another agent already uses the slug')
    expect(pkg.storePackage).not.toHaveBeenCalled()
    expect(prisma.agentType.update).not.toHaveBeenCalled()
  })
})

describe('sharing an agent with projects', () => {
  const mine = { id: 'a1', slug: 'my-agent', name: 'My agent', isBuiltIn: false, userId: 'owner' }

  it('replaces the shared set with projects the owner is a member of', async () => {
    const { controller, prisma } = makeUpload(mine)
    prisma.projectMembership.findMany.mockResolvedValue([{ projectId: 'p1' }, { projectId: 'p2' }])
    await expect(
      controller.updateShares('a1', { projectIds: ['p1', 'p2', 'p1'] }, user('owner') as any),
    ).resolves.toEqual({ projectIds: ['p1', 'p2'] })
    expect(prisma.agentTypeProjectShare.deleteMany).toHaveBeenCalledWith({
      where: { agentTypeId: 'a1', projectId: { notIn: ['p1', 'p2'] } },
    })
    expect(prisma.agentTypeProjectShare.upsert).toHaveBeenCalledTimes(2)
  })

  it('refuses a project the owner is not in', async () => {
    const { controller, prisma } = makeUpload(mine)
    prisma.projectMembership.findMany.mockResolvedValue([{ projectId: 'p1' }])
    await expect(controller.updateShares('a1', { projectIds: ['p1', 'not-mine'] }, user('owner') as any)).rejects.toThrow(
      'projects you are a member of',
    )
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it.each([
    ['a member it is shared with', user('member')],
    ['a system admin', user('admin', true)],
  ])('is the owner\'s alone, not %s\'s', async (_who, req) => {
    const { controller, prisma } = makeUpload(mine)
    await expect(controller.updateShares('a1', { projectIds: [] }, req as any)).rejects.toThrow(ForbiddenException)
    await expect(controller.getShares('a1', req as any)).rejects.toThrow(ForbiddenException)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('never shares a built-in agent', async () => {
    const { controller } = makeUpload({ ...mine, isBuiltIn: true, userId: null })
    await expect(controller.updateShares('a1', { projectIds: [] }, user('owner') as any)).rejects.toThrow(ForbiddenException)
  })
})
