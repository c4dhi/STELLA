import { PrismaClient } from '@prisma/client';
import { extractPlanPersonas } from './persona-extraction';

/**
 * A small in-memory stand-in for the four tables the extraction touches, with a
 * $transaction that rolls back on throw — which is the property the script relies
 * on to be safe to re-run after a partial failure.
 */
function fakeDb(seed: {
  plans?: any[];
  projects?: any[];
  personas?: any[];
  failOnPlanId?: string;
}) {
  const state = {
    plans: (seed.plans ?? []).map((p) => ({ defaultPersonaId: null, ...p })),
    projects: seed.projects ?? [],
    personas: seed.personas ?? [],
    seq: 0,
  };

  const build = (s: typeof state) => ({
    planTemplate: {
      findMany: async () => s.plans.map((p) => ({ ...p })),
      update: async ({ where: { id }, data }: any) => {
        if (id === seed.failOnPlanId) throw new Error('boom');
        Object.assign(s.plans.find((p) => p.id === id), data);
      },
    },
    project: {
      findMany: async () => s.projects.map((p) => ({ ...p })),
      update: async ({ where: { id }, data }: any) => {
        Object.assign(s.projects.find((p) => p.id === id), data);
      },
    },
    persona: {
      findFirst: async ({ where }: any) =>
        s.personas.find(
          (p) =>
            p.userId === where.userId &&
            p.systemPrompt === where.systemPrompt &&
            (p.voice ?? null) === where.voice,
        ) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `persona-${++s.seq}`, voice: null, ...data };
        s.personas.push(row);
        return row;
      },
    },
  });

  const db: any = {
    ...build(state),
    $transaction: async (fn: any) => {
      const snapshot = JSON.parse(JSON.stringify(state));
      try {
        return await fn(db);
      } catch (e) {
        Object.assign(state, snapshot);
        throw e;
      }
    },
  };
  // build() closed over `state`, and rollback reassigns its fields in place, so
  // the delegates above keep pointing at the live arrays.
  return { db: db as unknown as PrismaClient, state };
}

const quiet = { log: () => undefined };

const plan = (id: string, userId: string, content: Record<string, unknown>) => ({
  id,
  userId,
  name: `Plan ${id}`,
  content,
});

