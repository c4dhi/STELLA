import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { AgentsService } from './agents.service.js';

const SESSIONS: Record<string, { id: string; status: string }> = {
  open: { id: 'open', status: 'ACTIVE' },
  closing: { id: 'closing', status: 'CLOSING' },
  closed: { id: 'closed', status: 'CLOSED' },
};

// Only the session lookup matters: the guard runs before anything is deployed.
function service() {
  const s = Object.create(AgentsService.prototype);
  const k8s = { deletePod: jest.fn(), deleteSecret: jest.fn() };
  s.prisma = {
    session: {
      findUnique: jest.fn(async ({ where: { id } }: any) => ({
        ...SESSIONS[id],
        room: { id: 'r1' },
        project: { id: 'p1' },
      })),
    },
    agentInstance: {
      findUnique: jest.fn(async ({ where: { id } }: any) => ({
        id,
        sessionId: id,
        podName: 'pod',
        session: { ...SESSIONS[id], room: { id: 'r1' }, project: { id: 'p1' } },
      })),
      update: jest.fn(),
    },
  };
  s.k8s = k8s;
  s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { s, k8s };
}

describe('AgentsService in a closed session', () => {
  it.each(['closing', 'closed'])('does not deploy into a %s session', async (id) => {
    const { s } = service();
    await expect(s.create(id, { name: 'Grace' }, 'user-1')).rejects.toThrow(
      BadRequestException,
    );
    await expect(s.create(id, { name: 'Grace' }, 'user-1')).rejects.toThrow(
      /agents can only start in an active session/,
    );
  });

  it.each(['closing', 'closed'])(
    'does not restart an agent of a %s session, and leaves its pod alone',
    async (id) => {
      const { s, k8s } = service();
      await expect(s.restartAgent(id)).rejects.toThrow(BadRequestException);
      expect(k8s.deletePod).not.toHaveBeenCalled();
      expect(s.prisma.agentInstance.update).not.toHaveBeenCalled();
    },
  );
});
