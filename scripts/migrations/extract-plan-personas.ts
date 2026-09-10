/**
 * Phase 2 of #467: extract identity out of plans.
 *
 * Every PlanTemplate that carries `content.system_prompt` has its prompt lifted
 * into a Persona and the field stripped, so identity lives in exactly one place.
 * Prompts are deduped by exact text — the AI plan generator writes one per plan
 * and is instructed to always do so, which is precisely how near-identical
 * "warm friendly coach" blocks multiplied. Collapsing them is the point.
 *
 *   npx ts-node scripts/migrations/extract-plan-personas.ts           # dry run
 *   npx ts-node scripts/migrations/extract-plan-personas.ts --apply   # write
 *
 * Deliberately a script rather than a SQL migration: the mapping deserves to be
 * read by a human before anything is stripped, and creating personas needs the
 * dedupe logic. Idempotent — a plan with no system_prompt is skipped, so a second
 * run is a no-op.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { createHash } from 'crypto';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

type PlanContent = { system_prompt?: string; [k: string]: unknown };

/** A readable persona name derived from the plans that shared this prompt. */
function personaNameFor(planNames: string[]): string {
  const base = planNames[0].replace(/\s*\(Copy\)\s*$/i, '').trim();
  return planNames.length === 1 ? `${base} persona` : `${base} persona (+${planNames.length - 1} more)`;
}

async function main() {
  const templates = await prisma.planTemplate.findMany({
    orderBy: { createdAt: 'asc' },
  });

  // hash -> { prompt, plans }
  const groups = new Map<string, { prompt: string; plans: { id: string; name: string; userId: string }[] }>();

  for (const t of templates) {
    const content = (t.content ?? {}) as PlanContent;
    const prompt = typeof content.system_prompt === 'string' ? content.system_prompt.trim() : '';
    if (!prompt) continue;

    const hash = createHash('sha256').update(prompt).digest('hex');
    const group = groups.get(hash) ?? { prompt, plans: [] };
    group.plans.push({ id: t.id, name: t.name, userId: t.userId });
    groups.set(hash, group);
  }

  console.log(`\n${templates.length} plan template(s); ${[...groups.values()].reduce((n, g) => n + g.plans.length, 0)} carry a system_prompt.`);
  console.log(`${groups.size} distinct prompt(s) -> ${groups.size} persona(s) will be created.\n`);

  let i = 0;
  for (const [hash, group] of groups) {
    i += 1;
    console.log(`── Persona ${i}/${groups.size}  [${hash.slice(0, 8)}]`);
    console.log(`   name:  ${personaNameFor(group.plans.map((p) => p.name))}`);
    console.log(`   from:  ${group.plans.map((p) => `"${p.name}"`).join(', ')}`);
    console.log(`   owner: ${group.plans[0].userId}`);
    console.log(`   prompt (${group.prompt.length} chars): ${JSON.stringify(group.prompt.slice(0, 160))}${group.prompt.length > 160 ? '…' : ''}`);
    console.log('');
  }

  if (!APPLY) {
    console.log('DRY RUN — nothing written. Re-run with --apply to create personas and strip the field.\n');
    return;
  }

  for (const group of groups) {
    const [, g] = group;
    // Personas are per-user; a prompt shared across two users' plans would need
    // one persona each. In practice these are single-owner, but grouping by owner
    // keeps the script correct rather than merely convenient.
    const byOwner = new Map<string, typeof g.plans>();
    for (const plan of g.plans) {
      byOwner.set(plan.userId, [...(byOwner.get(plan.userId) ?? []), plan]);
    }

    for (const [userId, plans] of byOwner) {
      const persona = await prisma.persona.create({
        data: {
          userId,
          name: personaNameFor(plans.map((p) => p.name)),
          description: `Extracted from ${plans.length === 1 ? 'plan' : 'plans'} ${plans.map((p) => `"${p.name}"`).join(', ')} when identity moved out of plans (#467).`,
          icon: '🎭',
          systemPrompt: g.prompt,
        },
      });
      console.log(`created persona ${persona.id} (${persona.name}) for ${plans.length} plan(s)`);

      for (const plan of plans) {
        const row = await prisma.planTemplate.findUnique({ where: { id: plan.id } });
        if (!row) continue;
        const content = { ...((row.content ?? {}) as PlanContent) };
        delete content.system_prompt;
        await prisma.planTemplate.update({
          where: { id: plan.id },
          data: { content: content as Prisma.InputJsonValue },
        });
        console.log(`  stripped system_prompt from plan ${plan.id} ("${plan.name}")`);
      }
    }
  }

  console.log('\nDone. Plans now carry structure only.\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
