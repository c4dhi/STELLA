import { jest } from '@jest/globals';
// SessionsService imports heavy collaborators (AgentsService → KubernetesService /
// agent-server gRPC, LiveKitService) whose transitive deps are ESM-only
// (@kubernetes/client-node, uuid, livekit-server-sdk) and trip ts-jest. close()
// only needs a stub AgentsService, so cut those module subtrees at the boundary.
jest.mock('../agents/agents.service', () => ({ AgentsService: class {} }));
jest.mock('../livekit/livekit.service', () => ({ LiveKitService: class {} }));
jest.mock('../message-recorder/room-monitor.service', () => ({ RoomMonitorService: class {} }));
jest.mock('livekit-server-sdk', () => ({ TokenVerifier: class {}, AccessToken: class {} }));

import { NotFoundException } from '@nestjs/common';
import { SessionsService } from './sessions.service.js';

type SessionStatus = 'ACTIVE' | 'CLOSING' | 'CLOSED';
type SessionRow = {
  id: string;
  projectId: string;
  name: string | null;
  status: SessionStatus;
  room?: { livekitRoomName: string };
};

/**
 * Build a SessionsService with just the dependencies close() touches mocked.
 * `order` records the lifecycle steps so tests can assert that the session
 * enters CLOSING *before* agents are torn down and reaches CLOSED *after*.
 */
function setup(opts: { session: SessionRow | null; finalizeCount?: number }) {
  const order: string[] = [];

  const prisma: any = {
    session: {
      findUnique: jest.fn(async () => opts.session),
      updateMany: jest.fn(async ({ data }: any) => {
        if (data.status === 'CLOSING') {
          order.push('CLOSING');
          return { count: 1 };
        }
        if (data.status === 'CLOSED') {
          order.push('CLOSED');
          return { count: opts.finalizeCount ?? 1 };
        }
        return { count: 0 };
      }),
    },
    invitation: { updateMany: jest.fn(async () => ({ count: 2 })) },
    participant: { updateMany: jest.fn(async () => ({ count: 1 })) },
    message: { create: jest.fn(async () => ({ id: 'm1' })) },
  };

  const agents: any = {
    stopAllSessionAgents: jest.fn(async () => {
      order.push('stopAgents');
    }),
  };

  const eventEmitter: any = { emit: jest.fn() };
  const livekit: any = {
    sendData: jest.fn(async () => undefined),
    deleteRoom: jest.fn(async () => undefined),
  };
  const service = new SessionsService(
    prisma,
    livekit,
    agents,
    {} as any, // roomMonitor
    {} as any, // authService
    eventEmitter,
  );
  const emitSpy = jest
    .spyOn(service, 'emitSessionClosed')
    .mockImplementation(() => undefined);

  return { service, prisma, agents, livekit, eventEmitter, emitSpy, order };
}

describe('SessionsService.close (lifecycle)', () => {
  afterEach(() => jest.clearAllMocks());

  it('throws NotFound when the session does not exist', async () => {
    const { service } = setup({ session: null });
    await expect(service.close('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('takes an ACTIVE session ACTIVE → CLOSING → CLOSED, stopping agents in the teardown window', async () => {
    const { service, prisma, agents, livekit, emitSpy, order } = setup({
      session: {
        id: 's1',
        projectId: 'p1',
        name: 'Demo',
        status: 'ACTIVE',
        room: { livekitRoomName: 'room-1' },
      },
    });

    const res = await service.close('s1');

    // Enters CLOSING (guarded on ACTIVE) before tearing agents down.
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', status: 'ACTIVE' },
      data: { status: 'CLOSING' },
    });
    expect(agents.stopAllSessionAgents).toHaveBeenCalledWith('s1');

    // Tears down the LiveKit room so any lingering participant is disconnected (#198).
    expect(livekit.deleteRoom).toHaveBeenCalledWith('room-1');

    // Revokes pending/accepted invitations and marks participants left.
    expect(prisma.invitation.updateMany).toHaveBeenCalledWith({
      where: { sessionId: 's1', status: { in: ['PENDING', 'ACCEPTED'] } },
      data: { status: 'REVOKED' },
    });
    expect(prisma.participant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionId: 's1', leftAt: null } }),
    );

    // Finalizes CLOSING → CLOSED, status-guarded, with closedAt + recorderShouldJoin.
    expect(prisma.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 's1', status: { in: ['ACTIVE', 'CLOSING'] } },
        data: expect.objectContaining({
          status: 'CLOSED',
          recorderShouldJoin: false,
          closedAt: expect.any(Date),
        }),
      }),
    );

    // Lifecycle ordering and a single session.closed emit.
    expect(order).toEqual(['CLOSING', 'stopAgents', 'CLOSED']);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('s1', 'p1', 'Demo');
    expect(res).toEqual({ message: 'Session closed successfully' });
  });

  it('is idempotent: closing an already-CLOSED session is a no-op', async () => {
    const { service, prisma, agents, emitSpy } = setup({
      session: { id: 's1', projectId: 'p1', name: null, status: 'CLOSED' },
    });

    const res = await service.close('s1');

    expect(agents.stopAllSessionAgents).not.toHaveBeenCalled();
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
    expect(prisma.invitation.updateMany).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
    expect(res).toEqual({ message: 'Session already closed' });
  });

  it('finalizes a CLOSING session without re-entering CLOSING (natural-end / graceful path)', async () => {
    const { service, prisma, agents, emitSpy, order } = setup({
      session: { id: 's1', projectId: 'p1', name: 'Demo', status: 'CLOSING' },
    });

    await service.close('s1');

    // No ACTIVE → CLOSING write; it is already CLOSING.
    expect(prisma.session.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'CLOSING' } }),
    );
    expect(agents.stopAllSessionAgents).toHaveBeenCalledWith('s1');
    expect(order).toEqual(['stopAgents', 'CLOSED']);
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  it('does not double-emit when a concurrent close finalizes first', async () => {
    const { service, emitSpy } = setup({
      session: { id: 's1', projectId: 'p1', name: 'Demo', status: 'CLOSING' },
      finalizeCount: 0, // guarded finalize matched no rows — someone else won the race
    });

    const res = await service.close('s1');

    expect(emitSpy).not.toHaveBeenCalled();
    expect(res).toEqual({ message: 'Session closed successfully' });
  });
});

