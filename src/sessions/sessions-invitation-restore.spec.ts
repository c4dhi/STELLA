import { jest } from '@jest/globals';
// Same module cuts as sessions.service.spec.ts.
jest.mock('../agents/agents.service', () => ({ AgentsService: class {} }));
jest.mock('../livekit/livekit.service', () => ({ LiveKitService: class {} }));
jest.mock('../message-recorder/room-monitor.service', () => ({ RoomMonitorService: class {} }));

import { SessionsService } from './sessions.service.js';

type Inv = { id: string; sessionId: string; status: string; statusBeforeAutoRevoke: string | null; expiresAt: Date | null };

/**
 * An in-memory invitation table behind the few Prisma calls close() and
 * restoreAutoRevokedInvitations() make, so the tests follow invitations
 * through close → reopen as the database would (#170).
 */
function setup(invitations: Inv[]) {
  let sessionStatus = 'ACTIVE';
  const matches = (inv: Inv, where: any) =>
    (where.id === undefined || inv.id === where.id) &&
    (where.sessionId === undefined || inv.sessionId === where.sessionId) &&
    (where.status === undefined || inv.status === where.status) &&
    (where.statusBeforeAutoRevoke?.not !== null || inv.statusBeforeAutoRevoke !== null);
  const prisma: any = {
    session: {
      findUnique: jest.fn(async () => ({ id: 's1', projectId: 'p1', name: null, status: sessionStatus, room: { livekitRoomName: 'room-1' } })),
      updateMany: jest.fn(async ({ data }: any) => {
        sessionStatus = data.status;
        return { count: 1 };
      }),
    },
    invitation: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = invitations.filter((i) => matches(i, where));
        hit.forEach((i) => Object.assign(i, data));
        return { count: hit.length };
      }),
      findMany: jest.fn(async ({ where }: any) => invitations.filter((i) => matches(i, where)).map((i) => ({ ...i }))),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    participant: { updateMany: jest.fn(async () => ({ count: 0 })) },
    message: { create: jest.fn(async () => ({ id: 'm1' })) },
  };
  const service = new SessionsService(
    prisma,
    { sendData: jest.fn(async () => undefined), deleteRoom: jest.fn(async () => undefined) } as any,
    { stopAllSessionAgents: jest.fn(async () => undefined) } as any,
    {} as any,
    {} as any,
    { emit: jest.fn() } as any,
  );
  jest.spyOn(service, 'emitSessionClosed').mockImplementation(() => undefined);
  // A reopen sets the session ACTIVE again before giving invitations back.
  const reopen = async () => {
    sessionStatus = 'ACTIVE';
    return service.restoreAutoRevokedInvitations('s1');
  };
  return { service, reopen, byId: (id: string) => invitations.find((i) => i.id === id)! };
}

const inv = (id: string, status: string, expiresAt: Date | null = null): Inv => ({
  id, sessionId: 's1', status, statusBeforeAutoRevoke: null, expiresAt,
});

describe('invitations across an automatic close and reopen (#170)', () => {
  it('an automatic close revokes, and a rejoin gives back, pending and accepted invitations', async () => {
    const { service, reopen, byId } = setup([inv('pending', 'PENDING'), inv('accepted', 'ACCEPTED')]);
    await service.close('s1', 'automatic');
    expect(byId('pending')).toMatchObject({ status: 'REVOKED', statusBeforeAutoRevoke: 'PENDING' });
    expect(byId('accepted')).toMatchObject({ status: 'REVOKED', statusBeforeAutoRevoke: 'ACCEPTED' });

    await expect(reopen()).resolves.toBe(2);
    expect(byId('pending')).toMatchObject({ status: 'PENDING', statusBeforeAutoRevoke: null });
    expect(byId('accepted')).toMatchObject({ status: 'ACCEPTED', statusBeforeAutoRevoke: null });
  });

  it('an invitation revoked by hand before the close stays revoked', async () => {
    const { service, reopen, byId } = setup([inv('byHand', 'REVOKED'), inv('pending', 'PENDING')]);
    await service.close('s1', 'automatic');
    await reopen();
    expect(byId('byHand')).toMatchObject({ status: 'REVOKED', statusBeforeAutoRevoke: null });
    expect(byId('pending').status).toBe('PENDING');
  });

  it('an invitation that had already expired stays expired', async () => {
    const { service, reopen, byId } = setup([inv('expired', 'EXPIRED', new Date('2026-01-01'))]);
    await service.close('s1', 'automatic');
    await expect(reopen()).resolves.toBe(0);
    expect(byId('expired')).toMatchObject({ status: 'EXPIRED', statusBeforeAutoRevoke: null });
  });

  it('one whose expiry passed while the session was closed comes back expired, not pending', async () => {
    const { service, reopen, byId } = setup([inv('lapsed', 'PENDING', new Date(Date.now() + 60_000))]);
    await service.close('s1', 'automatic');
    byId('lapsed').expiresAt = new Date(Date.now() - 60_000);
    await reopen();
    expect(byId('lapsed')).toMatchObject({ status: 'EXPIRED', statusBeforeAutoRevoke: null });
  });

  it('a manual "Close session" is not undone by a rejoin', async () => {
    const { service, reopen, byId } = setup([inv('pending', 'PENDING')]);
    await service.close('s1');
    expect(byId('pending')).toMatchObject({ status: 'REVOKED', statusBeforeAutoRevoke: null });
    await expect(reopen()).resolves.toBe(0);
    expect(byId('pending').status).toBe('REVOKED');
  });
});
