import { jest } from '@jest/globals';
// Integration test for the #198 auto-end flow: drives the REAL SessionTimeoutService
// and SessionsService together over a shared, mutable in-memory session store, with
// only the external boundaries (LiveKit, agents, Prisma I/O) stubbed. It exercises
// the whole backend story end-to-end:
//   first agent message → arm cap → cap fires → graceful close (CLOSING + LiveKit
//   session_end signal) → bounded grace → force-close (CLOSED + session.closed).
//
// ESM-only collaborator subtrees are cut at the boundary (see sessions.service.spec).
jest.mock('../agents/agents.service', () => ({ AgentsService: class {} }));
jest.mock('../livekit/livekit.service', () => ({ LiveKitService: class {} }));
jest.mock('../message-recorder/room-monitor.service', () => ({ RoomMonitorService: class {} }));
jest.mock('livekit-server-sdk', () => ({ TokenVerifier: class {}, AccessToken: class {} }));

import { SessionsService } from './sessions.service.js';
import { SessionTimeoutService } from './session-timeout.service.js';

type Store = {
  id: string;
  projectId: string;
  name: string | null;
  status: 'ACTIVE' | 'CLOSING' | 'CLOSED';
  closedAt: Date | null;
  recorderShouldJoin: boolean;
  maxSessionDurationSeconds: number | null;
  firstAgentMessageAt: Date | null;
  room: { livekitRoomName: string };
};

function matchesWhere(store: Store, where: any): boolean {
  if (where.id && where.id !== store.id) return false;
  if (where.status !== undefined) {
    if (typeof where.status === 'object' && Array.isArray(where.status.in)) {
      if (!where.status.in.includes(store.status)) return false;
    } else if (where.status !== store.status) {
      return false;
    }
  }
  if (where.firstAgentMessageAt === null && store.firstAgentMessageAt !== null) return false;
  return true;
}

function wire(store: Store) {
  const prisma: any = {
    session: {
      findUnique: jest.fn(async () => ({ ...store })),
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!matchesWhere(store, where)) return { count: 0 };
        Object.assign(store, data);
        return { count: 1 };
      }),
    },
    invitation: { updateMany: jest.fn(async () => ({ count: 0 })) },
    participant: { updateMany: jest.fn(async () => ({ count: 0 })) },
  };

  const livekit: any = {
    sendData: jest.fn(async () => undefined),
    deleteRoom: jest.fn(async () => undefined),
  };
  const agents: any = { stopAllSessionAgents: jest.fn(async () => undefined) };

  // Minimal event bus so close()/delete() lifecycle events reach the timeout service.
  const listeners: Record<string, Array<(p: any) => void>> = {};
  const eventEmitter: any = {
    emit: (evt: string, payload: any) => (listeners[evt] || []).forEach((fn) => fn(payload)),
    on: (evt: string, fn: (p: any) => void) => ((listeners[evt] ||= []).push(fn)),
  };

  const sessions = new SessionsService(
    prisma,
    livekit,
    agents,
    {} as any,
    {} as any,
    eventEmitter,
  );
  const closedEmit = jest
    .spyOn(sessions, 'emitSessionClosed')
    .mockImplementation(() => undefined);

  const timeout = new SessionTimeoutService(prisma, sessions);
  eventEmitter.on('session.lifecycle.closed', (p: any) => timeout.onSessionClosed(p));

  return { store, prisma, livekit, agents, sessions, timeout, closedEmit };
}

describe('Auto-end integration (#198): cap → graceful close → CLOSED', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-11T12:00:00.000Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('drives the full happy path end to end', async () => {
    const store: Store = {
      id: 's1',
      projectId: 'p1',
      name: 'Demo',
      status: 'ACTIVE',
      closedAt: null,
      recorderShouldJoin: true,
      maxSessionDurationSeconds: 120,
      firstAgentMessageAt: null,
      room: { livekitRoomName: 'room-1' },
    };
    const w = wire(store);

    // 1. First agent message arms the cap (anchor stamped).
    await w.timeout.onAgentMessage({ sessionId: 's1' });
    expect(store.firstAgentMessageAt).toBeInstanceOf(Date);
    expect(store.status).toBe('ACTIVE');

    // 2. Cap fires at 120s → graceful close begins: CLOSING + LiveKit session_end.
    await jest.advanceTimersByTimeAsync(120_000);
    expect(store.status).toBe('CLOSING');
    expect(w.livekit.sendData).toHaveBeenCalledWith('room-1', {
      type: 'session_end',
      reason: 'session_end',
      deadline_ms: 30_000, // budget for the agent to finish its current message
    });
    // Agent still has its grace window — not torn down yet.
    expect(w.agents.stopAllSessionAgents).not.toHaveBeenCalled();
    expect(store.status).not.toBe('CLOSED');

    // 3. After the full backstop (30s wait + 15s farewell reserve) → force-close.
    await jest.advanceTimersByTimeAsync(45_000);
    expect(store.status).toBe('CLOSED');
    expect(store.closedAt).toBeInstanceOf(Date);
    expect(w.agents.stopAllSessionAgents).toHaveBeenCalledWith('s1');
    // Participant is disconnected by tearing down the LiveKit room (#198).
    expect(w.livekit.deleteRoom).toHaveBeenCalledWith('room-1');
    expect(w.closedEmit).toHaveBeenCalledWith('s1', 'p1', 'Demo');

    // 4. Idempotent: no further timers fire and the session stays CLOSED.
    await jest.advanceTimersByTimeAsync(120_000);
    expect(store.status).toBe('CLOSED');
    expect(w.closedEmit).toHaveBeenCalledTimes(1);
  });

  it('does not arm a cap when none is configured (session runs untouched)', async () => {
    const store: Store = {
      id: 's2',
      projectId: 'p1',
      name: null,
      status: 'ACTIVE',
      closedAt: null,
      recorderShouldJoin: true,
      maxSessionDurationSeconds: null, // no cap
      firstAgentMessageAt: null,
      room: { livekitRoomName: 'room-2' },
    };
    const w = wire(store);

    await w.timeout.onAgentMessage({ sessionId: 's2' });
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(store.status).toBe('ACTIVE');
    expect(w.livekit.sendData).not.toHaveBeenCalled();
    expect(w.agents.stopAllSessionAgents).not.toHaveBeenCalled();
  });
});
