import { jest } from '@jest/globals';
import { AgentsService } from './agents.service.js';

/**
 * #205: a deployment into a session whose interface is locked to text starts
 * the SDK's AudioPipeline in "text" mode from spawn, instead of leaving it on
 * "voice" until the frontend's post-join announcement lands -- that
 * announcement can be sent before the pipeline exists to receive it and is
 * then lost outright (see the live-logged repro on the card), not just late.
 */

const INVITATION_FIELDS = { visualizerType: true, visualizerLocked: true };

function serviceWithInvitations(invitations: Array<{ visualizerType: string | null; visualizerLocked: boolean }>) {
  const s = Object.create(AgentsService.prototype) as any;
  s.prisma = {
    invitation: {
      findMany: jest.fn(async (args: any) => {
        expect(args.select).toEqual(INVITATION_FIELDS);
        expect(args.where.status.in).toEqual(['PENDING', 'ACCEPTED']);
        return invitations;
      }),
    },
  };
  return s;
}

describe('resolveInitialInteractionMode (#205)', () => {
  it('is "text" when every relevant invitation locks the text visualizer', async () => {
    const s = serviceWithInvitations([
      { visualizerType: 'text', visualizerLocked: true },
      { visualizerType: 'text', visualizerLocked: true },
    ]);
    await expect(s.resolveInitialInteractionMode('session-1')).resolves.toBe('text');
  });

  it('is undefined with no invitation yet (initial deploy before anyone is invited)', async () => {
    const s = serviceWithInvitations([]);
    await expect(s.resolveInitialInteractionMode('session-1')).resolves.toBeUndefined();
  });

  it('is undefined when any relevant invitation is not locked to text', async () => {
    const s = serviceWithInvitations([
      { visualizerType: 'text', visualizerLocked: true },
      { visualizerType: 'face', visualizerLocked: false },
    ]);
    await expect(s.resolveInitialInteractionMode('session-1')).resolves.toBeUndefined();
  });

  it('is undefined when a text invitation is not locked (participant could still switch)', async () => {
    const s = serviceWithInvitations([{ visualizerType: 'text', visualizerLocked: false }]);
    await expect(s.resolveInitialInteractionMode('session-1')).resolves.toBeUndefined();
  });

  it('only looks at PENDING/ACCEPTED invitations, by construction of the query', async () => {
    // The mock above asserts the status filter on every call; a REVOKED or
    // EXPIRED invitation never reaches `invitations` in the first place.
    const s = serviceWithInvitations([]);
    await s.resolveInitialInteractionMode('session-1');
    expect(s.prisma.invitation.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('createAgentPodAsync merges interaction_mode into the pod config only (#205)', () => {
  function service() {
    const s = Object.create(AgentsService.prototype) as any;
    s.configService = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'LIVEKIT_API_KEY') return 'devkey';
        if (key === 'LIVEKIT_API_SECRET') return 'devsecret';
        return fallback;
      }),
    };
    s.k8s = { createAgentPod: jest.fn(async () => ({ podName: 'agent-1', secretName: 'agent-secret-1' })) };
    s.prisma = {
      agentInstance: {
        findUnique: jest.fn(async () => ({ connectorBindings: null })),
        update: jest.fn(),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    s.platformSettings = { applyToPodEnv: jest.fn(async (env: unknown) => env) };
    s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    s.eventEmitter = { emit: jest.fn() };
    return s;
  }

  const session = { id: 's1', projectId: 'p1', room: { livekitRoomName: 'room-1', serverUrl: 'ws://x' } };
  const requirements = { resources: undefined, client: undefined } as any;
  const createAgentDto = { icon: '🤖' } as any;
  const sanitizedConfig = { mode: 'companion' };

  it('adds interaction_mode to the pod config when given one, without mutating the caller\'s object', async () => {
    const s = service();
    await s.createAgentPodAsync('agent-1', session, 'Name', createAgentDto, 'stella-v2-agent', {}, sanitizedConfig, requirements, true, 'text');

    expect(s.k8s.createAgentPod).toHaveBeenCalledTimes(1);
    const call = s.k8s.createAgentPod.mock.calls[0][0];
    expect(call.agentConfig).toEqual({ mode: 'companion', interaction_mode: 'text' });
    expect(sanitizedConfig).toEqual({ mode: 'companion' }); // not mutated
  });

  it('leaves the pod config untouched with no initial interaction mode', async () => {
    const s = service();
    await s.createAgentPodAsync('agent-1', session, 'Name', createAgentDto, 'stella-v2-agent', {}, sanitizedConfig, requirements, true, undefined);

    const call = s.k8s.createAgentPod.mock.calls[0][0];
    expect(call.agentConfig).toEqual({ mode: 'companion' });
  });
});
