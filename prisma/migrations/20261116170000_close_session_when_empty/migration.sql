-- #162: whether an ACTIVE session closes (revoking its invitations) once
-- everyone has left. Private projects, existing ones included, keep their
-- sessions open; public projects close them, because every visitor starts
-- their own session and nobody comes back to it (Felix, 16 Nov 2026). A
-- session follows its project unless it sets its own value.
ALTER TABLE "Project" ADD COLUMN "closeSessionWhenEmpty" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Project" SET "closeSessionWhenEmpty" = true WHERE "isPublic" = true;
ALTER TABLE "Session" ADD COLUMN "closeWhenEmpty" BOOLEAN;

-- Set when everyone has left and the session was kept open, so the organiser
-- sees it and can restart the agent; cleared when somebody joins again.
ALTER TABLE "Session" ADD COLUMN "keptOpenAt" TIMESTAMP(3);
