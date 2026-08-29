# Persona as a first-class configuration entity

- **Ticket:** [#467 — Separate identity from plans and pipeline config](https://github.com/c4dhi/STELLA/issues/467)
- **Branch / PR:** `467-persona-configuration` · PR _(pending)_
- **Status:** Design agreed. Phase 1 not yet started.

Who the agent *is* becomes its own configuration object, separate from what it *does* (the plan) and how it *runs* (the pipeline config). One plan can then be delivered by different personas, and a persona survives an agent version bump. Voice identity moves with the persona, and a persona can carry an uploaded reference clip for TTS cloning.

---

## 1. Problem

There are two configuration entities today — `PlanTemplate` (structure) and `AgentConfiguration` (pipeline) — and identity is smeared across both. At runtime the two are concatenated:

```python
# agents/stella-v2-agent/src/stella_v2_agent/prompts/response_prompt.py:59
if plan_system_prompt and custom_persona:
    sections.append(plan_system_prompt)   # plan speaks first
    sections.append(custom_persona)       # configurator speaks second
```

Two authors of one voice, resolved by ordering. Three consequences:

| Consequence | Mechanism |
|---|---|
| **Identity blocks deploys** | A persona lives in the `response_generator.persona` slot of an agent type's `pipelineSchema`, saved as an `AgentConfiguration` — bound to `agentTypeId`, pinned to `agentVersion` *and* `minCompilerVersion`, stampable `OUTDATED` by `reconcileAgentTypeConfigurations`, then hard-rejected by `resolveForDeploy`. Rename a pipeline node, re-seed, and the agent's personality 400s the deployment. |
| **Personas duplicate per plan** | `plan-generator.service.ts:669` instructs the model *"ALWAYS generate a system_prompt with…"*, and every few-shot example carries one. Every generated plan ships its own near-identical "warm friendly coach" block. |
| **No home for a plan-less persona** | A free-conversation (companion) deployment has an identity and no plan. There is nowhere to put it. |

---

## 2. The seam already exists in the code

`build_response_prompt` treats its two inputs differently, deliberately:

- **Persona is inserted verbatim, never rendered** — *"so any `{{...}}` in a plan persona is left untouched"* (`response_prompt.py:57`).
- **Guidelines are template-compiled** against the agent type's runtime palette (`{{conversationHistory}}`, `{{stateContext}}`, `{{directive}}`, …).

The verbatim half has no dependency on the agent type; the rendered half does. That is the boundary, and it is where the entity splits. **Persona is the verbatim half and nothing else.**

---

## 3. Ownership

| Concern | Owner | Rationale |
|---|---|---|
| Persona prose | **Persona** | Verbatim, agent-agnostic, no palette dependency |
| TTS voice identity | **Persona** | `plan.voice` is read at `agent.py:293` but written by nothing — a homeless field looking for this owner |
| Greeting | **Persona** | Companion mode has no plan to trigger one |
| `conversation_guidelines` | `AgentConfiguration` | Template-rendered against a per-agent-type palette — genuinely coupled |
| model / temperature / thresholds | `AgentConfiguration` | Pipeline tuning, not identity |
| states / tasks / deliverables / transitions | `PlanTemplate` | Pure structure |
| `language` | `PlanTemplate` (primary) | See [§5](#5-voice-and-language-are-joined-at-synthesis-not-at-configuration) |

### Decisions

- **Persona never acquires pipeline knobs.** The moment it holds a model name or a threshold it needs schema validation, and it inherits the version pinning this RFC exists to escape. This is the invariant that keeps it useful.
- **Persona is verbatim.** `stella-light-agent` renders its merged `system_prompt` slot through the compiler (`agent.py:239`). That contract is not adopted here — see [§8](#8-what-is-explicitly-out-of-scope).
- **One source, no chain.** `persona.systemPrompt`, else the system default persona. No fallback to `plan.system_prompt` — see [§6](#6-the-clean-cut).

---

## 4. Model

```prisma
model Persona {
  id              String  @id @default(uuid())
  userId          String?           // null = system-owned default
  name            String            // "Grace — clinical"
  description     String? @db.Text
  systemPrompt    String  @db.Text  // verbatim, never rendered
  greeting        String? @db.Text
  voice           String?           // voice id; null = provider default ("auto")
  language        String?           // fallback only; a plan's declared language wins
  icon            String?
  isSystemDefault Boolean @default(false)
  // deliberately NO agentTypeId, NO version pinning, NO pipeline knobs
}
```

Resolution:

```
persona.systemPrompt   ->  else system default persona
persona.voice  >  TTS_VOICE env  >  provider default
```

---

## 5. Voice and language are joined at synthesis, not at configuration

They are interconnected, which invites collapsing them into one persona field. That would be wrong, and the TTS layer already shows why.

The Qwen3 registry models a voice as an **identity with per-language reference clips**:

```json
{ "id": "stella", "default_language": "en",
  "clips": { "en": {...}, "de": {...} } }
```

`voice` and `language` arrive as two independent request fields and are joined in `_resolve_ref` (`tts-service/src/providers/qwen3_provider.py:572`), whose fallback chain exhausts *the requested voice* before it will change speaker:

```
(voice, language) -> (voice, voice.default_language)
  -> (default_voice, language) -> (default_voice, its default)
  -> bundled QWEN3_REF_AUDIO clip
```

**Identity is preserved over language fidelity** — already the correct priority. When the resolver flips a turn to German, Stella stays Stella and picks up her German clip; timbre is carried by the x-vector either way.

Collapsing voice+language into one persona field would force a persona per language and either kill per-turn detection or require swapping personas mid-session. So:

- **Voice identity → Persona.** Stable for the session; this is *who* is speaking.
- **Language → Plan (declared), else per-turn detection.** A plan whose prompts and acceptance criteria are written in German is German wherever it is deployed — the rule `frontend-ui/src/lib/sessionLanguage.ts` already documents.
- **`persona.language` is a fallback only**, for the no-plan (companion) case. It never overrides a plan's declaration.

---

## 6. The clean cut

No permanent `persona > plan.system_prompt > default` chain. That is two sources forever, and it reproduces the ambiguity in [§1](#1-problem) with extra steps. One-time extraction, then the field is gone.

### 6.1 Where plan JSON is persisted

| Surface | Durable? | Action |
|---|---|---|
| `PlanTemplate.content` | source of truth | extract → Persona, strip field |
| `Project.publicAgentConfig.plan` | **yes** | add `personaId`, strip from embedded plan |
| `Session.lastAgentConfig` | active/paused sessions | add `personaId` at write |
| `AgentInstance.agentConfig` | per-deployment | same |
| `SessionState.planData` | yes, but **inert** | leave alone |
| K8s Secret `AGENT_CONFIG` | ephemeral | next restart |

`SessionState.planData` looks like the dangerous one — a durable full-plan snapshot on every live session — but `_plan_system_prompt` is read from the **deploy config** (`agent.py:846`), never from the state machine. The copy there is already dead weight for persona purposes. Live execution state does not need rewriting.

### 6.2 Migration

1. For each `PlanTemplate` with a non-empty `content.system_prompt`: hash the text, create one Persona per distinct hash, link it, strip the field. The dedupe is itself the point — the generator writes one per plan, so many near-identical blocks collapse into a handful of real personas.
2. Seed a **system default persona** (`userId: null`, `isSystemDefault: true`, not deletable) as the landing spot for plans that never had one.
3. **Order: DB migration before agent image rollout.** Reversed, a session paused mid-conversation resumes onto a new-image pod whose `lastAgentConfig` has no `personaId`, drops to the default persona, and changes voice mid-conversation.

Of the three plans bundled in-repo, only `plan_physical_activity_checkin.json` carries a `system_prompt`; the other two are already persona-free. The volume is in user-created templates.

### 6.3 Guardrails

Without these the field grows back:

1. **Scrub the AI generator** (`plan-generator.service.ts`) — it *instructs* the model to always emit a `system_prompt`, and its examples model the behavior. Main re-contamination vector.
2. **Validate on write** — `CreatePlanTemplateDto.content` is a bare `@IsObject()` with no shape checking at all. 400 on `system_prompt` with a pointer to personas.
3. **Remove the field from the Plan Builder** (`PlanBuilder.tsx:473`).
4. **The agent stops reading `plan["system_prompt"]`**, so a hand-authored plan JSON dropped into `config/plans/` cannot smuggle one back in.
5. **Delete `plan.voice`** — nothing writes it.

An earlier draft proposed `plan.metadata.persona_mode: 'inherit' | 'override'` as an escape hatch for plans needing their own character. It is **withdrawn**: it contradicts the cut. A plan that needs a different character is a different persona selected at deploy time.

---

## 7. Voice clip upload

Personas are the natural owner of an uploaded reference clip. The registry already thinks in the right shape, so this extends [§5](#5-voice-and-language-are-joined-at-synthesis-not-at-configuration) rather than adding a concept. Three constraints shape the implementation:

**7.1 The backend cannot write to the TTS volume.** `tts-models-pvc` is `ReadWriteOnce` (`k8s/02-tts-models-pvc.yaml`) and `session-management-server` does not mount it. `StorageService` therefore cannot drop a clip into `/models/qwen3/`. Proposal: an `UploadVoiceClip` RPC on the TTS service, so the PVC stays private to the pod that owns it.

**7.2 The registry loads once, at boot.** `_load_registry()` runs inside `initialize()` (`qwen3_provider.py:330`), and the TTS proto exposes only `Synthesize`, `SynthesizeStream`, `Warmup`, `HealthCheck`, `GetCapabilities`. An uploaded clip stays invisible until the GPU pod restarts — which is expensive and not something to trigger casually. Needs a `ReloadVoices` RPC; the reload itself is trivial, since `_load_registry()` already resets `_ref_cache`.

**7.3 A clip without a transcript is silently skipped.** `_resolve_ref` gates each candidate on `if text:` — no sidecar `.txt` means the clip never matches and the chain falls through to another voice. To the user this presents as "my upload did nothing", with no error anywhere. **Mitigation: run the clip through the existing STT service on upload** and pre-fill the transcript for the user to correct.

Also required: 5–10s trim validation (the provider docstring is explicit — the clip sets the x-vector and prefills ICL mode), format/sample-rate normalization, and a **consent/provenance record** — whose voice this is and who attested to it. This is voice cloning in a care context; that belongs in a column, not a convention.

---

## 8. What is explicitly out of scope

- **`stella-light-agent`.** It already went partway down this road differently: persona and guidelines were merged into a single `system_prompt` slot (with `persona`/`guidelines` kept as legacy fields), and it **renders** that prompt through the compiler (`agent.py:239`) where v2 keeps persona verbatim. Two contradictory contracts. Phase 1 targets v2 only; reconciling light-agent is a follow-up, not a same-PR merge.
- **Companion mode.** Unblocked by this RFC (`plan-following = Persona + 1 Plan`, `companion = Persona + N Plans`) but tracked separately.

---

## 9. Phases

| Phase | Scope | Ends with |
|---|---|---|
| **1 — Entity** | `Persona` model + migration, CRUD module (mirrors `src/plan-templates/`), system default seed, `personaId` on `CreateAgentDto`, resolution in `applyScopedConfiguration`, agent + prompt plumbing, deploy-modal picker, settings CRUD | Persona optional; `plan.system_prompt` still works; nothing breaks |
| **2 — Clean cut** | Extraction migration, `plan_system_prompt` deleted from the prompt path, the five guardrails, snapshot surfaces | One source of identity |
| **3 — Voice clips** | `UploadVoiceClip` + `ReloadVoices` RPCs, STT-assisted transcript, duration/format validation, consent record, upload UI | Personas carry their own voice |

**Non-obvious edit in phase 1:** `applyScopedConfiguration` early-returns at `if (!envVarTemplateId && !agentConfigurationId) return;` (`agents.service.ts:477`). That guard must learn about `personaId` or persona silently never resolves.

---

## 10. Open questions

- **Persona scope.** `PlanTemplate` and `AgentConfiguration` are both `userId`-scoped with cascade delete. If personas are as reusable as this RFC argues, they will want project scope or sharing sooner than plans did. Changing an ownership column after rows exist is the expensive migration — **decide before the phase 1 migration runs.**
- **Light-agent convergence.** Does it eventually adopt the verbatim contract, or does Persona grow a rendered variant? Deferred, but the answer determines whether `Persona.systemPrompt` can ever contain `{{placeholders}}`.
