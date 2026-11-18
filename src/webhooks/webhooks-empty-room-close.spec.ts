import { jest } from '@jest/globals';
import { WebhooksService } from './webhooks.service.js';

/**
 * When everyone has left (#162, GitHub #920): a session set to close does so
 * as before, which revokes its invitations. A session kept open stays ACTIVE
 * with its invitations valid, so the participant can come back on the same
 * link after the agent has gone (OOM-killed twice on Grace 2, 15 Nov). A
 * session already CLOSING (closed by hand, or its maximum length reached)
 * still finishes closing either way.
 */
describe('empty-room auto-close follows the session setting', () => {
  function setup(session: { status: string; closeWhenEmpty: boolean | null; projectCloses: boolean; startingAgents?: number }) {
    const prisma: any = {
      session: {
        findUnique: jest.fn(async () => ({
          id: 's1',
          status: session.status,
          hasHumanParticipant: true,
          agentInactivityTimeoutMinutes: null,
          closeWhenEmpty: session.closeWhenEmpty,
          project: { closeSessionWhenEmpty: session.projectCloses },
          room: { livekitRoomName: 'room-1' },
        })),
        update: jest.fn(async () => ({})),
      },
      agentInstance: { count: jest.fn(async () => session.startingAgents ?? 0) },
    };
    const livekit: any = { listRoomParticipants: jest.fn(async () => []) };
    const sessions: any = { close: jest.fn(async () => ({})) };
    const events: any = { emit: jest.fn() };
    const service = new WebhooksService(prisma, events, livekit, {} as any, {} as any, sessions) as any;
    service.startRecorderLeaveTimer = jest.fn();
    return { service, sessions, events, prisma };
  }

  it('closes an empty session whose project closes empty sessions', async () => {
    const { service, sessions } = setup({ status: 'ACTIVE', closeWhenEmpty: null, projectCloses: true });
    await service.handleParticipantInactivity('s1', 'participant-1');
    expect(sessions.close).toHaveBeenCalledWith('s1');
  });

  it('does not close while an agent is still starting (#188)', async () => {
    // A wake re-creating the agent's pod isn't in the room yet. Closing now
    // stopped the agent before its pod existed, and the pod ran on for weeks.
    const { service, sessions } = setup({ status: 'ACTIVE', closeWhenEmpty: null, projectCloses: true, startingAgents: 1 });
    await service.handleParticipantInactivity('s1', 'participant-1');
    expect(sessions.close).not.toHaveBeenCalled();
  });

  it('keeps an empty session open when its project keeps sessions open', async () => {
    const { service, sessions, events } = setup({ status: 'ACTIVE', closeWhenEmpty: null, projectCloses: false });
    await service.handleParticipantInactivity('s1', 'participant-1');
    expect(sessions.close).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith('session.kept_open', expect.objectContaining({ sessionId: 's1' }));
  });

  it('marks a kept-open session so the organiser sees it, and clears the mark when the participant is back', async () => {
    const { service, prisma } = setup({ status: 'ACTIVE', closeWhenEmpty: null, projectCloses: false });
    await service.handleParticipantInactivity('s1', 'participant-1');
    expect(prisma.session.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { keptOpenAt: expect.any(Date) } });

    prisma.session.findUnique = jest.fn(async () => ({
      id: 's1', status: 'ACTIVE', keptOpenAt: new Date(), recorderShouldJoin: true,
      hasHumanParticipant: true, agentSpawnMode: 'immediate', agents: [],
    }));
    prisma.session.update.mockClear();
    await service.handleParticipantActivity('s1', 'participant-1');
    expect(prisma.session.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { keptOpenAt: null } });
  });

  it('lets the session override its project either way', async () => {
    const keep = setup({ status: 'ACTIVE', closeWhenEmpty: false, projectCloses: true });
    await keep.service.handleParticipantInactivity('s1', 'agent-a1');
    expect(keep.sessions.close).not.toHaveBeenCalled();

    const close = setup({ status: 'ACTIVE', closeWhenEmpty: true, projectCloses: false });
    await close.service.handleParticipantInactivity('s1', 'agent-a1');
    expect(close.sessions.close).toHaveBeenCalledWith('s1');
  });

  it.each([true, false])('a CLOSING session still finishes closing when its last agent leaves (closeWhenEmpty=%s)', async (closeWhenEmpty) => {
    const { service, sessions } = setup({ status: 'CLOSING', closeWhenEmpty, projectCloses: closeWhenEmpty });
    await service.finalizeClosingSessionOnAgentLeave('s1', 'agent-a1', 'room-1');
    expect(sessions.close).toHaveBeenCalledWith('s1');
  });
});
