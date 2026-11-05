import { jest } from '@jest/globals';
import { WebhooksService } from './webhooks.service.js';
import { bindingRequestsFrom } from '../connectors/connector-bindings.util.js';

/**
 * An agent paused for inactivity and recreated on wake (no paused record left
 * to restart) must come back with the connectors it was deployed with, as the
 * member who deployed it.
 */
describe('auto-pause and wake keep an agent\'s connectors', () => {
  const bindings = [
    { handle: 'elias', connectorId: 'conn-1', slot: 'elias' },
    { handle: 'notes', connectorId: 'conn-2' },
  ];

  function setup(memberships: Array<{ userId: string; role: string }>) {
    let savedSnapshot: any = null;
    const prisma: any = {
      session: {
        findUnique: jest.fn(async () => ({
          id: 's1',
          agents: [
            {
              id: 'a1',
              name: 'ELIAS',
              icon: '🎙️',
              agentType: 'elias-interviewer',
              agentConfig: { elias: { project_id: 'p' } },
              envVarTemplateId: 't1',
              manualEnvVarsEncrypted: null,
              connectorBindings: bindings,
              deployedByUserId: 'member-2',
            },
          ],
        })),
        update: jest.fn(async ({ data }: any) => {
          savedSnapshot = data.lastAgentConfig;
        }),
      },
      agentInstance: {
        update: jest.fn(async () => ({})),
        findFirst: jest.fn(async () => null), // no paused record: wake must create a new agent
      },
      projectMembership: {
        findFirst: jest.fn(async ({ where }: any) => {
          const match = memberships.find((m) =>
            where.userId ? m.userId === where.userId : where.role.in.includes(m.role),
          );
          return match ? { ...match, projectId: 'proj' } : null;
        }),
      },
    };
    const agents: any = {
      stopAgent: jest.fn(async () => ({})),
      create: jest.fn(async () => ({ id: 'a2' })),
    };
    const service = new WebhooksService(prisma, {} as any, {} as any, { decrypt: jest.fn() } as any, agents, {} as any);
    return { service: service as any, agents, snapshot: () => savedSnapshot };
  }

  it('saves the bindings and the deployer when pausing, and redeploys with them on wake', async () => {
    const { service, agents, snapshot } = setup([
      { userId: 'owner-1', role: 'OWNER' },
      { userId: 'member-2', role: 'MEMBER' },
    ]);
    await service.pauseAgents('s1');
    expect(snapshot()).toMatchObject({
      connectorBindings: bindingRequestsFrom(bindings),
      deployedByUserId: 'member-2',
    });

    await service.spawnOrResumeAgent({ id: 's1', projectId: 'proj', lastAgentConfig: snapshot() });
    expect(agents.create).toHaveBeenCalledTimes(1);
    const [sessionId, dto, userId] = agents.create.mock.calls[0] as any[];
    expect(sessionId).toBe('s1');
    expect(userId).toBe('member-2');
    expect(dto.connectorBindings).toEqual([
      { connectorId: 'conn-1', handle: 'elias', slot: 'elias' },
      { connectorId: 'conn-2', handle: 'notes' },
    ]);
  });

  it('falls back to an owner when the deployer left the project', async () => {
    const { service, agents, snapshot } = setup([{ userId: 'owner-1', role: 'OWNER' }]);
    await service.pauseAgents('s1');
    await service.spawnOrResumeAgent({ id: 's1', projectId: 'proj', lastAgentConfig: snapshot() });
    expect((agents.create.mock.calls[0] as any[])[2]).toBe('owner-1');
  });

  it('wakes an older snapshot without bindings as before', async () => {
    const { service, agents } = setup([{ userId: 'owner-1', role: 'OWNER' }]);
    await service.spawnOrResumeAgent({
      id: 's1',
      projectId: 'proj',
      lastAgentConfig: { name: 'Old', agentType: 'stella-v2-agent', agentConfig: {} },
    });
    const [, dto, userId] = agents.create.mock.calls[0] as any[];
    expect(dto.connectorBindings).toBeUndefined();
    expect(userId).toBe('owner-1');
  });
});
