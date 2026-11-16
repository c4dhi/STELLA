/**
 * Whether an ACTIVE session closes once everyone has left (#162). A session's
 * own setting wins; null means it follows its project. Closing revokes the
 * session's invitations; keeping it open (the default) lets the participant
 * come back on the same link, and the organiser can restart the agent.
 */
export function closesWhenEmpty(
  session: { closeWhenEmpty: boolean | null },
  project: { closeSessionWhenEmpty: boolean } | null,
): boolean {
  return session.closeWhenEmpty ?? project?.closeSessionWhenEmpty ?? false;
}
