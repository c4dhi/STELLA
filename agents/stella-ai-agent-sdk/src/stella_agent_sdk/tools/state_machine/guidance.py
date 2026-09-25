"""Canonical tool-usage contract for the state-machine tools.

SINGLE SOURCE OF TRUTH. Every agent that calls the state-machine tools
(set_deliverable / batch_update / complete_task / skip_task / skip_state) injects
THIS text in the background — it is crucial plumbing, never an operator-editable
prompt. The tools are identical across agents, so the contract that explains how
to use them must be identical too. Do not hand-duplicate this prose in an agent's
prompts or config; import it from here.

Any agent that drives state through these tools appends
``STATE_MACHINE_TOOL_GUIDANCE`` to its tool-calling prompt. Edit the contract
here and every consumer picks up the change.
"""

# The tool *schemas* (names/params/descriptions) come from each tool's
# to_openai_schema(); this is the supplementary usage guidance — when to reach
# for which tool, and the invariants that keep state progression correct.
STATE_MACHINE_TOOL_GUIDANCE = """## Tool Usage
You drive the conversation forward with these tools. The conversation only advances when EVERY task in the current phase is explicitly completed or skipped — nothing happens on its own. ("required" is guidance about importance, not a gate; you may skip a required task that genuinely does not apply.)

- **set_deliverable** — record ONE value the user CLEARLY and EXPLICITLY provided. Never for greetings (hi, hello, good morning); never guess or infer a value; if unsure, ask a clarifying question instead. Recording a deliverable does NOT complete its task.
- **batch_update** — record many deliverables and/or complete/skip many tasks in a SINGLE call. Prefer it when you have several updates this turn. Each deliverable is {key, value, reasoning, correction?}; each task is {task_id, reasoning}.
- **complete_task** — mark a task done once you have done it: a deliverable-less task you just performed (an introduction, a joke, a goodbye), or a task whose required deliverables you have now collected.
- **skip_task** — skip a single task that does not apply or is not worth pursuing (e.g. an optional task the user clearly will not engage with), so the conversation can move on.
- **skip_state** — skip the ENTIRE current phase when none of it is relevant; it marks every remaining task in the phase as skipped and advances.

Rules:
- NEVER complete_task a task that owns a REQUIRED deliverable until that deliverable is recorded (set it this turn or it is already collected). Completing it before its answer exists wrongly marks the task done and can advance the conversation — e.g. completing "greet and ask for name" before any name was given. To move past such a task WITHOUT the answer, skip_task instead. (The state machine enforces this and will reject a premature completion.)
- A deliverable that is already collected can only change through a deliberate correction by the user ("actually, it is Sarah, not Tom"). Set `correction: true` on that set_deliverable / batch_update entry and quote what they said in `reasoning`. Without it the state machine REJECTS the change and keeps the old value, so never use it for a first answer or a passing mention.
- `task_id` must be the EXACT task ID (UUID) from the current context — never the task's description text. If you only know the description, call get_pending_tasks first to map it to the ID.
- Interpreting a user "skip" request — read the scope literally: a bare "skip this" / "can we move on" / "I'd rather not answer that" refers to the CURRENT task ONLY → skip_task. Use skip_state ONLY when they explicitly drop the whole section ("skip all of this", "move on to the next section"). When in doubt, prefer skip_task — skip_state discards every remaining task and can end the conversation early.
- Once a task is skipped or its phase has ended, stop soliciting that deliverable.
- If there is nothing to record, complete, or skip this turn, call no tool."""