describe('SessionsService.beginGracefulClose (issue #198)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('locks down to CLOSING, signals wrap-up over LiveKit, then force-closes at the deadline', async () => {
    const { service, prisma, agents, livekit, emitSpy } = setup({
      session: {
        id: 's1',
        projectId: 'p1',
        name: 'Demo',
        status: 'ACTIVE',
        room: { livekitRoomName: 'room-1' },
      },
    });

    await service.beginGracefulClose('s1', 'session_end', 1_000);

    // Lockdown: ACTIVE → CLOSING.
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', status: 'ACTIVE' },
      data: { status: 'CLOSING' },
    });
    // Reason-carrying wrap-up signal published over the LiveKit data channel.
    expect(livekit.sendData).toHaveBeenCalledWith('room-1', {
      type: 'session_end',
      reason: 'session_end',
      deadline_ms: 1_000,
    });
    // The agent still has its grace window — no teardown yet.
    expect(agents.stopAllSessionAgents).not.toHaveBeenCalled();

    // The wait budget alone does not force-close: the farewell reserve (15s) is
    // still owed to the closing turn.
    await jest.advanceTimersByTimeAsync(1_000);
    expect(agents.stopAllSessionAgents).not.toHaveBeenCalled();

    // Only at wait + farewell reserve does the hard backstop force-close.
    await jest.advanceTimersByTimeAsync(15_000);
    expect(agents.stopAllSessionAgents).toHaveBeenCalledWith('s1');
    expect(emitSpy).toHaveBeenCalledWith('s1', 'p1', 'Demo');
  });

  it('is a no-op for an already-closed session (no signal, no lockdown)', async () => {
    const { service, prisma, livekit } = setup({
      session: { id: 's1', projectId: 'p1', name: null, status: 'CLOSED' },
    });

    const res = await service.beginGracefulClose('s1', 'session_end', 1_000);

    expect(prisma.session.updateMany).not.toHaveBeenCalled();
    expect(livekit.sendData).not.toHaveBeenCalled();
    expect(res).toEqual({ message: 'Session already closed' });
  });

  it('is a no-op for a session already CLOSING (no duplicate signal / force-close timer)', async () => {
    // A capped session that reached its plan end-state is already CLOSING and the
    // agent is mid-farewell. The cap timer firing must NOT re-publish session_end
    // (which would re-trigger the agent → a second goodbye) or arm a second
    // force-close timer. Guard: only an ACTIVE session begins a graceful close.
    const { service, prisma, agents, livekit } = setup({
      session: {
        id: 's1',
        projectId: 'p1',
        name: 'Demo',
        status: 'CLOSING',
        room: { livekitRoomName: 'room-1' },
      },
    });

    const res = await service.beginGracefulClose('s1', 'session_end', 1_000);

    expect(prisma.session.updateMany).not.toHaveBeenCalled();
    expect(livekit.sendData).not.toHaveBeenCalled();
    expect(res).toEqual({ message: 'Session already closing' });

    // No force-close timer was armed by this call.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(agents.stopAllSessionAgents).not.toHaveBeenCalled();
  });

  it('throws NotFound when the session does not exist', async () => {
    const { service } = setup({ session: null });
    await expect(
      service.beginGracefulClose('missing', 'session_end', 1_000),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SessionsService.storeRecordedMessage — cap-timer arming (issue #198)', () => {
  afterEach(() => jest.clearAllMocks());

  it('emits session.agent-message for a spoken agent transcript (the LIVE path)', async () => {
    const { service, eventEmitter } = setup({
      session: { id: 's1', projectId: 'p1', name: null, status: 'ACTIVE' },
    });

    await service.storeRecordedMessage(
      's1',
      { type: 'transcript', data: { text: 'Hello there' } },
      'agent-abc',
      'Agent',
    );

    expect(eventEmitter.emit).toHaveBeenCalledWith('session.agent-message', { sessionId: 's1' });
  });

  it('does NOT emit for a user message', async () => {
    const { service, eventEmitter } = setup({
      session: { id: 's1', projectId: 'p1', name: null, status: 'ACTIVE' },
    });

    await service.storeRecordedMessage(
      's1',
      { type: 'transcript', data: { text: 'hi' } },
      'participant-123',
      'User',
    );

    expect(eventEmitter.emit).not.toHaveBeenCalledWith(
      'session.agent-message',
      expect.anything(),
    );
  });

  it('does NOT emit for non-spoken agent messages (e.g. debug)', async () => {
    const { service, eventEmitter } = setup({
      session: { id: 's1', projectId: 'p1', name: null, status: 'ACTIVE' },
    });

    await service.storeRecordedMessage(
      's1',
      { type: 'debug', data: { message: 'trace' } },
      'agent-abc',
      'Agent',
    );

    expect(eventEmitter.emit).not.toHaveBeenCalledWith(
      'session.agent-message',
      expect.anything(),
    );
  });
});
