import { jest } from '@jest/globals';
// SessionsService and AgentsService pull in LiveKitService / AuthService /
// KubernetesService etc., whose transitive deps are ESM-only (livekit-server-sdk)
// and trip ts-jest (see invitations.service.spec.ts). runJoinProcess only needs
// stub instances of each, so cut those module subtrees at the boundary.
jest.mock('../sessions/sessions.service.js', () => ({ SessionsService: class {} }));
jest.mock('../agents/agents.service.js', () => ({ AgentsService: class {} }));

import { PublicProjectsService } from './public-projects.service.js';

function setup(agentSpawnMode: 'on_demand' | 'immediate') {
  const prisma: any = {
    session: {
      findUnique: jest.fn(async () => ({ agentSpawnMode })),
    },
  };
  const sessionsService: any = {};
  const agentsService: any = {
    create: jest.fn(async () => ({ id: 'agent1' })),
  };
  const invitationsService: any = {
    create: jest.fn(async () => ({ invitation: { id: 'inv1', token: 'tok' } })),
  };
  const service = new PublicProjectsService(
    prisma,
    sessionsService,
    agentsService,
    invitationsService,
  );
  return { service, prisma, agentsService, invitationsService };
}

const project: any = {
  publicVisualizerType: null,
  publicVisualizerLocked: false,
  publicMaxSessionDurationSeconds: 1800,
  publicAgentConfig: null,
  publicAgentType: { slug: 'stella-v2-agent', name: 'Agent', icon: '🤖' },
};

describe('PublicProjectsService.runJoinProcess — session-duration cap on the non-blocking join (#1054)', () => {
  it('on_demand: passes the project cap to the invitation', async () => {
    const { service, invitationsService } = setup('on_demand');

    await (service as any).runJoinProcess(project, 'session1', 'owner1');

    expect(invitationsService.create).toHaveBeenCalledWith(
      'session1',
      expect.objectContaining({ maxSessionDurationSeconds: 1800 }),
    );
  });

  it('immediate (legacy): also passes the project cap to the invitation', async () => {
    const { service, invitationsService, agentsService } = setup('immediate');
    agentsService.create.mockResolvedValue({ id: 'agent1', status: 'RUNNING' });
    jest
      .spyOn(service as any, 'pollAgentReady')
      .mockResolvedValue({ success: true });

    await (service as any).runJoinProcess(project, 'session1', 'owner1');

    expect(invitationsService.create).toHaveBeenCalledWith(
      'session1',
      expect.objectContaining({ maxSessionDurationSeconds: 1800 }),
    );
  });

  it('leaves the cap undefined when the project has none set', async () => {
    const { service, invitationsService } = setup('on_demand');
    const uncapped = { ...project, publicMaxSessionDurationSeconds: null };

    await (service as any).runJoinProcess(uncapped, 'session1', 'owner1');

    expect(invitationsService.create).toHaveBeenCalledWith(
      'session1',
      expect.objectContaining({ maxSessionDurationSeconds: undefined }),
    );
  });
});