describe('extractPlanPersonas', () => {
  it('links each plan to its persona and strips identity from the plan', async () => {
    const { db, state } = fakeDb({
      plans: [plan('a', 'u1', { states: [], system_prompt: 'You are Grace.', voice: 'grace' })],
    });

    await extractPlanPersonas(db, { apply: true, ...quiet });

    expect(state.personas).toHaveLength(1);
    expect(state.personas[0]).toMatchObject({
      userId: 'u1',
      systemPrompt: 'You are Grace.',
      voice: 'grace',
    });
    expect(state.plans[0].defaultPersonaId).toBe(state.personas[0].id);
    // The write-time validator rejects both keys, so both must go.
    expect(state.plans[0].content).toEqual({ states: [] });
  });

  it('shares one persona between plans with the same prompt and owner', async () => {
    const { db, state } = fakeDb({
      plans: [
        plan('a', 'u1', { system_prompt: 'Same.' }),
        plan('b', 'u1', { system_prompt: 'Same.' }),
        plan('c', 'u2', { system_prompt: 'Same.' }),
      ],
    });

    await extractPlanPersonas(db, { apply: true, ...quiet });

    expect(state.personas).toHaveLength(2);
    expect(state.plans[0].defaultPersonaId).toBe(state.plans[1].defaultPersonaId);
    expect(state.plans[2].defaultPersonaId).not.toBe(state.plans[0].defaultPersonaId);
  });

  it('creates nothing on a second run', async () => {
    const { db, state } = fakeDb({
      plans: [plan('a', 'u1', { system_prompt: 'You are Grace.' })],
      projects: [
        {
          id: 'proj',
          memberships: [{ userId: 'u1', role: 'OWNER', createdAt: new Date(0) }],
          publicAgentConfig: { plan: { system_prompt: 'You are Grace.' } },
        },
      ],
    });

    await extractPlanPersonas(db, { apply: true, ...quiet });
    const after = JSON.stringify(state);
    const second = await extractPlanPersonas(db, { apply: true, ...quiet });

    expect(JSON.stringify(state)).toBe(after);
    expect(second).toMatchObject({ personasCreated: 0, plansLinked: 0, projectsLinked: 0 });
  });

  it('a failing group changes nothing and a re-run finishes the job without duplicates', async () => {
    const seed = {
      plans: [
        plan('a', 'u1', { system_prompt: 'P1.' }),
        plan('b', 'u1', { system_prompt: 'P1.' }),
      ],
      failOnPlanId: 'b',
    };
    const { db, state } = fakeDb(seed);

    await expect(extractPlanPersonas(db, { apply: true, ...quiet })).rejects.toThrow('boom');
    // Rolled back: no orphan persona, no half-stripped plan.
    expect(state.personas).toHaveLength(0);
    expect(state.plans[0].content).toEqual({ system_prompt: 'P1.' });

    seed.failOnPlanId = '';
    await extractPlanPersonas(db, { apply: true, ...quiet });
    expect(state.personas).toHaveLength(1);
    expect(state.plans.every((p) => p.defaultPersonaId === state.personas[0].id)).toBe(true);
  });

  it('reuses an existing persona with the same text instead of duplicating it', async () => {
    const { db, state } = fakeDb({
      personas: [{ id: 'mine', userId: 'u1', systemPrompt: 'You are Grace.', voice: null }],
      plans: [plan('a', 'u1', { system_prompt: 'You are Grace.' })],
    });

    await extractPlanPersonas(db, { apply: true, ...quiet });

    expect(state.personas).toHaveLength(1);
    expect(state.plans[0].defaultPersonaId).toBe('mine');
  });

  it('strips a stray voice even when the plan has no prompt, and links nothing', async () => {
    const { db, state } = fakeDb({ plans: [plan('a', 'u1', { states: [], voice: 'grace' })] });

    await extractPlanPersonas(db, { apply: true, ...quiet });

    expect(state.plans[0].content).toEqual({ states: [] });
    expect(state.plans[0].defaultPersonaId).toBeNull();
    expect(state.personas).toHaveLength(0);
  });

  it('gives a public project a personaId and strips identity from its embedded plan', async () => {
    const { db, state } = fakeDb({
      projects: [
        {
          id: 'proj',
          memberships: [
            { userId: 'member', role: 'MEMBER', createdAt: new Date(0) },
            { userId: 'owner', role: 'OWNER', createdAt: new Date(5) },
          ],
          publicAgentConfig: {
            name: 'Study',
            plan: { states: [], system_prompt: 'You are Grace.', voice: 'grace' },
          },
        },
      ],
    });

    await extractPlanPersonas(db, { apply: true, ...quiet });

    expect(state.personas[0]).toMatchObject({ userId: 'owner', systemPrompt: 'You are Grace.' });
    expect(state.projects[0].publicAgentConfig).toEqual({
      name: 'Study',
      personaId: state.personas[0].id,
      plan: { states: [] },
    });
  });

  it('keeps a persona the public project already chose', async () => {
    const { db, state } = fakeDb({
      projects: [
        {
          id: 'proj',
          memberships: [{ userId: 'u1', role: 'OWNER', createdAt: new Date(0) }],
          publicAgentConfig: { personaId: 'chosen', plan: { system_prompt: 'Old.' } },
        },
      ],
    });

    await extractPlanPersonas(db, { apply: true, ...quiet });

    expect(state.projects[0].publicAgentConfig).toEqual({ personaId: 'chosen', plan: {} });
    expect(state.personas).toHaveLength(0);
  });

  it('writes nothing in a dry run', async () => {
    const { db, state } = fakeDb({
      plans: [plan('a', 'u1', { system_prompt: 'You are Grace.' })],
    });

    const summary = await extractPlanPersonas(db, { apply: false, ...quiet });

    expect(state.personas).toHaveLength(0);
    expect(state.plans[0].content).toEqual({ system_prompt: 'You are Grace.' });
    expect(summary.personasCreated).toBe(0);
    expect(summary.plansLinked).toBe(0);
  });
});
