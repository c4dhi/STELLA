-- Uploads used to be visible to everyone. Keep what already uses them working:
-- share an upload with every project that uses it as its public agent, and
-- with every project where someone other than its owner has it running or
-- paused. Uploads nobody else uses stay private to their owner.

INSERT INTO "AgentTypeProjectShare" ("id", "agentTypeId", "projectId")
SELECT gen_random_uuid()::text, t."id", p."id"
FROM "Project" p
JOIN "AgentType" t ON t."id" = p."publicAgentTypeId"
WHERE t."isBuiltIn" = false
ON CONFLICT ("agentTypeId", "projectId") DO NOTHING;

INSERT INTO "AgentTypeProjectShare" ("id", "agentTypeId", "projectId")
SELECT gen_random_uuid()::text, sub."agentTypeId", sub."projectId"
FROM (
  SELECT DISTINCT t."id" AS "agentTypeId", s."projectId"
  FROM "AgentInstance" a
  JOIN "AgentType" t ON t."id" = a."agentTypeId"
  JOIN "Session" s ON s."id" = a."sessionId"
  WHERE t."isBuiltIn" = false
    AND s."projectId" IS NOT NULL
    AND (a."status" IN ('STARTING', 'RUNNING') OR a."pausedAt" IS NOT NULL)
    AND (a."deployedByUserId" IS NULL OR t."userId" IS NULL OR a."deployedByUserId" <> t."userId")
) sub
ON CONFLICT ("agentTypeId", "projectId") DO NOTHING;
