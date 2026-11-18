import { InvitationStatus } from '@prisma/client';

/**
 * Invitations an automatic session close cancels, and gives back when the
 * session reopens (#170, GitHub 930).
 *
 * A session closes on its own (the room went empty, the plan ended, the time
 * ran out), and then reopens when somebody rejoins. The invitations it
 * cancelled were cancelled by the close, not by anybody, so they come back.
 * Each one remembers its status from before (`statusBeforeAutoRevoke`); one
 * the organiser cancelled by hand, or that a manual "Close session" cancelled,
 * has no such status and stays cancelled.
 */

/** The statuses a close cancels. */
export const REVOKED_BY_CLOSE: readonly InvitationStatus[] = [InvitationStatus.PENDING, InvitationStatus.ACCEPTED];

/** How a session was closed: by somebody, or by the platform on its own. */
export type CloseCause = 'manual' | 'automatic';

/** Whether a close of this cause gives its cancelled invitations back on reopen. */
export function restoresOnReopen(cause: CloseCause): boolean {
  return cause === 'automatic';
}

/**
 * The status an auto-revoked invitation goes back to on reopen: its old one,
 * or EXPIRED if its own expiry passed while the session was closed.
 */
export function restoredStatus(
  before: InvitationStatus,
  expiresAt: Date | null,
  now: Date,
): InvitationStatus {
  if (expiresAt && now > expiresAt) return InvitationStatus.EXPIRED;
  return before;
}
