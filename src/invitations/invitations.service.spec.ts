import { jest } from '@jest/globals';
// InvitationsService pulls in LiveKitService / AuthService whose transitive deps
// are ESM-only (livekit-server-sdk) and trip ts-jest. create() only needs a stub
// of each, so cut those module subtrees at the boundary.
jest.mock('../livekit/livekit.service', () => ({ LiveKitService: class {} }));
jest.mock('../auth/auth.service', () => ({ AuthService: class {} }));
jest.mock('livekit-server-sdk', () => ({ TokenVerifier: class {}, AccessToken: class {} }));

import { InvitationsService } from './invitations.service.js';

type SessionRow = {
  id: string;
  status: 'ACTIVE' | 'CLOSING' | 'CLOSED';
  room?: { id: string } | null;
  firstAgentMessageAt?: Date | null;
};

function setup(session: SessionRow) {
  const prisma: any = {
    session: {
      findUnique: jest.fn(async () => session),
      update: jest.fn(async () => ({})),
    },
    invitation: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => ({
        id: 'inv1',
        token: 'tok',
        ...data,
      })),
    },
  };
  const livekit: any = {};
  const authService: any = {};
  const configService: any = { get: jest.fn(() => 'http://localhost:8080') };
  const eventEmitter: any = { emit: jest.fn() };
  const service = new InvitationsService(
    prisma,
    livekit,
    authService,
    configService,
    eventEmitter,
  );
  return { service, prisma, eventEmitter };
}

describe('InvitationsService.create — max-duration cap propagation (#198)', () => {
  const activeSession: SessionRow = {
    id: 's1',
    status: 'ACTIVE',
    room: { id: 'r1' },
    firstAgentMessageAt: null,
  };

  it('propagates an invitation cap onto the session and announces the change', async () => {
    const { service, prisma, eventEmitter } = setup(activeSession);

    await service.create('s1', { maxSessionDurationSeconds: 600 } as any);

    expect(prisma.invitation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ maxSessionDurationSeconds: 600 }),
      }),
    );
    // Agent hasn't spoken yet → no re-anchor; onAgentMessage will stamp it.
    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { maxSessionDurationSeconds: 600 },
    });
    expect(eventEmitter.emit).toHaveBeenCalledWith('session.cap-changed', { sessionId: 's1' });
  });

  it('re-anchors the budget to NOW when the agent has already spoken (mid-session re-invite)', async () => {
    // The cap is applied after the agent first spoke long ago. Measuring the new cap
    // from that stale anchor would make it already-exhausted and instantly close the
    // live session — so the budget must restart from now.
    const stale = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const { service, prisma, eventEmitter } = setup({
      ...activeSession,
      firstAgentMessageAt: stale,
    });

    await service.create('s1', { maxSessionDurationSeconds: 600 } as any);

    const updateArg = prisma.session.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 's1' });
    expect(updateArg.data.maxSessionDurationSeconds).toBe(600);
    expect(updateArg.data.firstAgentMessageAt).toBeInstanceOf(Date);
    // Re-anchored to ~now, not the stale 1h-ago timestamp.
    expect(updateArg.data.firstAgentMessageAt.getTime()).toBeGreaterThan(stale.getTime());
    expect(eventEmitter.emit).toHaveBeenCalledWith('session.cap-changed', { sessionId: 's1' });
  });

  it('leaves the session uncapped and silent when no cap is supplied', async () => {
    const { service, prisma, eventEmitter } = setup(activeSession);

    await service.create('s1', {} as any);

    expect(prisma.invitation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ maxSessionDurationSeconds: null }),
      }),
    );
    expect(prisma.session.update).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });
});
