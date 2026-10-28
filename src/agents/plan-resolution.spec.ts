import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { AgentsService } from './agents.service.js';

const TEMPLATES = [
  {
    id: 'plan-1',
    userId: 'user-1',
    name: 'Morning check-in',
    description: null,
    content: { states: [{ id: 'greet' }] },
  },
  {
    id: 'plan-2',
    userId: 'user-2',
    name: 'Not yours',
    description: 'x',
    content: {},
  },
];

// applyScopedConfiguration is private; the plan part only needs prisma and personas.
function applyScoped(
  dto: Record<string, unknown>,
  agentConfig: Record<string, unknown>,
) {
  const service = Object.create(AgentsService.prototype);
  service.prisma = {
    planTemplate: {
      findUnique: jest.fn(
        async ({ where: { id } }: any) =>
          TEMPLATES.find((t) => t.id === id) ?? null,
      ),
    },
  };
  service.personasService = {
    resolveForDeployConfig: jest.fn(async () => null),
  };
  service.logger = { warn: jest.fn() };
  return service.applyScopedConfiguration(dto, 'user-1', null, agentConfig);
}

describe('AgentsService plan resolution', () => {
  it('turns planId into the plan the deploy modal would send', async () => {
    const agentConfig: Record<string, unknown> = {
      plan: { id: 'client-supplied' },
    };
    await applyScoped({ name: 'A', planId: 'plan-1' }, agentConfig);
    expect(agentConfig.plan).toEqual({
      id: 'plan-1',
      title: 'Morning check-in',
      description: '',
      states: [{ id: 'greet' }],
    });
  });

  it("refuses someone else's plan by id", async () => {
    await expect(
      applyScoped({ name: 'A', planId: 'plan-2' }, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('leaves a client-supplied plan alone when no planId is given', async () => {
    const agentConfig: Record<string, unknown> = { plan: { id: 'inline' } };
    await applyScoped({ name: 'A' }, agentConfig);
    expect(agentConfig.plan).toEqual({ id: 'inline' });
  });

  it('keeps companion activities titled by the template name', async () => {
    const agentConfig: Record<string, unknown> = {};
    await applyScoped(
      {
        name: 'A',
        mode: 'companion',
        availablePlanIds: ['plan-1'],
        planId: 'plan-1',
      },
      agentConfig,
    );
    expect(agentConfig.plan).toBeUndefined();
    expect(agentConfig.available_plans).toEqual([
      {
        id: 'plan-1',
        title: 'Morning check-in',
        description: '',
        plan: {
          id: 'plan-1',
          title: 'Morning check-in',
          description: '',
          states: [{ id: 'greet' }],
        },
      },
    ]);
  });
});
