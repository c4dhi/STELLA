import { jest } from '@jest/globals';
import { AgentsService } from './agents.service.js';
import { orphanAgentActions, reconcilerMode } from './orphaned-agent-pods.js';
import { AgentReconcilerService } from './agent-reconciler.service.js';

// Two production pods ran for weeks (#187/#188): a wake re-created an agent's
// pod while the session's close was stopping it. stopAgent read podName as
// null, deleted nothing, and the pod appeared afterwards with no row naming it.

function service(row: Record<string, unknown>) {
  const s = Object.create(AgentsService.prototype);
  const state = { ...row };
  s.prisma = {
    agentInstance: {
      findUnique: jest.fn(async () => ({ ...row })),
      update: jest.fn(async (args: any) => Object.assign(state, args.data, { podName: args.data.podName === undefined ? state.podName : args.data.podName })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  s.k8s = {
    deletePod: jest.fn(async () => undefined),
    deleteSecret: jest.fn(async () => undefined),
    deleteConfigMap: jest.fn(async () => undefined),
  };
  s.logger = { log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  s.sessionsService = undefined;
  return { s, state };
}

describe('a pod created while its agent is being stopped', () => {
  it('stopAgent cleans up the pod a wake recorded after stop first read the row', async () => {
    // stop reads podName null; by the time it marks the row STOPPING the wake has written podName.
    const { s, state } = service({ id: 'a1', sessionId: 's1', status: 'STARTING', podName: null, secretName: null, configMapName: null });
    s.prisma.agentInstance.update.mockImplementationOnce(async (args: any) =>
      Object.assign(state, args.data, { podName: 'agent-a1', secretName: 'agent-secret-a1' }),
    );

    await s.stopAgent('a1');

    expect(s.k8s.deletePod).toHaveBeenCalledWith('agent-a1');
    expect(s.k8s.deleteSecret).toHaveBeenCalledWith('agent-secret-a1');
  });

  it('a new pod is kept when its agent is still starting', async () => {
    const { s } = service({ id: 'a1' });
    const kept = await s.keepNewPod('a1', 'agent-a1', 'agent-secret-a1');
    expect(kept).toBe(true);
    expect(s.prisma.agentInstance.updateMany).toHaveBeenCalledWith({
      where: { id: 'a1', status: { notIn: ['STOPPING', 'STOPPED'] } },
      data: { podName: 'agent-a1', secretName: 'agent-secret-a1' },
    });
    expect(s.k8s.deletePod).not.toHaveBeenCalled();
  });

  it('a new pod is deleted, with its secret, when its agent was stopped meanwhile', async () => {
    const { s } = service({ id: 'a1' });
    s.prisma.agentInstance.updateMany.mockResolvedValueOnce({ count: 0 });
    const kept = await s.keepNewPod('a1', 'agent-a1', 'agent-secret-a1');
    expect(kept).toBe(false);
    expect(s.k8s.deletePod).toHaveBeenCalledWith('agent-a1');
    expect(s.k8s.deleteSecret).toHaveBeenCalledWith('agent-secret-a1');
  });
});

describe('the orphaned-pod reconciler decision', () => {
  const now = new Date('2026-11-19T12:00:00Z');
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
  const pod = (agentId: string) => ({ name: `agent-${agentId}`, agentId });

  it('deletes a pod whose agent row is gone', () => {
    const { deletePods } = orphanAgentActions([pod('gone')], [], new Map(), now);
    expect(deletePods).toEqual([{ podName: 'agent-gone', secretName: 'agent-secret-gone', agentId: 'gone', reason: 'no agent row' }]);
  });

  it('deletes a pod whose agent stopped more than 5 minutes ago', () => {
    const rows = [
      { id: 'old', status: 'STOPPED', stoppedAt: minutesAgo(80 * 24 * 60) },
      { id: 'failed', status: 'FAILED', stoppedAt: minutesAgo(6) },
    ];
    const { deletePods } = orphanAgentActions([pod('old'), pod('failed')], rows, new Map(), now);
    expect(deletePods.map((d) => d.agentId)).toEqual(['old', 'failed']);
  });

  it('gives a just-stopped agent 5 minutes before touching its pod', () => {
    const rows = [{ id: 'fresh', status: 'STOPPED', stoppedAt: minutesAgo(2) }];
    expect(orphanAgentActions([pod('fresh')], rows, new Map(), now).deletePods).toEqual([]);
  });

  it('never touches the pod of a running, starting or stopping agent', () => {
    const rows = [
      { id: 'r', status: 'RUNNING', stoppedAt: null },
      { id: 's', status: 'STARTING', stoppedAt: null },
      { id: 'x', status: 'STOPPING', stoppedAt: null },
    ];
    const { deletePods, markStopped } = orphanAgentActions([pod('r'), pod('s'), pod('x')], rows, new Map(), now);
    expect(deletePods).toEqual([]);
    expect(markStopped).toEqual([]);
  });

  it('marks a running agent stopped once its pod has been missing for over 10 minutes', () => {
    const rows = [{ id: 'ghost', status: 'RUNNING', stoppedAt: null }];
    const first = orphanAgentActions([], rows, new Map(), now);
    expect(first.markStopped).toEqual([]);
    expect(first.missingSince.get('ghost')).toEqual(now);

    const later = new Date(now.getTime() + 11 * 60_000);
    const second = orphanAgentActions([], rows, first.missingSince, later);
    expect(second.markStopped).toEqual(['ghost']);
  });

  it('retires it on the next sweep even when the 10-minute timer fires a little early', () => {
    const rows = [{ id: 'ghost', status: 'RUNNING', stoppedAt: null }];
    const first = orphanAgentActions([], rows, new Map(), now);
    const early = new Date(now.getTime() + 10 * 60_000 - 5);
    expect(orphanAgentActions([], rows, first.missingSince, early).markStopped).toEqual(['ghost']);
  });

  it('forgets a missing pod that comes back, and never marks a starting agent', () => {
    const rows = [
      { id: 'back', status: 'RUNNING', stoppedAt: null },
      { id: 'starting', status: 'STARTING', stoppedAt: null },
    ];
    const seen = new Map([['back', minutesAgo(30)], ['starting', minutesAgo(30)]]);
    const { markStopped, missingSince } = orphanAgentActions([pod('back')], rows, seen, now);
    expect(markStopped).toEqual([]);
    expect(missingSince.has('back')).toBe(false);
    expect(missingSince.has('starting')).toBe(false);
  });

  it('runs log-only unless deleting is switched on', () => {
    expect(reconcilerMode(undefined)).toBe('log');
    expect(reconcilerMode('')).toBe('log');
    expect(reconcilerMode('delete')).toBe('delete');
    expect(reconcilerMode('OFF')).toBe('off');
    expect(reconcilerMode('nonsense')).toBe('log');
  });
});

describe('the reconciler sweep', () => {
  const now = new Date('2026-11-19T12:00:00Z');
  function reconciler(mode: string | undefined) {
    const prisma = {
      agentInstance: {
        findMany: jest.fn(async () => [
          { id: 'old', status: 'STOPPED', stoppedAt: new Date('2026-08-28T14:53:30Z') },
          { id: 'live', status: 'RUNNING', stoppedAt: null },
          { id: 'ghost', status: 'RUNNING', stoppedAt: null },
        ]),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const k8s = {
      listAgentPods: jest.fn(async () => [{ name: 'agent-old', agentId: 'old' }, { name: 'agent-live', agentId: 'live' }]),
      deletePod: jest.fn(async () => undefined),
      deleteSecret: jest.fn(async () => undefined),
    };
    const config = { get: jest.fn(() => mode) };
    const r = new AgentReconcilerService(prisma as any, k8s as any, config as any);
    (r as any).logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    return { r, prisma, k8s };
  }

  it('log-only (the default) changes nothing', async () => {
    const { r, prisma, k8s } = reconciler(undefined);
    await r.sweep(now);
    await r.sweep(new Date(now.getTime() + 11 * 60_000));
    expect(k8s.deletePod).not.toHaveBeenCalled();
    expect(k8s.deleteSecret).not.toHaveBeenCalled();
    expect(prisma.agentInstance.updateMany).not.toHaveBeenCalled();
    expect((r as any).logger.warn).toHaveBeenCalledWith(expect.stringContaining('Would delete (log-only) orphaned agent pod agent-old'));
  });

  it('delete mode removes the stopped agent pod, never the live one, and retires the ghost row', async () => {
    const { r, prisma, k8s } = reconciler('delete');
    await r.sweep(now);
    expect(k8s.deletePod).toHaveBeenCalledWith('agent-old');
    expect(k8s.deleteSecret).toHaveBeenCalledWith('agent-secret-old');
    expect(k8s.deletePod).not.toHaveBeenCalledWith('agent-live');
    expect(prisma.agentInstance.updateMany).not.toHaveBeenCalled();

    await r.sweep(new Date(now.getTime() + 11 * 60_000));
    expect(prisma.agentInstance.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ghost', status: 'RUNNING' } }),
    );
    expect(k8s.deleteSecret).toHaveBeenCalledWith('agent-secret-ghost');
  });

  it('off skips the sweep', async () => {
    const { r, k8s } = reconciler('off');
    await r.sweep(now);
    expect(k8s.listAgentPods).not.toHaveBeenCalled();
  });
});
