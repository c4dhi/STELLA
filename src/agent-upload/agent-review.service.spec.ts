import { jest } from '@jest/globals'
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { AgentValidationStatus } from '@prisma/client'
import { AgentReviewService } from './agent-review.service.js'

const upload = (over: Record<string, unknown> = {}) => ({
  id: 'at1',
  slug: 'my-agent',
  name: 'My agent',
  description: 'Does things',
  icon: '🤖',
  version: '1.0.0',
  isBuiltIn: false,
  validationStatus: AgentValidationStatus.PENDING,
  validationNotes: null,
  validatedAt: null,
  validatedBy: null,
  authorName: 'Ada',
  authorEmail: 'ada@x.test',
  resourceGpu: false,
  packageSize: 1234,
  createdAt: new Date('2026-11-01T10:00:00Z'),
  updatedAt: new Date('2026-11-01T10:00:00Z'),
  user: { id: 'u1', email: 'u@x.test', name: 'U' },
  buildLogs: [],
  ...over,
})

function setup(row: Record<string, unknown> | null = upload()) {
  const prisma = {
    agentType: {
      findMany: jest.fn(async (_args: any) => (row ? [row] : [])),
      findUnique: jest.fn(async (_args: any) => row),
      update: jest.fn(async ({ data }: any) => ({ ...row, ...data })),
    },
  }
  return { prisma, service: new AgentReviewService(prisma as any) }
}

describe('AgentReviewService.list', () => {
  it('lists uploads in one state, never built-ins, oldest pending first', async () => {
    const { prisma, service } = setup()
    const items = await service.list('pending')
    expect(prisma.agentType.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { validationStatus: AgentValidationStatus.PENDING, isBuiltIn: false },
        orderBy: { createdAt: 'asc' },
      }),
    )
    expect(items[0]).toMatchObject({
      id: 'at1',
      slug: 'my-agent',
      validationStatus: 'PENDING',
      owner: { id: 'u1', email: 'u@x.test', name: 'U' },
    })
  })

  it('shows the latest build, the SDK and what the manifest declares, build first', async () => {
    const { prisma, service } = setup(
      upload({
        sdkVersion: '0.10.0',
        manifest: {
          version: '2.0',
          metadata: { slug: 'my-agent', name: 'My agent', version: '1.0.0', description: 'x' },
          image: { dockerfile: 'Dockerfile' },
          env: { required: ['OPENAI_API_KEY'] },
        },
        buildLogs: [{ id: 'b1', status: 'FAILED', imageName: null, errorMessage: 'pip failed', startedAt: new Date(), completedAt: null }],
      }),
    )
    const [item] = await service.list('pending')
    expect((prisma.agentType.findMany.mock.calls[0][0] as any).include.buildLogs).toEqual({
      orderBy: { startedAt: 'desc' },
      take: 1,
    })
    expect(Object.keys(item)[0]).toBe('lastBuild')
    expect(item.lastBuild).toMatchObject({ status: 'FAILED', errorMessage: 'pip failed' })
    expect(item.sdkVersion).toBe('0.10.0')
    expect(item.manifestError).toBeNull()
    expect(item.requirements?.env.required).toEqual(['OPENAI_API_KEY'])
  })

  it('names a manifest STELLA cannot read instead of failing the list', async () => {
    const { service } = setup(upload({ manifest: { version: '2.0', metadata: 'nonsense' } }))
    const [item] = await service.list('pending')
    expect(item.requirements).toBeNull()
    expect(item.manifestError).toEqual(expect.any(String))
  })

  it('lists reviewed uploads newest first', async () => {
    const { prisma, service } = setup()
    await service.list('rejected')
    expect(prisma.agentType.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { validationStatus: AgentValidationStatus.REJECTED, isBuiltIn: false },
        orderBy: { updatedAt: 'desc' },
      }),
    )
  })

  it('refuses a state that does not exist', async () => {
    const { service } = setup()
    await expect(service.list('maybe')).rejects.toThrow(BadRequestException)
  })
})

