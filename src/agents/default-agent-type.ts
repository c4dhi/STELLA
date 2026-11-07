/**
 * The agent type a deployment gets when it names none. This is the only place
 * that knows a slug: every caller (deploy, restart, wake, public projects, the
 * pod builder) asks here, so changing the default is one environment variable.
 */
export const FALLBACK_AGENT_TYPE = 'stella-v2-agent'

export function defaultAgentType(): string {
  return process.env.DEFAULT_AGENT_TYPE?.trim() || FALLBACK_AGENT_TYPE
}

/** The given slug, or the default when it is empty. */
export function agentTypeOrDefault(slug: string | null | undefined): string {
  return slug || defaultAgentType()
}
