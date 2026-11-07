import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { AgentValidationStatus } from '@prisma/client';
import { AgentsService } from './agents.service.js';

// A restart (and a wake, which restarts) checks the agent type before it takes
// the running pod down, so a refused restart leaves the agent as it was.
function service(agentType: Record<string, unknown>) {
  const s = Object.create(AgentsService.prototype);
  const k8s = { deletePod: jest.fn(), deleteSecret: jest.fn(), createAgentPod: jest.fn() };
  s.prisma = {
    agentInstance: {
      findUnique: jest.fn(async () => ({
        id: 'a1',
        sessionId: 's1',
        name: 'echo',
        agentType: 'echo-agent',
        podName: 'pod',
        secretName: 'secret',
        agentConfig: {},
        session: {
          id: 's1',
          status: 'ACTIVE',
          projectId: 'p1',
          room: { livekitRoomName: 'room', serverUrl: 'ws://lk' },
          project: { id: 'p1' },
        },
      })),
      update: jest.fn(),
    },
    projectMembership: { findFirst: jest.fn(async () => ({ userId: 'u1' })) },
    agentType: { findUnique: jest.fn(async () => agentType) },
  };
  s.k8s = k8s;
  s.configService = { get: jest.fn((key: string, fallback?: string) => (key.startsWith('LIVEKIT_API') ? 'x' : fallback)) };
  s.platformSettings = { isAgentReviewRequired: jest.fn(async () => true) };
  s.agentServerService = { registerPendingSession: jest.fn() };
  s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { s, k8s };
}

describe('AgentsService.restartAgent when the agent type is refused', () => {
  it('leaves the running pod alone when the agent type was rejected', async () => {
    const { s, k8s } = service({
      slug: 'echo-agent',
      isBuiltIn: false,
      validationStatus: AgentValidationStatus.REJECTED,
      imageUrl: 'echo-agent:1',
      sdkVersion: '0.9.0',
    });
    await expect(s.restartAgent('a1')).rejects.toThrow(BadRequestException);
    await expect(s.restartAgent('a1')).rejects.toThrow(/rejected in review/);
    expect(k8s.deletePod).not.toHaveBeenCalled();
    expect(k8s.deleteSecret).not.toHaveBeenCalled();
    expect(s.prisma.agentInstance.update).not.toHaveBeenCalled();
    expect(s.agentServerService.registerPendingSession).not.toHaveBeenCalled();
  });
});
