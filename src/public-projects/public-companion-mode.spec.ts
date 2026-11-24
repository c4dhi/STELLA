import { jest } from '@jest/globals';
import { publicDeployMode } from './public-projects.service.js';
import { WebhooksService } from '../webhooks/webhooks.service.js';

/**
 * #207: a public project set up in companion mode spawns its agent as a
 * companion with the stored activities; plan-mode and older projects are unchanged.
 */
describe('public projects in companion mode (#207)', () => {
  it('a companion setup deploys as a companion with its activities', () => {
    expect(publicDeployMode({ mode: 'companion', availablePlanIds: ['p1', 'p2'] })).toEqual({
      mode: 'companion',
      availablePlanIds: ['p1', 'p2'],
    });
  });

  it('a companion setup with no activities picked deploys with none', () => {
    expect(publicDeployMode({ mode: 'companion' })).toEqual({ mode: 'companion', availablePlanIds: [] });
  });

  it('a plan setup, and one saved before #207, add nothing', () => {
    expect(publicDeployMode({ mode: 'plan', plan: { states: [] } })).toEqual({});
    expect(publicDeployMode({ plan: { states: [] } })).toEqual({});
    expect(publicDeployMode(null)).toEqual({});
  });

  describe('the on-demand spawn when a participant joins', () => {
    function spawn(lastAgentConfig: Record<string, unknown>) {
      const prisma: any = {
        agentInstance: { findFirst: jest.fn(async () => null) },
        projectMembership: { findFirst: jest.fn(async () => ({ userId: 'owner-1', role: 'OWNER' })) },
      };
      const agents: any = { create: jest.fn(async () => ({ id: 'a1' })) };
      const service: any = new WebhooksService(prisma, {} as any, {} as any, { decrypt: jest.fn() } as any, agents, {} as any);
      return service
        .spawnOrResumeAgent({ id: 's1', projectId: 'proj', lastAgentConfig })
        .then(() => (agents.create.mock.calls[0] as any[])[1]);
    }

    it('spawns in the stored companion mode', async () => {
      const dto = await spawn({
        name: 'Grace', agentType: 'stella-v2-agent', agentConfig: {},
        ...publicDeployMode({ mode: 'companion', availablePlanIds: ['p1'] }),
      });
      expect(dto.mode).toBe('companion');
      expect(dto.availablePlanIds).toEqual(['p1']);
    });

    it('spawns a plan-mode project as before', async () => {
      const dto = await spawn({ name: 'Agent', agentType: 'stella-v2-agent', agentConfig: { plan: { states: [] } } });
      expect(dto.mode).toBeUndefined();
      expect(dto.availablePlanIds).toBeUndefined();
      expect(dto.config).toEqual({ plan: { states: [] } });
    });
  });
});
