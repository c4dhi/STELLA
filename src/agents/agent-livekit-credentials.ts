import { AccessToken } from 'livekit-server-sdk'

/**
 * How long an uploaded agent's LiveKit token is valid: the same as a
 * participant token. LiveKit checks it only when the agent first joins; once
 * connected, LiveKit refreshes the agent's credentials itself. The chat-history
 * API keeps accepting it after it expires for as long as the agent runs
 * (agent-history-token.ts, #165), since an agent outlives any token lifetime.
 * Every restart or auto-pause wake creates a new pod (restartPolicy Never),
 * and the backend signs a new token for it.
 */
export const UPLOADED_AGENT_TOKEN_TTL = '24h'

export interface AgentLiveKitCredentialsInput {
  isBuiltIn: boolean
  apiKey: string
  apiSecret: string
  roomName: string
  identity: string
  name: string
}

export interface AgentLiveKitCredentials {
  livekitApiKey?: string
  livekitApiSecret?: string
  livekitToken?: string
}

/**
 * The LiveKit credentials an agent pod receives (issue 856).
 *
 * A built-in agent is our own reviewed code, so it keeps the platform key and
 * secret. An uploaded agent gets a token the backend signs here, scoped to its
 * session's room and its own identity, and never sees the key or secret: with
 * those it could sign itself into any room.
 */
export async function agentLiveKitCredentials(
  input: AgentLiveKitCredentialsInput,
): Promise<AgentLiveKitCredentials> {
  if (input.isBuiltIn) {
    return { livekitApiKey: input.apiKey, livekitApiSecret: input.apiSecret }
  }

  const at = new AccessToken(input.apiKey, input.apiSecret, {
    identity: input.identity,
    name: input.name,
    ttl: UPLOADED_AGENT_TOKEN_TTL,
  })
  at.addGrant({
    roomJoin: true,
    room: input.roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  })
  return { livekitToken: await at.toJwt() }
}
