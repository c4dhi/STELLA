import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/** Env var the agent pod reads its connector token from. */
export const CONNECTOR_TOKEN_ENV = 'STELLA_CONNECTOR_TOKEN';
/** gRPC metadata key the SDK sends it in. */
export const CONNECTOR_TOKEN_METADATA = 'x-stella-connector-token';

/**
 * A fresh per-pod secret. The pod gets the plaintext (in its k8s Secret); the
 * database keeps only the hash, like personal access tokens.
 */
export function issueAgentConnectorToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashAgentConnectorToken(token) };
}

export function hashAgentConnectorToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function agentConnectorTokenMatches(token: string, storedHash: string | null | undefined): boolean {
  if (!token || !storedHash) return false;
  const a = Buffer.from(hashAgentConnectorToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
