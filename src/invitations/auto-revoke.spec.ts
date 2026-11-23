import { InvitationStatus } from '@prisma/client';
import { REVOKED_BY_CLOSE, restoredStatus, restoresOnReopen } from './auto-revoke.js';

describe('auto-revoke (#170)', () => {
  const now = new Date('2026-11-18T19:00:00Z');

  it('only an automatic close gives invitations back', () => {
    expect(restoresOnReopen('automatic')).toBe(true);
    expect(restoresOnReopen('manual')).toBe(false);
  });

  it('a close cancels pending and accepted invitations only', () => {
    expect([...REVOKED_BY_CLOSE].sort()).toEqual([InvitationStatus.ACCEPTED, InvitationStatus.PENDING]);
  });

  it('an invitation goes back to its status from before the close', () => {
    expect(restoredStatus(InvitationStatus.PENDING, null, now)).toBe(InvitationStatus.PENDING);
    expect(restoredStatus(InvitationStatus.ACCEPTED, new Date('2026-11-19T00:00:00Z'), now)).toBe(InvitationStatus.ACCEPTED);
  });

  it('one whose expiry passed while the session was closed comes back expired', () => {
    expect(restoredStatus(InvitationStatus.PENDING, new Date('2026-11-18T18:00:00Z'), now)).toBe(InvitationStatus.EXPIRED);
    expect(restoredStatus(InvitationStatus.ACCEPTED, new Date('2026-11-18T18:00:00Z'), now)).toBe(InvitationStatus.EXPIRED);
  });
});
