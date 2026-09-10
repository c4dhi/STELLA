-- Persona: agent identity as a first-class configuration entity (#467).
-- See docs/rfcs/2026-08-29_persona-separation.md.
--
-- Identity was previously smeared across two entities designed for other jobs —
-- PlanTemplate.content.system_prompt and the response_generator.persona slot of an
-- AgentConfiguration — and concatenated at runtime, giving one voice two authors
-- resolved by ordering. Worse, a persona living inside an AgentConfiguration is
-- pinned to an agent type's version and can be stamped OUTDATED, at which point
-- the agent's *personality* rejects a deployment.
--
-- This table deliberately carries no agentTypeId, no version pinning and no
-- pipeline knobs, which is what keeps it immune to that.

CREATE TABLE "Persona" (
    "id" TEXT NOT NULL,
    -- NULL = system-owned (the built-in default persona).
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    -- Injected verbatim into the response prompt; never rendered through the
    -- per-agent-type placeholder palette, which is why a persona has no
    -- dependency on any agent type.
    "systemPrompt" TEXT NOT NULL,
    -- Personas are usable without a plan (companion mode), where there is no
    -- plan-driven first task to trigger an opening line.
    "greeting" TEXT,
    -- Voice IDENTITY, not a language: the TTS provider joins (voice, language) at
    -- synthesis and prefers keeping the voice over matching the language.
    "voice" TEXT,
    -- Fallback language only; a plan that declares one always wins.
    "language" TEXT,
    "isSystemDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Persona_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Persona_userId_idx" ON "Persona"("userId");
CREATE INDEX "Persona_isSystemDefault_idx" ON "Persona"("isSystemDefault");

-- SET NULL, not CASCADE. A persona that loses its author must degrade to the
-- system default, never vanish: deleting a user would otherwise be able to change
-- the voice of a live or resumable session.
ALTER TABLE "Persona" ADD CONSTRAINT "Persona_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the system default persona. The resolution chain terminates here, so this
-- row has to exist before any deployment can resolve a persona. Idempotent so the
-- migration is safe to re-run; prisma/seed.ts keeps the text current afterwards.
INSERT INTO "Persona" ("id", "userId", "name", "description", "icon", "systemPrompt", "isSystemDefault", "createdAt", "updatedAt")
SELECT
    '00000000-0000-4000-8000-000000000001',
    NULL,
    'STELLA (default)',
    'Built-in fallback identity, used when a deployment names no persona. Copy it to make your own.',
    '🌟',
    'You are STELLA — a warm, genuinely curious conversation partner with a personality of your own, working toward collecting specific information through real conversation, not a form.

- Respond in the SAME LANGUAGE the user speaks (German if they speak German, English if English).
- Keep responses to 30-50 words (this is a voice conversation).
- NEVER mention internal systems, experts, deliverables, or technical metadata.
- React to the specific thing the user said; never re-ask something they already answered.
- Ask for missing information naturally, one thing at a time.',
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "Persona" WHERE "isSystemDefault" = true);
