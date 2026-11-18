import { jest } from '@jest/globals';
import { WebhooksService } from './webhooks.service.js';

/**
 * A closed session that somebody rejoins opens again (Grace 3, 16 Nov). The
 * invitations its automatic close revoked must work again, or the participant
 * is left with a dead link in a live session (#170, GitHub 930).
 */
describe('rejoining a closed session gives its invitations back', () => {
  function setup(status: string) {
    const prisma: any = {
      session: {
        findUnique: jest.fn(async () => ({
          id: 's1', status, closedAt: status === 'CLOSED' ? new Date() : null,
          keptOpenAt: null, recorderShouldJoin: true, hasHumanParticipant: true, agents: [],
        })),
        update: jest.fn(async () => ({})),
      },
    };
    const sessions: any = { restoreAutoRevokedInvitations: jest.fn(async () => 1) };
    const service = new WebhooksService(prisma, { emit: jest.fn() } as any, {} as any, {} as any, {} as any, sessions) as any;
    // Past the reopen the agent is spawned or resumed: not this test's business.
    service.spawnOrResumeAgent = jest.fn(async () => undefined);
    service.resumePausedAgent = jest.fn(async () => undefined);
    return { service, sessions, prisma };
  }

  it('a participant rejoining a CLOSED session reopens it and restores its invitations', async () => {
    const { service, sessions, prisma } = setup('CLOSED');
    await service.handleParticipantActivity('s1', 'participant-123-abc');
    expect(prisma.session.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'ACTIVE', closedAt: null } }));
    expect(sessions.restoreAutoRevokedInvitations).toHaveBeenCalledWith('s1');
  });

  it('an ACTIVE session has nothing to give back', async () => {
    const { service, sessions } = setup('ACTIVE');
    await service.handleParticipantActivity('s1', 'participant-123-abc');
    expect(sessions.restoreAutoRevokedInvitations).not.toHaveBeenCalled();
  });
});
