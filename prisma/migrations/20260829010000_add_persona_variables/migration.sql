-- Persona runtime variables (#467).
--
-- Lets a fact about the agent be stated once on the persona and referenced from
-- an AgentConfiguration's prompts or a plan's own text as {{persona.<key>}},
-- rather than being restated in each place and drifting apart.
--
-- Resolved by prompt-compiler 1.1.0. Prompts pinned to 1.0.0 are unaffected:
-- there a {{persona.x}} token is left as-is, exactly like any other unknown
-- placeholder.
ALTER TABLE "Persona" ADD COLUMN "variables" JSONB;
