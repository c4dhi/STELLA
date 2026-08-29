-- An AgentType can now be marked superseded without being retired.
--
-- REJECTED already hides a type from the gallery, but it is a validation
-- outcome and it hides it completely. Deprecation is the softer state we
-- actually need for stella-light: existing deployments keep running, saved
-- configurations stay valid, and the type simply stops being offered for
-- new work.
ALTER TABLE "AgentType" ADD COLUMN IF NOT EXISTS "deprecated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AgentType" ADD COLUMN IF NOT EXISTS "deprecationNote" TEXT;
