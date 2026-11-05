import { jest } from '@jest/globals'
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common'
import { AgentUploadController } from './agent-upload.controller.js'
import { AgentAdminController } from './agent-admin.controller.js'
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
    agentType: {
      findUnique: jest.fn().mockResolvedValue(agentRecord),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'new', ...data })),
      delete: jest.fn().mockResolvedValue({}),
    },
  }
  const pkg = {
    validatePackage: jest.fn().mockResolvedValue({ valid: true, manifest: m, errors: [], warnings: [] }),
    storePackage: jest.fn().mockResolvedValue({ path: 'p', size: 1, hash: 'h' }),
    readExpertDefaults: jest.fn().mockReturnValue(null),
  }
  const build = { startBuild: jest.fn().mockResolvedValue({ buildLogId: 'b1' }) }
  const storage = { delete: jest.fn().mockResolvedValue(undefined) }
  const controller = new AgentUploadController(pkg as any, build as any, storage as any, prisma as any)
  return { controller, prisma, pkg, build, storage }
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

  const upload = { id: 'a1', slug: 'my-agent', isBuiltIn: false, packagePath: 'p', userId: 'owner' }

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
    if (allowed) await expect(run).resolves.toEqual({ success: true })
    else await expect(run).rejects.toThrow(ForbiddenException)
    expect(prisma.agentType.delete).toHaveBeenCalledTimes(allowed ? 1 : 0)
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
    return { controller: new AgentAdminController(prisma as any), prisma }
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