describe('AgentReviewService.approve', () => {
  it('approves with the admin and their notes', async () => {
    const { prisma, service } = setup()
    const result = await service.approve('at1', 'admin-1', 'Looks fine')
    expect(prisma.agentType.update).toHaveBeenCalledWith({
      where: { id: 'at1' },
      data: expect.objectContaining({
        validationStatus: AgentValidationStatus.APPROVED,
        validationNotes: 'Looks fine',
        validatedBy: 'admin-1',
      }),
    })
    expect(result).toMatchObject({ id: 'at1', validationStatus: 'APPROVED', validationNotes: 'Looks fine' })
  })

  it('stores blank notes as none', async () => {
    const { prisma, service } = setup()
    await service.approve('at1', 'admin-1', '   ')
    expect((prisma.agentType.update.mock.calls[0][0] as any).data.validationNotes).toBeNull()
  })

  it('can approve an upload that was rejected before', async () => {
    const { service } = setup(upload({ validationStatus: AgentValidationStatus.REJECTED }))
    await expect(service.approve('at1', 'admin-1')).resolves.toMatchObject({ validationStatus: 'APPROVED' })
  })

  it('refuses an upload that is already approved, a built-in, or unknown', async () => {
    await expect(
      setup(upload({ validationStatus: AgentValidationStatus.APPROVED })).service.approve('at1', 'a'),
    ).rejects.toThrow('Agent is already approved')
    await expect(setup(upload({ isBuiltIn: true })).service.approve('at1', 'a')).rejects.toThrow(
      'Cannot modify built-in agents',
    )
    await expect(setup(null).service.approve('at1', 'a')).rejects.toThrow(NotFoundException)
  })
})

describe('AgentReviewService.reject', () => {
  it('rejects with the reason, trimmed', async () => {
    const { prisma, service } = setup()
    const result = await service.reject('at1', 'admin-1', '  Opens a shell  ')
    expect(prisma.agentType.update).toHaveBeenCalledWith({
      where: { id: 'at1' },
      data: expect.objectContaining({
        validationStatus: AgentValidationStatus.REJECTED,
        validationNotes: 'Opens a shell',
        validatedBy: 'admin-1',
      }),
    })
    expect(result).toMatchObject({ validationStatus: 'REJECTED', validationNotes: 'Opens a shell' })
  })

  it('needs a reason, so the uploader knows what to change', async () => {
    const { prisma, service } = setup()
    await expect(service.reject('at1', 'admin-1', '  ')).rejects.toThrow('Rejection reason is required')
    expect(prisma.agentType.update).not.toHaveBeenCalled()
  })

  it('can withdraw an approval', async () => {
    const { service } = setup(upload({ validationStatus: AgentValidationStatus.APPROVED }))
    await expect(service.reject('at1', 'admin-1', 'Leaks data')).resolves.toMatchObject({
      validationStatus: 'REJECTED',
    })
  })

  it('refuses an upload that is already rejected', async () => {
    const { service } = setup(upload({ validationStatus: AgentValidationStatus.REJECTED }))
    await expect(service.reject('at1', 'admin-1', 'Again')).rejects.toThrow('Agent is already rejected')
  })
})

describe('AgentReviewService.get', () => {
  it('returns the details with the recent builds', async () => {
    const { service } = setup(
      upload({
        buildLogs: [
          { id: 'b1', status: 'SUCCESS', imageName: 'img', errorMessage: null, startedAt: new Date(), completedAt: null },
        ],
      }),
    )
    const detail = await service.get('at1')
    expect(detail).toMatchObject({ id: 'at1', buildLogs: [{ id: 'b1', status: 'SUCCESS' }] })
  })

  it('is a 404 for an unknown id', async () => {
    await expect(setup(null).service.get('nope')).rejects.toThrow(NotFoundException)
  })
})
