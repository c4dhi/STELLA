import { jest } from '@jest/globals'
import { UserMessageType } from '@prisma/client'
import { UserMessagesService } from './user-messages.service.js'

function makeService() {
  const rows: Record<string, { id: string; userId: string; type: string; title: string; body: string | null; read: boolean; createdAt: Date; relatedEntityId: string | null; relatedEntityType: string | null }> = {}
  let nextId = 1

  const prisma = {
    userMessage: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const id = `msg${nextId++}`
        const row = { id, read: false, createdAt: new Date(), ...data } as (typeof rows)[string]
        rows[id] = row
        return Promise.resolve(row)
      }),
      count: jest.fn(() => Promise.resolve(Object.values(rows).filter((r) => !r.read).length)),
    },
  }

  const service = new UserMessagesService(prisma as any)
  return { service, rows }
}

describe('UserMessagesService.createAgentBuildFailedMessage', () => {
  it('creates a message for the given recipient, pointing at the agent type', async () => {
    const { service, rows } = makeService()

    await service.createAgentBuildFailedMessage('user1', 'agent1', 'My Agent', 'Docker build failed: boom')

    const [row] = Object.values(rows)
    expect(row).toMatchObject({
      userId: 'user1',
      type: UserMessageType.AGENT_BUILD_FAILED,
      title: 'Build failed: My Agent',
      body: 'Docker build failed: boom',
      relatedEntityId: 'agent1',
      relatedEntityType: 'AgentType',
    })
  })

  it('emits a message.created event so an open tab hears about it live', async () => {
    const { service } = makeService()
    const events: unknown[] = []
    const subscription = service.getUserNotificationStream('user1').subscribe((e) => events.push(e))

    await service.createAgentBuildFailedMessage('user1', 'agent1', 'My Agent', 'boom')
    await new Promise((r) => setImmediate(r))

    expect(events).toHaveLength(1)
    expect(JSON.parse((events[0] as { data: string }).data)).toMatchObject({
      type: 'message.created',
      userId: 'user1',
    })
    subscription.unsubscribe()
  })
})
