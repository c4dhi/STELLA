import { TokenVerifier } from 'livekit-server-sdk';
import { AgentStatus, SessionStatus } from '@prisma/client';

/**
 * How an agent proves which session's history it may read (#165, GitHub 923).
 *
 * The agent sends its LiveKit room token. That token expires (an hour for a
 * built-in agent that signs its own, a day for an uploaded agent the backend
 * signs for), but an agent runs for as long as its session does, which can be
 * weeks. An uploaded agent cannot sign a new one. So the token's expiry is not
 * what ends its access: the agent stopping is. A genuine token that has expired
 * still works while the agent that holds it is starting or running and its
 * session is not closed, the same lifetime the connector token has.
 */

/** Agent states in which an expired token still reads history, as for connectors. */
const LIVE_AGENT: ReadonlySet<AgentStatus> = new Set([AgentStatus.STARTING, AgentStatus.RUNNING]);

export interface AgentTokenClaims {
  identity: string;
  room: string;
  /** Signed by us, but past its `exp`. */
  expired: boolean;
}

/**
 * Check the token's signature and issuer, and read who it is for. Throws for a
 * token we did not sign. A token we signed that has expired is returned with
 * `expired: true` rather than refused: whether that still counts is
 * {@link agentMayReadHistory}'s call.
 */
export async function readAgentToken(token: string, apiKey: string, apiSecret: string): Promise<AgentTokenClaims> {
  let claims: Record<string, any>;
  let expired = false;
  try {
    claims = await new TokenVerifier(apiKey, apiSecret).verify(token);
  } catch (error: any) {
    // jose checks the signature and the issuer before the expiry, so an
    // ERR_JWT_EXPIRED carries claims that are known to be ours.
    if (error?.code !== 'ERR_JWT_EXPIRED' || !error.payload) throw error;
    claims = error.payload;
    expired = true;
  }
  return { identity: claims.sub ?? '', room: claims.video?.room ?? '', expired };
}

export interface HistoryAccessInput {
  expired: boolean;
  /** The agent the token's identity names, if it exists in this session. */
  agent: { agentStatus: AgentStatus; sessionStatus: SessionStatus } | null;
}

/** Whether a token that passed {@link readAgentToken} may read the session's history. */
export function agentMayReadHistory({ expired, agent }: HistoryAccessInput): boolean {
  if (!expired) return true;
  return !!agent && LIVE_AGENT.has(agent.agentStatus) && agent.sessionStatus !== SessionStatus.CLOSED;
}
