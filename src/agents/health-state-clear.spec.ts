import { jest } from '@jest/globals';
import { AgentsService } from './agents.service.js';

// A stopped agent must not keep reporting the healthState AgentServerService
// last wrote it ("ready" is the common case) - agents_get / GET /agents/:id
// would otherwise call a stopped agent healthy (#807).
function service(agent: { id: string; sessionId: string; status: string; healthState: string | null; podName: string | null }) {
  const update = jest.fn(async (args: any) => ({ ...agent, ...args.data }));
  const s = Object.create(AgentsService.prototype);
  s.prisma = {
    agentInstance: {
      findUnique: jest.fn(async () => agent),
      findMany: jest.fn(async () => [agent]),
      update,
    },
  };
  s.k8s = {
    deletePod: jest.fn(async () => undefined),
    deleteSecret: jest.fn(async () => undefined),
    deleteConfigMap: jest.fn(async () => undefined),
  };
  s.logger = { log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  s.sessionsService = undefined;
  return { s, update };
}

describe('clearing healthState when an agent stops', () => {
  it('stopAgent clears a ready healthState', async () => {
    const agent = { id: 'a1', sessionId: 's1', status: 'RUNNING', healthState: 'ready', podName: 'pod-a1' };
    const { s, update } = service(agent);

    const result = await s.stopAgent('a1');

    expect(result.healthState).toBeNull();
    const stopCall = update.mock.calls.find((c: any) => c[0].data.status === 'STOPPED');
    expect(stopCall[0].data.healthState).toBeNull();
  });

  it('stopAllSessionAgents clears a ready healthState on every agent it stops', async () => {
    // Fake timers: stopAllSessionAgents races each stop against a 30s
    // timeout whose handle survives the race, which otherwise leaves a
    // real pending timer and makes Jest force-exit after this test.
    jest.useFakeTimers();
    const agent = { id: 'a1', sessionId: 's1', status: 'RUNNING', healthState: 'ready', podName: 'pod-a1' };
    const { s, update } = service(agent);

    await s.stopAllSessionAgents('s1');

    const stopCall = update.mock.calls.find((c: any) => c[0].data.status === 'STOPPED');
    expect(stopCall[0].data.healthState).toBeNull();
    jest.useRealTimers();
  });
});
