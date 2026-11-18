import { AccessToken } from 'livekit-server-sdk';
import { AgentStatus, SessionStatus } from '@prisma/client';
import { agentMayReadHistory, readAgentToken } from './agent-history-token.js';

const KEY = 'APIkey123';
const SECRET = 'a-secret-that-is-long-enough-for-hs256-signing';

async function sign(opts: { ttlSeconds: number; secret?: string; identity?: string; room?: string }) {
  const at = new AccessToken(KEY, opts.secret ?? SECRET, {
    identity: opts.identity ?? 'agent-inst1',
    ttl: opts.ttlSeconds,
  });
  at.addGrant({ roomJoin: true, room: opts.room ?? 'room-1' });
  return at.toJwt();
}

describe('readAgentToken', () => {
  it('reads a valid token as not expired', async () => {
    const read = await readAgentToken(await sign({ ttlSeconds: 3600 }), KEY, SECRET);
    expect(read).toEqual({ identity: 'agent-inst1', room: 'room-1', expired: false });
  });

  it('reads an expired but genuine token as expired, with its claims', async () => {
    // -120 s: past the verifier's clock tolerance.
    const read = await readAgentToken(await sign({ ttlSeconds: -120 }), KEY, SECRET);
    expect(read).toEqual({ identity: 'agent-inst1', room: 'room-1', expired: true });
  });

  it('refuses a token signed with another secret, expired or not', async () => {
    const other = 'another-secret-that-is-long-enough-for-hs256-sig';
    await expect(readAgentToken(await sign({ ttlSeconds: 3600, secret: other }), KEY, SECRET)).rejects.toThrow();
    await expect(readAgentToken(await sign({ ttlSeconds: -120, secret: other }), KEY, SECRET)).rejects.toThrow();
  });

  it('refuses garbage', async () => {
    await expect(readAgentToken('not-a-jwt', KEY, SECRET)).rejects.toThrow();
  });
});

describe('agentMayReadHistory', () => {
  const live = { agentStatus: AgentStatus.RUNNING, sessionStatus: SessionStatus.ACTIVE };

  it('a token within its lifetime is enough on its own', () => {
    expect(agentMayReadHistory({ expired: false, agent: null })).toBe(true);
  });

  it('an expired token is accepted while the agent that holds it runs', () => {
    expect(agentMayReadHistory({ expired: true, agent: live })).toBe(true);
    expect(agentMayReadHistory({ expired: true, agent: { ...live, agentStatus: AgentStatus.STARTING } })).toBe(true);
  });

  it('an expired token is refused once its agent has stopped or is gone', () => {
    expect(agentMayReadHistory({ expired: true, agent: { ...live, agentStatus: AgentStatus.STOPPED } })).toBe(false);
    expect(agentMayReadHistory({ expired: true, agent: { ...live, agentStatus: AgentStatus.FAILED } })).toBe(false);
    expect(agentMayReadHistory({ expired: true, agent: null })).toBe(false);
  });

  it('an expired token is refused once the session is closed', () => {
    expect(agentMayReadHistory({ expired: true, agent: { ...live, sessionStatus: SessionStatus.CLOSED } })).toBe(false);
  });
});
