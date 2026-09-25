-- A plan remembers the persona it spoke with before identity moved out of plans.
--
-- Without this link the persona extraction (scripts/migrations/extract-plan-personas.ts)
-- creates personas that nothing points to, and every existing plan would deploy
-- with the system default persona after the upgrade. ON DELETE SET NULL: deleting
-- the persona degrades the plan to the system default rather than breaking it.
ALTER TABLE "PlanTemplate" ADD COLUMN IF NOT EXISTS "defaultPersonaId" TEXT;

CREATE INDEX IF NOT EXISTS "PlanTemplate_defaultPersonaId_idx" ON "PlanTemplate"("defaultPersonaId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PlanTemplate_defaultPersonaId_fkey') THEN
    ALTER TABLE "PlanTemplate" ADD CONSTRAINT "PlanTemplate_defaultPersonaId_fkey"
      FOREIGN KEY ("defaultPersonaId") REFERENCES "Persona"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
