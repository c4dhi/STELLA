/**
 * Phase 2 of #467 / #550: move identity out of plans and public projects into
 * personas, and link each plan to its persona so nothing loses its personality.
 * The logic lives in src/personas/persona-extraction.ts (unit-tested).
 *
 *   npx ts-node scripts/migrations/extract-plan-personas.ts           # dry run
 *   npx ts-node scripts/migrations/extract-plan-personas.ts --apply   # write
 *
 * Deliberately a script rather than a SQL migration: the mapping deserves to be
 * read by a human before anything is stripped. Safe to re-run.
 */
import { PrismaClient } from '@prisma/client';
import { extractPlanPersonas } from '../../src/personas/persona-extraction';

const prisma = new PrismaClient();

extractPlanPersonas(prisma, { apply: process.argv.includes('--apply') })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
