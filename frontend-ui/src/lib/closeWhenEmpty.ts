/**
 * When everyone has left a session (#162): close it (its invitations stop
 * working) or keep it open (the participant can come back on the same link,
 * and the organiser can restart the agent). Projects keep sessions open unless
 * set otherwise; a session follows its project unless it sets its own value.
 */
import type { AgentStatus, SessionStatus } from './api-types'

export type SessionCloseChoice = 'project' | 'keep' | 'close'

/** The session's stored value (null = as the project) as a choice. */
export function sessionCloseChoice(closeWhenEmpty: boolean | null | undefined): SessionCloseChoice {
  if (closeWhenEmpty == null) return 'project'
  return closeWhenEmpty ? 'close' : 'keep'
}

/** The choices Edit Session offers, the first naming what the project does. */
export function sessionCloseChoices(projectCloses: boolean) {
  return [
    { value: 'project' as const, label: `As the project (${projectCloses ? 'close' : 'keep open'})`, closeWhenEmpty: null },
    { value: 'keep' as const, label: 'Keep open', closeWhenEmpty: false },
    { value: 'close' as const, label: 'Close', closeWhenEmpty: true },
  ]
}

/**
 * The notice on a session that was kept open after everyone left: since when,
 * and the agent Restart agent brings back (null when there is none).
 */
export function keptOpenNotice(session: {
  status: SessionStatus
  keptOpenAt?: string | null
  agents?: { id: string; status: AgentStatus }[]
}): { since: string; agentId: string | null } | null {
  if (session.status !== 'ACTIVE' || !session.keptOpenAt) return null
  return { since: session.keptOpenAt, agentId: session.agents?.[0]?.id ?? null }
}

/**
 * What the project's choice becomes when the organiser picks a project type
 * while creating it: a public project closes empty sessions (every visitor
 * starts their own, nobody comes back to it), a private one keeps them open.
 * Once the organiser has picked a choice themselves, that choice stays.
 */
export function closesOnTypeChange(
  projectType: 'private' | 'public',
  current: boolean,
  chosenByOrganiser: boolean,
): boolean {
  if (chosenByOrganiser) return current
  return projectType === 'public'
}
