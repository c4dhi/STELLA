import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PersonasService } from './personas.service';

type PersonaRow = {
  id: string;
  userId: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  systemPrompt: string;
  voice: string | null;
  language: string | null;
  isSystemDefault: boolean;
};

const MINE: PersonaRow = {
  id: 'persona-1',
  userId: 'user-1',
  name: 'Grace — clinical',
  description: null,
  icon: '🩺',
  systemPrompt: 'You are Grace.',
  voice: 'grace',
  language: null,
  isSystemDefault: false,
};

const THEIRS: PersonaRow = { ...MINE, id: 'persona-2', userId: 'user-2' };

const DEFAULT_ROW: PersonaRow = {
  ...MINE,
  id: 'persona-default',
  userId: null,
  name: 'STELLA (default)',
  voice: null,
  isSystemDefault: true,
};

function createService(rows: PersonaRow[]) {
  const prisma = {
    persona: {
      findUnique: jest.fn(
        async ({ where: { id } }: any) => rows.find((r) => r.id === id) ?? null,
      ),
      findFirst: jest.fn(
        async () => rows.find((r) => r.isSystemDefault) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => ({ id: 'new', ...data })),
      update: jest.fn(async ({ data }: any) => ({ ...rows[0], ...data })),
      delete: jest.fn(async () => undefined),
    },
  } as unknown as PrismaService;
  return new PersonasService(prisma);
}

describe('PersonasService.resolveForDeploy', () => {
  it('snapshots the chosen persona by value, not by reference', async () => {
    // Deploy-time snapshot is what stops a later edit from restyling a running or
    // resuming session — the same rule pipeline_config follows on restart.
    const resolved = await createService([MINE, DEFAULT_ROW]).resolveForDeploy(
      'persona-1',
      'user-1',
    );

    expect(resolved).toMatchObject({
      id: 'persona-1',
      system_prompt: 'You are Grace.',
      voice: 'grace',
      is_system_default: false,
    });
  });

  it('falls back to the system default when no persona is named', async () => {
    const resolved = await createService([MINE, DEFAULT_ROW]).resolveForDeploy(
      undefined,
      'user-1',
    );

    expect(resolved).toMatchObject({ id: 'persona-default' });
  });

  it('flags the system default so it cannot outrank a configured persona', async () => {
    // The agent uses this to keep the Configurator's persona slot winning. Without
    // it, shipping personas would restyle every deployment already configured the
    // old way, since omitting a persona now resolves to the default rather than
    // to nothing.
    const resolved = await createService([DEFAULT_ROW]).resolveForDeploy(
      undefined,
      'user-1',
    );

    expect(resolved).toMatchObject({ is_system_default: true });
  });

  it('deploys without a persona rather than failing if the default row is gone', async () => {
    // Degrades to the agent's built-in identity instead of blocking a deploy.
    expect(await createService([]).resolveForDeploy(undefined, 'user-1')).toBeNull();
  });

  it("refuses another user's persona", async () => {
    await expect(
      createService([THEIRS, DEFAULT_ROW]).resolveForDeploy('persona-2', 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PersonasService system default protection', () => {
  it('is readable by any user, so it can be selected and duplicated', async () => {
    const persona = await createService([DEFAULT_ROW]).findOne(
      'persona-default',
      'somebody-else',
    );
    expect(persona.isSystemDefault).toBe(true);
  });

  it('cannot be edited', async () => {
    await expect(
      createService([DEFAULT_ROW]).update('persona-default', 'user-1', {
        name: 'hijacked',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cannot be deleted — the resolution chain terminates there', async () => {
    await expect(
      createService([DEFAULT_ROW]).remove('persona-default', 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('duplicates into an ordinary persona owned by the copier', async () => {
    const copy: any = await createService([DEFAULT_ROW]).duplicate(
      'persona-default',
      'user-1',
    );
    expect(copy.isSystemDefault).toBe(false);
    expect(copy.userId).toBe('user-1');
  });
});

describe('PersonasService variables', () => {
  const WITH_VARS: PersonaRow & { variables?: Record<string, string> } = {
    ...MINE,
    variables: { role: 'wellbeing companion' },
  };

  it('snapshots variables so {{persona.*}} resolves against deploy-time values', async () => {
    const resolved = await createService([WITH_VARS as PersonaRow]).resolveForDeploy(
      'persona-1',
      'user-1',
    );
    expect(resolved).toMatchObject({ variables: { role: 'wellbeing companion' } });
  });

  it('always sends a variables map, so the agent never has to guard for null', async () => {
    const resolved = await createService([MINE]).resolveForDeploy('persona-1', 'user-1');
    expect(resolved).toMatchObject({ variables: {} });
  });

  it('carries variables through a duplicate', async () => {
    // A copy that silently lost its variables would break every prompt that
    // referenced them, with no error anywhere.
    const copy: any = await createService([WITH_VARS as PersonaRow]).duplicate(
      'persona-1',
      'user-1',
    );
    expect(copy.variables).toEqual({ role: 'wellbeing companion' });
  });
});
