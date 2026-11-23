import { jest } from '@jest/globals';
// Same module cuts as sessions.service.spec.ts. The token itself is covered
// for real in agent-history-token.spec.ts; here the tokens are real too, and
// the test is about what validateAgentToken does with an expired one (#165).

jest.mock('../agents/agents.service', () => ({ AgentsService: class {} }));
jest.mock('../livekit/livekit.service', () => ({ LiveKitService: class {} }));
jest.mock('../message-recorder/room-monitor.service', () => ({ RoomMonitorService: class {} }));
import { UnauthorizedException } from '@nestjs/common';
import { AccessToken } from 'livekit-server-sdk';
import { SessionsService } from './sessions.service.js';

const KEY = 'key';
const SECRET = 'a-secret-that-is-long-enough-for-hs256-signing';
let token = '';
// ttl -120 s is past the verifier's clock tolerance.
async function sign(identity: string, ttlSeconds: number, secret = SECRET) {
  const at = new AccessToken(KEY, secret, { identity, ttl: ttlSeconds });
  at.addGrant({ roomJoin: true, room: 'room-1' });
  token = await at.toJwt();
}

function setup(opts: { agentStatus: string | null; sessionStatus?: string }) {
  const prisma: any = {
    session: {
      findUnique: jest.fn(async () => ({ id: 's1', status: opts.sessionStatus ?? 'ACTIVE', room: { livekitRoomName: 'room-1' } })),
    },
    agentInstance: {
      findFirst: jest.fn(async () => (opts.agentStatus ? { status: opts.agentStatus } : null)),
    },
  };
  const livekit: any = { getApiKey: () => KEY, getApiSecret: () => SECRET };
  const service = new SessionsService(prisma, livekit, {} as any, {} as any, {} as any, { emit: jest.fn() } as any);
  return { service, prisma };
}

describe('SessionsService.validateAgentToken (#165)', () => {

  it('accepts a token within its lifetime without looking up the agent', async () => {
    await sign('agent-inst1', 3600);
    const { service, prisma } = setup({ agentStatus: null });
    await expect(service.validateAgentToken(token, 's1')).resolves.toEqual({ identity: 'agent-inst1', room: 'room-1' });
    expect(prisma.agentInstance.findFirst).not.toHaveBeenCalled();
  });

  it('accepts an expired token while its agent is running in this session', async () => {
    await sign('agent-inst1', -120);
    const { service, prisma } = setup({ agentStatus: 'RUNNING' });
    await expect(service.validateAgentToken(token, 's1')).resolves.toEqual({ identity: 'agent-inst1', room: 'room-1' });
    expect(prisma.agentInstance.findFirst).toHaveBeenCalledWith({ where: { id: 'inst1', sessionId: 's1' }, select: { status: true } });
  });

  it('refuses an expired token once its agent has stopped', async () => {
    await sign('agent-inst1', -120);
    const { service } = setup({ agentStatus: 'STOPPED' });
    await expect(service.validateAgentToken(token, 's1')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses an expired token for an agent that is not in this session', async () => {
    await sign('agent-other', -120);
    const { service } = setup({ agentStatus: null });
    await expect(service.validateAgentToken(token, 's1')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a token that is not ours', async () => {
    await sign('agent-inst1', 3600, 'another-secret-that-is-long-enough-for-hs256-sig');
    const { service } = setup({ agentStatus: 'RUNNING' });
    await expect(service.validateAgentToken(token, 's1')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
