import { jest } from '@jest/globals';
// SessionTimeoutService imports SessionsService (for the forwardRef token), which
// drags in the ESM-only collaborator subtrees. Cut them at the boundary so ts-jest
// doesn't choke — see sessions.service.spec.ts for the same rationale.
jest.mock('../agents/agents.service', () => ({ AgentsService: class {} }));
jest.mock('../livekit/livekit.service', () => ({ LiveKitService: class {} }));
jest.mock('../message-recorder/room-monitor.service', () => ({ RoomMonitorService: class {} }));
jest.mock('livekit-server-sdk', () => ({ TokenVerifier: class {}, AccessToken: class {} }));

import { SessionTimeoutService } from './session-timeout.service.js';

type SessionRow = {
  status: 'ACTIVE' | 'CLOSING' | 'CLOSED';
  maxSessionDurationSeconds: number | null;
  firstAgentMessageAt: Date | null;
};

function setup(opts: {
  session?: SessionRow | null;
  activeSessions?: Array<{
    id: string;
    status?: 'ACTIVE' | 'CLOSING';
    maxSessionDurationSeconds: number | null;
    firstAgentMessageAt: Date | null;
  }>;
  firstAgentMessage?: { timestamp: Date } | null;
}) {
  const prisma: any = {
    session: {
      findUnique: jest.fn(async () => opts.session ?? null),
      findMany: jest.fn(async () =>
        (opts.activeSessions ?? []).map((s) => ({ status: 'ACTIVE', ...s })),
      ),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    message: {
      findFirst: jest.fn(async () => opts.firstAgentMessage ?? null),
    },
  };
  const sessionsService: any = {
    beginGracefulClose: jest.fn(async () => ({ message: 'ok' })),
    close: jest.fn(async () => ({ message: 'closed' })),
  };
  const service = new SessionTimeoutService(prisma, sessionsService);
  return { service, prisma, sessionsService };
}

const NOW = new Date('2026-06-11T12:00:00.000Z');

describe('SessionTimeoutService (max-duration cap)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('arms on the first agent message, stamps the anchor, and closes at the cap', async () => {
    const { service, prisma, sessionsService } = setup({
      session: { status: 'ACTIVE', maxSessionDurationSeconds: 120, firstAgentMessageAt: null },
    });

    await service.onAgentMessage({ sessionId: 's1' });

    // Anchor stamped once, guarded on firstAgentMessageAt IS NULL.
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', firstAgentMessageAt: null },
      data: { firstAgentMessageAt: expect.any(Date) },
    });

    jest.advanceTimersByTime(119_000);
    expect(sessionsService.beginGracefulClose).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1_000);
    expect(sessionsService.beginGracefulClose).toHaveBeenCalledWith('s1', 'session_end');
  });

  it('uses an existing anchor to compute remaining time (no re-stamp)', async () => {
    const anchor = new Date('2026-06-11T11:59:00.000Z'); // 60s before NOW
    const { service, prisma, sessionsService } = setup({
      session: { status: 'ACTIVE', maxSessionDurationSeconds: 120, firstAgentMessageAt: anchor },
    });

    await service.onAgentMessage({ sessionId: 's1' });
    expect(prisma.session.updateMany).not.toHaveBeenCalled();

    // 120s cap, 60s already elapsed → 60s remaining.
    jest.advanceTimersByTime(59_000);
    expect(sessionsService.beginGracefulClose).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1_000);
    expect(sessionsService.beginGracefulClose).toHaveBeenCalledWith('s1', 'session_end');
  });

  it('does nothing when no cap is configured', async () => {
    const { service, sessionsService } = setup({
      session: { status: 'ACTIVE', maxSessionDurationSeconds: null, firstAgentMessageAt: null },
    });

    await service.onAgentMessage({ sessionId: 's1' });
    jest.advanceTimersByTime(10_000_000);
    expect(sessionsService.beginGracefulClose).not.toHaveBeenCalled();
  });

  it('does not arm for a non-ACTIVE session', async () => {
    const { service, sessionsService } = setup({
      session: { status: 'CLOSING', maxSessionDurationSeconds: 120, firstAgentMessageAt: null },
    });

    await service.onAgentMessage({ sessionId: 's1' });
    jest.advanceTimersByTime(200_000);
    expect(sessionsService.beginGracefulClose).not.toHaveBeenCalled();
  });

  it('is idempotent: repeated agent messages do not re-query or re-arm', async () => {
    const { service, prisma } = setup({
      session: { status: 'ACTIVE', maxSessionDurationSeconds: 120, firstAgentMessageAt: null },
    });

    await service.onAgentMessage({ sessionId: 's1' });
    await service.onAgentMessage({ sessionId: 's1' });
    await service.onAgentMessage({ sessionId: 's1' });

    // In-memory guard short-circuits after the first arm.
    expect(prisma.session.findUnique).toHaveBeenCalledTimes(1);
  });

  it('clears the timer when the session closes (no auto-close fires)', async () => {
    const { service, sessionsService } = setup({
      session: { status: 'ACTIVE', maxSessionDurationSeconds: 120, firstAgentMessageAt: null },
    });

    await service.onAgentMessage({ sessionId: 's1' });
    service.onSessionClosed({ sessionId: 's1' });

    jest.advanceTimersByTime(200_000);
    expect(sessionsService.beginGracefulClose).not.toHaveBeenCalled();
  });

  it('reconciles active sessions on startup from the persisted anchor', async () => {
    const anchor = new Date('2026-06-11T11:58:00.000Z'); // 120s before NOW
    const { service, sessionsService } = setup({
      activeSessions: [{ id: 's1', maxSessionDurationSeconds: 180, firstAgentMessageAt: anchor }],
    });

    await service.onModuleInit();

    // 180s cap, 120s already elapsed → 60s remaining.
    jest.advanceTimersByTime(59_000);
    expect(sessionsService.beginGracefulClose).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1_000);
    expect(sessionsService.beginGracefulClose).toHaveBeenCalledWith('s1', 'session_end');
  });

  it('self-heals: recovers the cap anchor from the message log when the event was missed', async () => {
    // Session has a cap but NO firstAgentMessageAt — i.e. the `session.agent-message`
    // event never fired (the exact failure that once disabled auto-end). The sweep
    // must recover the anchor from the persisted agent message and still close.
    const anchor = new Date('2026-06-11T11:57:00.000Z'); // 180s before NOW
    const { service, prisma, sessionsService } = setup({
      activeSessions: [{ id: 's1', maxSessionDurationSeconds: 120, firstAgentMessageAt: null }],
      firstAgentMessage: { timestamp: anchor },
    });

    await service.onModuleInit();

    // Anchor recovered from the message log and persisted.
    expect(prisma.message.findFirst).toHaveBeenCalled();
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', firstAgentMessageAt: null },
      data: { firstAgentMessageAt: anchor },
    });
    // 120s cap, 180s already elapsed → fires immediately despite the missed event.
    await jest.advanceTimersByTimeAsync(0);
    expect(sessionsService.beginGracefulClose).toHaveBeenCalledWith('s1', 'session_end');

    service.onModuleDestroy();
  });

  it('self-heals a session stranded in CLOSING (force-close timer lost to a restart)', async () => {
    // CLOSING since long ago: anchor 5 min before NOW, cap 60s → expected closed by
    // anchor+60s+120s margin = ~3 min ago. The sweep must finalize it.
    const anchor = new Date(NOW.getTime() - 5 * 60_000);
    const { service, sessionsService } = setup({
      activeSessions: [
        { id: 's1', status: 'CLOSING', maxSessionDurationSeconds: 60, firstAgentMessageAt: anchor },
      ],
    });

    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);

    expect(sessionsService.close).toHaveBeenCalledWith('s1');
    service.onModuleDestroy();
  });

  it('does NOT finalize a session that recently entered CLOSING (still wrapping up)', async () => {
    // Cap fired moments ago — well within the grace window. Must be left alone.
    const anchor = new Date(NOW.getTime() - 61_000); // cap 60s → 1s past the cap only
    const { service, sessionsService } = setup({
      activeSessions: [
        { id: 's1', status: 'CLOSING', maxSessionDurationSeconds: 60, firstAgentMessageAt: anchor },
      ],
    });

    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);

    expect(sessionsService.close).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('re-arms a live session when its cap changes, clearing the stale timer', async () => {
    // A mid-session re-invite changes the cap and re-anchors to now. onCapChanged must
    // drop the old timer and arm the NEW budget — otherwise the stale timer fires on
    // the old schedule (and the in-memory guard would block a plain re-arm).
    const { service, prisma, sessionsService } = setup({
      session: { status: 'ACTIVE', maxSessionDurationSeconds: 120, firstAgentMessageAt: null },
    });

    // Initial arm via the first agent message: 120s cap from t0.
    await service.onAgentMessage({ sessionId: 's1' });
    jest.advanceTimersByTime(60_000); // 60s elapsed
    expect(sessionsService.beginGracefulClose).not.toHaveBeenCalled();

    // Cap changed to a shorter 90s, re-anchored to now (what InvitationsService persists).
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      status: 'ACTIVE',
      maxSessionDurationSeconds: 90,
      firstAgentMessageAt: new Date(),
    });
    await service.onCapChanged({ sessionId: 's1' });

    // The old 120s timer (would fire at t0+120) is gone; nothing fires before t0+60+90.
    jest.advanceTimersByTime(89_000);
    expect(sessionsService.beginGracefulClose).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1_000);
    expect(sessionsService.beginGracefulClose).toHaveBeenCalledTimes(1);
    expect(sessionsService.beginGracefulClose).toHaveBeenCalledWith('s1', 'session_end');
  });

  it('cap-changed does not arm when the agent has not spoken yet (no anchor)', async () => {
    const { service, sessionsService } = setup({
      session: { status: 'ACTIVE', maxSessionDurationSeconds: 120, firstAgentMessageAt: null },
      firstAgentMessage: null, // no recorded agent message to derive an anchor from
    });

    await service.onCapChanged({ sessionId: 's1' });

    jest.advanceTimersByTime(200_000);
    expect(sessionsService.beginGracefulClose).not.toHaveBeenCalled();
  });

  it('clear() cancels a pending cap timer', async () => {
    const { service, sessionsService } = setup({
      session: { status: 'ACTIVE', maxSessionDurationSeconds: 120, firstAgentMessageAt: null },
    });

    await service.onAgentMessage({ sessionId: 's1' });
    service.clear('s1');

    jest.advanceTimersByTime(200_000);
    expect(sessionsService.beginGracefulClose).not.toHaveBeenCalled();
  });
});
