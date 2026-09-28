import { PrismaService } from '../prisma/prisma.service';
import { PersonasService } from './personas.service';

const persona = (over: Record<string, unknown>) => ({
  id: 'p',
  userId: 'user-1',
  name: 'n',
  description: null,
  icon: null,
  systemPrompt: 'prompt',
  voice: null,
  language: null,
  variables: null,
  isSystemDefault: false,
  ...over,
});

const ROWS = [
  persona({ id: 'grace', name: 'Grace', systemPrompt: 'You are Grace.' }),
  persona({ id: 'other', userId: 'user-2', systemPrompt: 'You are theirs.' }),
  persona({
    id: 'default',
    userId: null,
    name: 'STELLA',
    systemPrompt: 'You are STELLA.',
    isSystemDefault: true,
  }),
];

const PLANS = [
  { id: 'plan-linked', userId: 'user-1', defaultPersonaId: 'grace' },
  { id: 'plan-unlinked', userId: 'user-1', defaultPersonaId: null },
  { id: 'plan-foreign', userId: 'user-2', defaultPersonaId: 'other' },
];

function service() {
  const prisma = {
    persona: {
      findUnique: jest.fn(
        async ({ where: { id } }: any) => ROWS.find((r) => r.id === id) ?? null,
      ),
      findFirst: jest.fn(async () => ROWS.find((r) => r.isSystemDefault)),
    },
    planTemplate: {
      findUnique: jest.fn(
        async ({ where: { id } }: any) => PLANS.find((p) => p.id === id) ?? null,
      ),
    },
  } as unknown as PrismaService;
  return new PersonasService(prisma);
}

describe('PersonasService.resolveForDeployConfig', () => {
  it('uses the persona the plan was linked to when the deploy names none', async () => {
    // The whole point of #550: an existing plan must not become STELLA on upgrade.
    const resolved = await service().resolveForDeployConfig(
      { plan: { id: 'plan-linked' } },
      undefined,
      'user-1',
    );
    expect(resolved).toMatchObject({ id: 'grace', system_prompt: 'You are Grace.' });
  });

  it('reads the plan id from plan_id too', async () => {
    const resolved = await service().resolveForDeployConfig(
      { plan_id: 'plan-linked' },
      undefined,
      'user-1',
    );
    expect(resolved).toMatchObject({ id: 'grace' });
  });

  it('lets an explicit persona choice beat the plan link', async () => {
    const resolved = await service().resolveForDeployConfig(
      { plan: { id: 'plan-linked' } },
      'default',
      'user-1',
    );
    expect(resolved).toMatchObject({ id: 'default' });
  });

  it('falls back to the system default for an unlinked plan with no old prompt', async () => {
    const resolved = await service().resolveForDeployConfig(
      { plan: { id: 'plan-unlinked' } },
      undefined,
      'user-1',
    );
    expect(resolved).toMatchObject({ id: 'default', is_system_default: true });
  });

  it('ignores a link on a plan the caller does not own', async () => {
    const resolved = await service().resolveForDeployConfig(
      { plan: { id: 'plan-foreign' } },
      undefined,
      'user-1',
    );
    expect(resolved).toMatchObject({ id: 'default' });
  });

  it('returns null, not the default, when the plan still carries its own system_prompt', async () => {
    // A config saved before the upgrade (a paused session waking up): the default
    // persona would win over the plan's identity, so leave it to the agent.
    const resolved = await service().resolveForDeployConfig(
      { plan: { system_prompt: 'You are Grace, a coach.' } },
      undefined,
      'user-1',
    );
    expect(resolved).toBeNull();
  });

  it('still prefers a linked persona over the old prompt', async () => {
    const resolved = await service().resolveForDeployConfig(
      { plan: { id: 'plan-linked', system_prompt: 'old' } },
      undefined,
      'user-1',
    );
    expect(resolved).toMatchObject({ id: 'grace' });
  });

  it('gives a config with no plan at all the system default', async () => {
    const resolved = await service().resolveForDeployConfig({}, undefined, 'user-1');
    expect(resolved).toMatchObject({ id: 'default' });
  });
});
