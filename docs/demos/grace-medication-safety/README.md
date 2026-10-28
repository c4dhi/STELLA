# Grace medication-safety demo

The configuration running on stella-prod for the Grace demo (V2 agent,
`Medication Safety (Demo)` agent configuration plus the `Grace` persona).

| File | What it is |
|---|---|
| `grace-persona.txt` | Grace's system prompt: a companion, not an interviewer |
| `agent-configuration.json` | `AgentConfiguration.configuration` for `Medication Safety (Demo)` |
| `apply.sql` | Writes both rows (prod IDs; change them for another database) |

## Behaviour

- One custom expert, `medication_safety` (gpt-4.1-mini); the built-in medical,
  legal, noise, probing and timekeeper experts are off.
- Verdicts `none`/`low` inform the reply; `high` → `escalated` → `urgent`
  (risk persists) and `critical` (symptoms) override it with a fixed template
  that always refers outward to the pharmacist, GP or emergency services.
- Bridge: gpt-5.4-mini, temperature 0.8. gpt-4o-mini was tested and approved
  the double dose ("That makes sense!"), so do not move the bridge to it.
- Replies: gpt-4o-mini. gpt-4.1-mini and gpt-5.4-mini asked fewer questions but
  started judging medicines or giving advice.
- Override replies keep the spoken bridge as a prefix; this needs the agent
  fix in `fix/override-keeps-bridge`.

## Persona style

Grace keeps the user company instead of collecting information: short replies,
only about what the user said, mostly without a question, and never asking about
health or medicines. The earlier interviewer-style persona ended 14 of 14
non-override replies in a question, often about things the user never mentioned.
