import { jest } from '@jest/globals'
import { AgentValidationStatus } from '@prisma/client'
import { AgentTypeService } from './agent-type.service.js'

const { APPROVED, PENDING, REJECTED } = AgentValidationStatus

// A custom agent is its owner's; others see it only in a project it is shared with.
describe('AgentTypeService agent list', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 'x', slug: 'x', name: 'X', description: '', icon: null, version: '1.0.0', deprecated: false,
    deprecationNote: null, capabilities: [], defaultConfig: {}, configSchema: null, pipelineSchema: null,
    expertDefaults: null, manifest: null, isBuiltIn: false, validationStatus: PENDING, userId: 'owner',
    projectShares: [] as { projectId: string; project?: { name: string } }[], user: { name: 'Olga', email: 'o@x' }, ...over,
  })
  const rows = [
    row({ id: 'builtin', isBuiltIn: true, validationStatus: APPROVED, userId: null, user: null }),
    row({ id: 'mine', userId: 'viewer', user: { name: 'Me', email: 'me@x' } }),
    row({ id: 'shared-p1', projectShares: [{ projectId: 'p1', project: { name: 'Study A' } }, { projectId: 'p9', project: { name: 'Not yours' } }] }),
    row({ id: 'shared-p2', projectShares: [{ projectId: 'p2', project: { name: 'Study B' } }] }),
    row({ id: 'rejected', validationStatus: REJECTED, projectShares: [{ projectId: 'p1' }] }),
  ]

  function service(reviewRequired = false) {
    const prisma = {
      projectMembership: { findMany: jest.fn().mockResolvedValue([{ projectId: 'p1' }, { projectId: 'p2' }] as never) },
      agentType: { findMany: jest.fn().mockResolvedValue(rows as never) },
    }
    const settings = { isAgentReviewRequired: jest.fn().mockResolvedValue(reviewRequired as never) }
    return { prisma, svc: new AgentTypeService(prisma as any, settings as any) }
  }

  it('lists built-ins, the viewer\'s own uploads and uploads shared with their projects', async () => {
    const { svc, prisma } = service()
    const list = await svc.getAgentTypesForGallery({ userId: 'viewer' })
    expect(list.map((t) => [t.id, t.sharedWithYou, t.ownerName])).toEqual([
      ['builtin', false, null],
      ['mine', false, 'Me'],
      ['shared-p1', true, 'Olga'],
      ['shared-p2', true, 'Olga'],
    ])
    const where = (prisma.agentType.findMany.mock.calls[0][0] as any).where
    expect(where.OR[2]).toEqual({ isBuiltIn: false, projectShares: { some: { projectId: { in: ['p1', 'p2'] } } } })
  })

  it('names the viewer\'s projects a shared upload can be deployed in, and only those', async () => {
    const { svc } = service()
    const list = await svc.getAgentTypesForGallery({ userId: 'viewer' })
    expect(Object.fromEntries(list.map((t) => [t.id, t.sharedInProjects]))).toEqual({
      builtin: [],
      mine: [],
      'shared-p1': [{ id: 'p1', name: 'Study A' }],
      'shared-p2': [{ id: 'p2', name: 'Study B' }],
    })
  })

  it('narrows the shared ones to one project the viewer is in', async () => {
    const { svc } = service()
    const list = await svc.getAgentTypesForGallery({ userId: 'viewer', projectId: 'p1' })
    expect(list.map((t) => t.id)).toEqual(['builtin', 'mine', 'shared-p1'])
  })

  it('shows nothing shared for a project the viewer is not in', async () => {
    const { svc } = service()
    const list = await svc.getAgentTypesForGallery({ userId: 'viewer', projectId: 'not-mine' })
    expect(list.map((t) => t.id)).toEqual(['builtin', 'mine'])
  })

  it('with review on, others see a shared upload only once it is approved', async () => {
    const { svc } = service(true)
    const list = await svc.getAgentTypesForGallery({ userId: 'viewer' })
    expect(list.map((t) => t.id)).toEqual(['builtin', 'mine'])
  })
})
