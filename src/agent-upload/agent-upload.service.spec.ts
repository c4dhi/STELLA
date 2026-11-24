import { jest } from '@jest/globals'
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { AgentUploadService } from './agent-upload.service.js'
import { agentManifestSchema } from '../agent-package/schemas/agent-manifest.schema.js'

// A real parsed manifest, so the mapping runs on what upload actually gets.
const manifest = (image: Record<string, unknown> = { dockerfile: 'Dockerfile' }) =>
  agentManifestSchema.parse({
    version: '2.0',
    metadata: { slug: 'my-agent', name: 'My agent', version: '0.1.0', description: 'd' },
    image,
    capabilities: ['voice'],
  })

function makeService(agentRecord: Record<string, unknown> | null = null, m = manifest()) {
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
    },
    agentBuildLog: {
      findFirst: jest.fn().mockResolvedValue(null as Record<string, unknown> | null),
    },
    $transaction: jest.fn().mockImplementation((ops: unknown) => Promise.all(ops as Promise<unknown>[])),
  }
  const pkg = {
    validatePackage: jest.fn().mockResolvedValue({ valid: true, manifest: m, errors: [], warnings: [] }),
    storePackage: jest.fn().mockResolvedValue({ path: 'p', size: 1, hash: 'h' }),
    readExpertDefaults: jest.fn().mockReturnValue(null),
  }
  const build = {
    startBuild: jest.fn().mockResolvedValue({ buildLogId: 'b1' }),
    getBuildStatus: jest.fn().mockResolvedValue(null as Record<string, unknown> | null),
    getBuildOutput: jest.fn().mockResolvedValue(null as string | null),
    getBuildHistory: jest.fn().mockResolvedValue([] as unknown[]),
  }
  const storage = { delete: jest.fn().mockResolvedValue(undefined) }
  const service = new AgentUploadService(pkg as any, build as any, storage as any, prisma as any)
  return { service, prisma, pkg, build, storage }
}

const buffer = Buffer.from('x')

describe('AgentUploadService identity and ownership', () => {
  it('stores the uploader as owner, and no image until a build', async () => {
    const { service, prisma } = makeService()
    await service.createFromPackage(buffer, 'u1')
    const data = prisma.agentType.create.mock.calls[0][0].data
    expect(data.userId).toBe('u1')
    expect(data.imageUrl).toBeNull()
  })

  it('starts the build on its own once the upload is stored', async () => {
    const { service, build } = makeService()
    await service.createFromPackage(buffer, 'u1')
    expect(build.startBuild).toHaveBeenCalledWith('new', 'u1')
  })

  it('still returns the upload result if starting the build fails', async () => {
    const { service, build } = makeService()
    build.startBuild.mockRejectedValueOnce(new Error('docker daemon unreachable'))
    await expect(service.createFromPackage(buffer, 'u1')).resolves.toMatchObject({ slug: 'my-agent' })
  })

  it('refuses a manifest that points at a prebuilt image', async () => {
    const { service, pkg } = makeService(null, manifest({ dockerfile: 'Dockerfile', imageUrl: 'evil/image:1' }))
    await expect(service.createFromPackage(buffer, 'u1')).rejects.toThrow(/image.imageUrl is not allowed/)
    expect(pkg.storePackage).not.toHaveBeenCalled()
  })

  it('refuses a Dockerfile path the build would refuse', async () => {
    const { service } = makeService(null, manifest({ dockerfile: 'Dockerfile; rm -rf /' }))
    await expect(service.createFromPackage(buffer, 'u1')).rejects.toThrow(BadRequestException)
  })

  it('lists only the caller’s own uploads', async () => {
    const { service, prisma } = makeService()
    await service.getMyAgents('u1')
    expect(prisma.agentType.findMany.mock.calls[0][0].where).toEqual({ isBuiltIn: false, userId: 'u1' })
  })

  it('tells the uploader what the reviewer wrote (#153)', async () => {
    const { service, prisma } = makeService()
    const validatedAt = new Date('2026-11-07T15:00:00Z')
    prisma.agentType.findMany.mockResolvedValueOnce([
      {
        id: 'a1', slug: 'my-agent', name: 'My agent', validationStatus: 'REJECTED',
        validationNotes: 'Opens a shell', validatedAt, buildLogs: [], projectShares: [],
      },
    ])
    const [mine] = await service.getMyAgents('u1')
    expect(mine).toMatchObject({ validationStatus: 'REJECTED', validationNotes: 'Opens a shell', validatedAt })
  })

  const upload = { id: 'a1', slug: 'my-agent', name: 'My agent', isBuiltIn: false, packagePath: 'p', userId: 'owner' }

  it.each([
    ['the owner', 'owner', false, true],
    ['a system admin', 'admin', true, true],
    ['another user', 'someone-else', false, false],
  ])('build: %s', async (_who, userId, isSystemAdmin, allowed) => {
    const { service, build } = makeService(upload)
    const run = service.triggerBuild('a1', userId as string, isSystemAdmin as boolean)
    if (allowed) await expect(run).resolves.toMatchObject({ buildLogId: 'b1' })
    else await expect(run).rejects.toThrow(ForbiddenException)
    expect(build.startBuild).toHaveBeenCalledTimes(allowed ? 1 : 0)
  })

  it('treats an upload stored without an owner as admin-only', async () => {
    const { service } = makeService({ ...upload, userId: null })
    await expect(service.triggerBuild('a1', 'u1')).rejects.toThrow(ForbiddenException)
    await expect(service.triggerBuild('a1', 'admin', true)).resolves.toBeDefined()
  })
})

