import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Phase 2 of #467, and the data half of #550: move identity out of plans.
 *
 * Every plan that carries `system_prompt` (and `voice`) has it lifted into a
 * Persona, the plan is LINKED to that persona (PlanTemplate.defaultPersonaId) and
 * the fields are stripped, so identity lives in one place and nothing loses its
 * personality when personas arrive. Public projects embed a copy of a plan in
 * `publicAgentConfig`; those get the same treatment through `personaId`.
 *
 * Safe to re-run: identity is removed as it is moved, so a finished item is
 * skipped, and each owner group is written in one transaction so a failure part
 * way through leaves that group untouched rather than half-converted.
 *
 * Lives in src/ rather than scripts/ so it is covered by the jest suite; the
 * runnable entry point is scripts/migrations/extract-plan-personas.ts.
 */

export interface ExtractionOptions {
  apply: boolean;
  /** Print the start of each prompt. Off by default: prompts can be study material. */
  showPrompts?: boolean;
  log?: (line: string) => void;
}

export interface ExtractionSummary {
  personasCreated: number;
  personasReused: number;
  plansLinked: number;
  projectsLinked: number;
  projectsSkipped: number;
}

type Json = Record<string, unknown>;
type Identity = { prompt: string; voice: string | null };

const IDENTITY_KEYS = ['system_prompt', 'voice'] as const;

const isObject = (v: unknown): v is Json =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Whether the object still carries either identity key (even an empty one). */
function hasIdentityKeys(obj: unknown): obj is Json {
  return isObject(obj) && IDENTITY_KEYS.some((k) => k in obj);
}

/** The identity to preserve, or null when there is no prompt worth a persona. */
function identityOf(obj: Json): Identity | null {
  const prompt =
    typeof obj.system_prompt === 'string' ? obj.system_prompt.trim() : '';
  if (!prompt) return null;
  const voice =
    typeof obj.voice === 'string' && obj.voice.trim() ? obj.voice.trim() : null;
  return { prompt, voice };
}

function withoutIdentity(obj: Json): Json {
  const copy = { ...obj };
  for (const k of IDENTITY_KEYS) delete copy[k];
  return copy;
}

/** A readable persona name derived from the plans that shared this prompt. */
function personaNameFor(names: string[]): string {
  const base = names[0].replace(/\s*\(Copy\)\s*$/i, '').trim();
  return names.length === 1
    ? `${base} persona`
    : `${base} persona (+${names.length - 1} more)`;
}

async function findOrCreatePersona(
  tx: Prisma.TransactionClient,
  userId: string,
  identity: Identity,
  origin: { name: string; description: string },
): Promise<{ id: string; created: boolean }> {
  // Match on exact text so re-runs and public projects join the persona a plan
  // already produced, rather than minting a near-duplicate.
  const existing = await tx.persona.findFirst({
    where: {
      userId,
      systemPrompt: identity.prompt,
      voice: identity.voice,
      isSystemDefault: false,
    },
  });
  if (existing) return { id: existing.id, created: false };

  const created = await tx.persona.create({
    data: {
      userId,
      name: origin.name,
      description: origin.description,
      icon: '🎭',
      systemPrompt: identity.prompt,
      voice: identity.voice,
    },
  });
  return { id: created.id, created: true };
}

