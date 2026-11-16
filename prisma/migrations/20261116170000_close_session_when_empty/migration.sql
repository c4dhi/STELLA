-- #162: whether an ACTIVE session closes (revoking its invitations) once
-- everyone has left. Every project, existing ones included, now keeps its
-- sessions open (Felix, 16 Nov 2026); a session follows its project unless it
-- sets its own value.
ALTER TABLE "Project" ADD COLUMN "closeSessionWhenEmpty" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Session" ADD COLUMN "closeWhenEmpty" BOOLEAN;

-- Set when everyone has left and the session was kept open, so the organiser
-- sees it and can restart the agent; cleared when somebody joins again.
ALTER TABLE "Session" ADD COLUMN "keptOpenAt" TIMESTAMP(3);