describe('uploading an agent again', () => {
  const mine = {
    id: 'a1', slug: 'my-agent', name: 'My agent', version: '0.0.9', isBuiltIn: false, userId: 'u1',
    packagePath: 'old.zip', imageUrl: 'img:0.0.9', validationStatus: 'APPROVED',
  }

  it('with a new version replaces the uploader\'s own agent in place', async () => {
    const { service, prisma, storage } = makeService(mine)
    const res = await service.createFromPackage(buffer, 'u1')
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

  it('a re-upload also starts the build on its own, same as a first upload', async () => {
    const { service, build } = makeService(mine)
    await service.createFromPackage(buffer, 'u1')
    expect(build.startBuild).toHaveBeenCalledWith('a1', 'u1')
  })

  it('with the same version is refused, and stores nothing', async () => {
    const { service, prisma, pkg } = makeService({ ...mine, version: '0.1.0' })
    await expect(service.createFromPackage(buffer, 'u1')).rejects.toThrow('raise metadata.version')
    expect(pkg.storePackage).not.toHaveBeenCalled()
    expect(prisma.agentType.update).not.toHaveBeenCalled()
  })

  it.each([
    ['another user\'s agent', { ...mine, userId: 'u2' }],
    ['a built-in agent', { ...mine, userId: null, isBuiltIn: true }],
  ])('never replaces %s', async (_what, row) => {
    const { service, prisma, pkg } = makeService(row as Record<string, unknown>)
    await expect(service.createFromPackage(buffer, 'u1')).rejects.toThrow('Another agent already uses the slug')
    expect(pkg.storePackage).not.toHaveBeenCalled()
    expect(prisma.agentType.update).not.toHaveBeenCalled()
  })
})

describe('sharing an agent with projects', () => {
  const mine = { id: 'a1', slug: 'my-agent', name: 'My agent', isBuiltIn: false, userId: 'owner' }

  it('replaces the shared set with projects the owner is a member of', async () => {
    const { service, prisma } = makeService(mine)
    prisma.projectMembership.findMany.mockResolvedValue([{ projectId: 'p1' }, { projectId: 'p2' }])
    await expect(service.updateShares('a1', 'owner', ['p1', 'p2', 'p1'])).resolves.toEqual({
      projectIds: ['p1', 'p2'],
    })
    expect(prisma.agentTypeProjectShare.deleteMany).toHaveBeenCalledWith({
      where: { agentTypeId: 'a1', projectId: { notIn: ['p1', 'p2'] } },
    })
    expect(prisma.agentTypeProjectShare.upsert).toHaveBeenCalledTimes(2)
  })

  it('refuses a project the owner is not in', async () => {
    const { service, prisma } = makeService(mine)
    prisma.projectMembership.findMany.mockResolvedValue([{ projectId: 'p1' }])
    await expect(service.updateShares('a1', 'owner', ['p1', 'not-mine'])).rejects.toThrow(
      'projects you are a member of',
    )
  })

  it.each([
    ['a member it is shared with', 'member', false],
    ['a system admin', 'admin', true],
  ])('is the owner\'s alone, not %s\'s', async (_who, userId) => {
    const { service } = makeService(mine)
    await expect(service.updateShares('a1', userId as string, [])).rejects.toThrow(ForbiddenException)
    await expect(service.getShares('a1', userId as string)).rejects.toThrow(ForbiddenException)
  })

  it('never shares a built-in agent', async () => {
    const { service } = makeService({ ...mine, isBuiltIn: true, userId: null })
    await expect(service.updateShares('a1', 'owner', [])).rejects.toThrow(ForbiddenException)
  })
})

describe('build-status (#961: the window still has something to show after reopening)', () => {
  const mine = { id: 'a1', userId: 'owner1', isBuiltIn: false }

  it('returns null when the agent has never been built', async () => {
    const { service, prisma } = makeService(mine)
    prisma.agentBuildLog.findFirst.mockResolvedValue(null)
    await expect(service.getBuildStatus('a1', 'owner1')).resolves.toBeNull()
  })

  it('includes the stored output of the latest build, for whoever may see it', async () => {
    const { service, prisma, build } = makeService(mine)
    prisma.agentBuildLog.findFirst.mockResolvedValue({ id: 'log1' })
    build.getBuildStatus.mockResolvedValue({ id: 'log1', status: 'failed', errorMessage: 'boom' })
    build.getBuildOutput.mockResolvedValue('Step 1/5 ...\nERROR: boom')
    await expect(service.getBuildStatus('a1', 'owner1')).resolves.toMatchObject({
      status: 'failed', errorMessage: 'boom', buildOutput: 'Step 1/5 ...\nERROR: boom',
    })
  })
})

describe('who may see an agent build', () => {
  const upload = { id: 'a1', isBuiltIn: false, userId: 'owner' }
  const sharedWith = (prisma: any, projectId: string, memberId: string) => {
    prisma.agentTypeProjectShare.findMany.mockResolvedValue([{ projectId }])
    prisma.projectMembership.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(where.userId === memberId ? [{ projectId }] : []),
    )
  }

  it.each(['status', 'history'] as const)('refuses a stranger the build %s, before reading it', async (which) => {
    const { service, prisma, build } = makeService(upload)
    sharedWith(prisma, 'p1', 'member')
    const run = which === 'status' ? service.getBuildStatus('a1', 'stranger') : service.getBuildHistory('a1', 'stranger')
    await expect(run).rejects.toThrow(ForbiddenException)
    expect(prisma.agentBuildLog.findFirst).not.toHaveBeenCalled()
    expect(build.getBuildHistory).not.toHaveBeenCalled()
  })

  it.each(['status', 'history'] as const)('answers 404 for an unknown agent on the build %s', async (which) => {
    const { service } = makeService(null)
    const run = which === 'status' ? service.getBuildStatus('a1', 'owner') : service.getBuildHistory('a1', 'owner')
    await expect(run).rejects.toThrow(NotFoundException)
  })

  it.each([
    ['its owner', 'owner', false],
    ['a member of a project it is shared with', 'member', false],
    ['an admin', 'admin', true],
  ])('lets %s see the build', async (_who, userId, isSystemAdmin) => {
    const { service, prisma, build } = makeService(upload)
    sharedWith(prisma, 'p1', 'member')
    prisma.agentBuildLog.findFirst.mockResolvedValue({ id: 'log1' })
    build.getBuildStatus.mockResolvedValue({ id: 'log1', status: 'success' })
    build.getBuildHistory.mockResolvedValue([{ id: 'log1' }])

    await expect(service.getBuildStatus('a1', userId as string, isSystemAdmin as boolean)).resolves.toEqual({
      id: 'log1', status: 'success',
    })
    await expect(service.getBuildHistory('a1', userId as string, isSystemAdmin as boolean)).resolves.toEqual([
      { id: 'log1' },
    ])
  })

  it('keeps a built-in agent build to admins', async () => {
    const { service } = makeService({ id: 'a1', isBuiltIn: true, userId: null })
    await expect(service.getBuildStatus('a1', 'someone')).rejects.toThrow(ForbiddenException)
    await expect(service.getBuildStatus('a1', 'admin', true)).resolves.toBeNull()
  })
})