export async function extractPlanPersonas(
  prisma: PrismaClient,
  { apply, showPrompts = false, log = console.log }: ExtractionOptions,
): Promise<ExtractionSummary> {
  const summary: ExtractionSummary = {
    personasCreated: 0,
    personasReused: 0,
    plansLinked: 0,
    projectsLinked: 0,
    projectsSkipped: 0,
  };

  // ── Plans ────────────────────────────────────────────────────────────────
  const templates = await prisma.planTemplate.findMany({
    orderBy: { createdAt: 'asc' },
  });

  type PlanRef = { id: string; name: string; content: Json };
  const groups = new Map<
    string,
    { userId: string; identity: Identity; plans: PlanRef[] }
  >();
  const strayOnly: PlanRef[] = [];

  for (const t of templates) {
    const content = isObject(t.content) ? t.content : {};
    if (!hasIdentityKeys(content)) continue;
    const ref = { id: t.id, name: t.name, content };
    const identity = identityOf(content);
    if (!identity) {
      // A `voice` or an empty prompt with nothing to preserve. Still stripped:
      // the write-time validator would reject the plan on its next save.
      strayOnly.push(ref);
      continue;
    }
    const key = JSON.stringify([t.userId, identity.prompt, identity.voice]);
    const group = groups.get(key) ?? { userId: t.userId, identity, plans: [] };
    group.plans.push(ref);
    groups.set(key, group);
  }

  log(
    `${templates.length} plan template(s); ${groups.size} persona group(s) to link, ` +
      `${strayOnly.length} with stray identity keys only.`,
  );

  for (const group of groups.values()) {
    const names = group.plans.map((p) => p.name);
    log(
      `── ${personaNameFor(names)}  owner ${group.userId}  ` +
        `from ${names.map((n) => `"${n}"`).join(', ')}\n` +
        `   prompt: ${group.identity.prompt.length} chars` +
        (showPrompts
          ? `: ${JSON.stringify(group.identity.prompt.slice(0, 120))}`
          : ' (use --show-prompts to print it)'),
    );
    if (!apply) continue;

    await prisma.$transaction(async (tx) => {
      const persona = await findOrCreatePersona(tx as Prisma.TransactionClient, group.userId, group.identity, {
        name: personaNameFor(names),
        description:
          `Extracted from ${names.length === 1 ? 'plan' : 'plans'} ` +
          `${names.map((n) => `"${n}"`).join(', ')} when identity moved out of plans (#467).`,
      });
      for (const plan of group.plans) {
        await tx.planTemplate.update({
          where: { id: plan.id },
          data: {
            content: withoutIdentity(plan.content) as Prisma.InputJsonValue,
            defaultPersonaId: persona.id,
          },
        });
      }
      persona.created ? summary.personasCreated++ : summary.personasReused++;
      summary.plansLinked += group.plans.length;
    });
  }

  if (apply) {
    for (const plan of strayOnly) {
      await prisma.planTemplate.update({
        where: { id: plan.id },
        data: { content: withoutIdentity(plan.content) as Prisma.InputJsonValue },
      });
    }
  }

  // ── Public projects ──────────────────────────────────────────────────────
  const projects = await prisma.project.findMany({
    where: { publicAgentConfig: { not: Prisma.DbNull } },
    include: { memberships: { orderBy: { createdAt: 'asc' } } },
  });

  for (const project of projects) {
    const config = isObject(project.publicAgentConfig)
      ? project.publicAgentConfig
      : null;
    const plan = config && isObject(config.plan) ? config.plan : null;
    if (!config || !plan || !hasIdentityKeys(plan)) continue;

    const identity = identityOf(plan);
    // The runtime deploys as the first membership; prefer the real owner.
    const owner =
      project.memberships.find((m) => m.role === 'OWNER') ??
      project.memberships[0];

    if (identity && !config.personaId && !owner) {
      log(`project ${project.id}: no owner to attach a persona to; skipped`);
      summary.projectsSkipped++;
      continue;
    }

    log(
      `project ${project.id}: ${
        config.personaId
          ? 'keeps its chosen persona'
          : identity
            ? 'gets a persona from its embedded plan'
            : 'has only stray identity keys'
      }; identity stripped from its plan`,
    );
    if (!apply) continue;

    await prisma.$transaction(async (tx) => {
      let personaId = config.personaId as string | undefined;
      if (!personaId && identity && owner) {
        const persona = await findOrCreatePersona(tx as Prisma.TransactionClient, owner.userId, identity, {
          name: `${(config.name as string) || 'Public project'} persona`,
          description: `Extracted from the public project "${(config.name as string) || project.name}" when identity moved out of plans (#467).`,
        });
        personaId = persona.id;
        persona.created ? summary.personasCreated++ : summary.personasReused++;
      }
      await tx.project.update({
        where: { id: project.id },
        data: {
          publicAgentConfig: {
            ...config,
            ...(personaId ? { personaId } : {}),
            plan: withoutIdentity(plan),
          } as Prisma.InputJsonValue,
        },
      });
      summary.projectsLinked++;
    });
  }

  log(
    apply
      ? `\nDone. ${summary.personasCreated} persona(s) created, ${summary.personasReused} reused, ` +
          `${summary.plansLinked} plan(s) and ${summary.projectsLinked} public project(s) linked, ` +
          `${summary.projectsSkipped} project(s) skipped.\n`
      : '\nDRY RUN — nothing written. Re-run with --apply.\n',
  );
  return summary;
}
