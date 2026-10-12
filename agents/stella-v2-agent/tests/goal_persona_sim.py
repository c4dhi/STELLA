"""Simulated users talking through plans that contain goal states (#706).

Not collected by pytest: it calls models and needs the in-memory state machine
(scripts/state-machine-memory-server.ts) listening. It is how a change to the
goal step is checked against conversations rather than against single calls.

Each user turn runs the production ``task_extraction`` expert (its prompt, its
tools, its model) against the real state machine. The reply comes from the real
reply generator, given a plain "work toward the current objective" directive in
place of arbitration. The user is a model playing one of PERSONAS.

From agents/stella-v2-agent, with OPENAI_API_KEY set:
    python tests/goal_persona_sim.py <out.json> [repeats] [max_turns]

The output holds every turn with the tool calls made and whether they were
accepted; read it for how each run left its goal states (reached, skipped,
released by the stuck-state net, or never).
"""

import asyncio
import json
import re
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

from stella_agent_sdk.llm import LLMConfig, LLMMessage, LLMProvider, LLMService
from stella_agent_sdk.services.state_machine_client import StateMachineClient
from stella_agent_sdk.tools.state_machine import create_state_machine_tools
from stella_v2_agent.agent import PROMPT_COMPILER_VERSION, StellaV2Agent
from stella_v2_agent.experts.base import ExpertConfig
from stella_v2_agent.experts.runner import ExpertRunner
from stella_v2_agent.models.arbitration_result import ResponseDirective
from stella_v2_agent.pipeline.response_generator import ResponseGenerator

ROOT = Path(__file__).resolve().parents[3]
ADDRESS = "127.0.0.1:50999"


def coaching_plan() -> dict:
    """The goal-state example the plan generator itself teaches (two goal states
    in a row, then a closing state), taken from the generator's prompt."""
    source = (ROOT / "src/plan-templates/plan-generator.service.ts").read_text()
    start = source.index("[", source.index('"states"', source.index('"id": "plan_coaching_session"')))
    depth, end = 0, start
    for end in range(start, len(source)):
        depth += {"[": 1, "]": -1}.get(source[end], 0)
        if depth == 0:
            break
    return {
        "id": "plan_coaching", "title": "Life Coaching Discovery", "initial_state_id": "state_rapport",
        "states": json.loads(source[start:end + 1]),
    }


def next_step_plan() -> dict:
    """One goal state without declared deliverables, then a closing state."""
    return {
        "id": "plan_next_step", "title": "Weekly check-in", "initial_state_id": "state_step",
        "states": [
            {
                "id": "state_step", "title": "Next step", "type": "goal", "tasks": [],
                "description": "Help the participant settle on one thing to do this week",
                "goal": {
                    "objective": "Help the participant define a concrete next step for being more active",
                    "depth_guidance": "Keep it light. One step is enough.",
                    "success_description": "The participant states a concrete, realistic next step they will take this week",
                },
            },
            {
                "id": "state_closing", "title": "Closing", "type": "strict",
                "tasks": [{"id": "task_close", "description": "Close warmly", "required": True, "deliverables": []}],
            },
        ],
    }


# What each simulated user is like. ``reveals`` are facts they state plainly at
# that message number (1-based) and not before; everything a goal's success
# description asks for is either in there or deliberately withheld.
PERSONAS = {
    "cooperative": {
        "brief": "Friendly and direct. You answer what you are asked in one or two sentences.",
        "plan_coaching": {3: "your name is Dana and you are a nurse on night shifts",
                          4: "you came to coaching because you were passed over for a promotion and feel stuck",
                          6: "what you want is to move into training new nurses, because teaching is what you enjoy",
                          8: "what stops you is that you never ask your manager for anything"},
        "plan_next_step": {3: "this week you will walk to the bakery on Tuesday and Thursday morning instead of driving"},
    },
    "rambler": {
        "brief": ("Warm and talkative. Every message wanders: your garden, the grandchildren, the neighbour's dog, "
                  "the weather, football, a recipe. Three or four sentences each time. When asked something "
                  "direct about yourself or about plans, you start to answer and drift to another story "
                  "without ever giving the answer."),
        "plan_coaching": {2: "your name is Ruth and you are a retired teacher"},
        "plan_next_step": {},
    },
    "unsure": {
        "brief": ("Hesitant. To anything about what you want, why, or what you will do, you say you are not sure: "
                  "'maybe', 'I don't know', 'I suppose I could', 'perhaps something like a walk, I can't say'. "
                  "You never commit to anything and never give a reason for anything."),
        "plan_coaching": {2: "your name is Sam and you work in an office"},
        "plan_next_step": {},
    },
    "terse": {
        "brief": "You answer in one to four words. 'Yes.' 'Fine.' 'Not really.' You volunteer nothing.",
        "plan_coaching": {2: "your name is Lee", 5: "you drive a bus"},
        "plan_next_step": {},
    },
    # Two built to tempt a goal closed too early.
    "past_habits": {
        "brief": ("Chatty about what you already do and used to do: your walks last summer, the swimming you did "
                  "for years, how you always take the stairs. Whatever you are asked about plans or wishes, you "
                  "answer with something from the past or something you already do, never with something new "
                  "you will do."),
        "plan_coaching": {2: "your name is Alex and you deliver the post"},
        "plan_next_step": {},
    },
    "agreeable": {
        "brief": ("Pleasant and vague. You go along with whatever is suggested without taking it on: 'sounds nice', "
                  "'that could be good', 'why not', 'we'll see'. You never say you will do it, and you never "
                  "name a day, a time or an activity yourself."),
        "plan_coaching": {2: "your name is Pat and you work in a shop"},
        "plan_next_step": {},
    },
    "declines": {
        "brief": ("Polite but firm. You do not want to go into this topic today. From your third message on you "
                  "say so plainly ('I'd rather not get into that', 'can we move on') each time it comes up."),
        "plan_coaching": {2: "your name is Kim and you are a carpenter"},
        "plan_next_step": {},
    },
}


async def user_says(llm, persona: dict, plan_id: str, history: list, number: int) -> str:
    reveals = persona[plan_id]
    said = [fact for at, fact in reveals.items() if at < number]
    now = reveals.get(number)
    prompt = (
        "You play a person talking by voice with an AI assistant. Write only your next spoken message.\n\n"
        f"Who you are: {persona['brief']}\n\n"
        + (f"You have already told the assistant: {'; '.join(said)}.\n" if said else "")
        + (f"In THIS message you state plainly that {now}.\n" if now else "")
        + "Apart from that, state no other concrete fact about your name, your work, your reasons, your wishes, "
          "your obstacles or your plans. Stay in character. No stage directions.\n\n"
        "Conversation so far:\n"
        + ("\n".join(f"{'You' if m['role'] == 'user' else 'Assistant'}: {m['content']}" for m in history) or "(nothing yet)")
    )
    response = await llm.generate(
        messages=[LLMMessage(role="user", content=prompt)],
        config=LLMConfig(model="gpt-4o-mini", temperature=0.8, max_tokens=160, provider=LLMProvider.OPENAI_LANGCHAIN),
        component_name="sim:user",
    )
    return re.sub(r"^(You|User):\s*", "", response.content.strip().strip(chr(34)))


async def run_one(llm, expert: ExpertConfig, plan: dict, persona_name: str, max_turns: int) -> dict:
    client = StateMachineClient(f"sim-{uuid.uuid4().hex[:10]}", ADDRESS)
    await client.connect()
    await client.initialize(plan)
    agent = SimpleNamespace(
        sm_client=client, _plan_config=plan, _last_state_id=None, _persona_config={},
        _resolve_persona_in_plan_text=lambda full_plan: None,
    )
    tools = [t for t in create_state_machine_tools(client) if t.name in set(expert.tools)]
    runner = ExpertRunner(llm, compiler_version=PROMPT_COMPILER_VERSION)
    generator = ResponseGenerator(llm)
    persona = PERSONAS[persona_name]
    goal_ids = {s["id"] for s in plan["states"] if s.get("type") == "goal"}
    declared = {d["key"] for s in plan["states"] for d in (s.get("goal") or {}).get("deliverables", [])}

    history, turns = [], []
    # The agent speaks first, as in a session.
    context = await StellaV2Agent._fetch_sm_context(agent)
    opening = "Hello, nice to talk with you. How are you today?"
    history.append({"role": "assistant", "content": opening})

    for number in range(1, max_turns + 1):
        state_before = context["state"]["id"]
        if state_before not in goal_ids:
            break
        text = await user_says(llm, persona, plan["id"], history, number)
        verdict = await runner.run(expert, text, history, context, tools=tools)
        raw = verdict.raw_output or {}
        calls = []
        for result in raw.get("tool_results", []):
            args = result.get("arguments", {}) or {}
            if result["name"] == "batch_update":
                data = result.get("data") or {}
                calls.append({"tool": "batch_update", "args": args, "ok": result.get("success"),
                              "errors": data.get("errors") or result.get("error")})
            else:
                calls.append({"tool": result["name"], "args": args, "ok": result.get("success"), "error": result.get("error")})
        full = await client.get_full_state()
        # The agent's own rule for "this turn made progress".
        progressed = bool(raw.get("tasks_completed")) or StellaV2Agent._wrote_defined_deliverable(
            raw.get("deliverables_set", []), full)
        if not progressed and full.get("current_state_id") != "__end__":
            await client.increment_turn()      # what the agent does after a turn without progress
        context = await StellaV2Agent._fetch_sm_context(agent)
        full = await client.get_full_state()
        state_after = full.get("current_state_id")
        history.append({"role": "user", "content": text})

        reply = ""
        if context:
            async for output in generator.generate(
                client.session_id, text,
                ResponseDirective(primary_action="Continue the conversation naturally toward the current objective."),
                history[:-1], context,
            ):
                reply = output.content or reply
        history.append({"role": "assistant", "content": reply})
        turns.append({
            "n": number, "user": text, "assistant": reply, "state_before": state_before, "state_after": state_after,
            "calls": calls, "expert_error": verdict.error_message,
            "set": raw.get("deliverables_set", []), "turns_without_progress": full.get("turns_without_progress"),
            "goal_close": raw.get("goal_close"),
            "revealed": persona[plan["id"]].get(number),
        })
        if state_after == "__end__" or not context:
            break

    collected = await client.get_collected_deliverables()
    await client.disconnect()
    return {
        "plan": plan["id"], "persona": persona_name, "turns": turns, "collected": collected,
        "undeclared_keys": sorted(k for k in collected if k not in declared and k != "__goal_achieved__"),
        "final_state": turns[-1]["state_after"] if turns else None,
    }


async def main() -> None:
    out = Path(sys.argv[1])
    repeats = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    max_turns = int(sys.argv[3]) if len(sys.argv) > 3 else 16
    llm = LLMService()
    expert = ExpertConfig.from_dict(json.loads((ROOT / "agents/stella-v2-agent/config/experts/task_extraction.json").read_text()))
    plans = [coaching_plan(), next_step_plan()]
    jobs = [(plan, name) for plan in plans for name in PERSONAS for _ in range(repeats)]
    gate = asyncio.Semaphore(5)

    async def guarded(plan, name):
        async with gate:
            try:
                return await run_one(llm, expert, plan, name, max_turns)
            except Exception as error:      # one broken run must not lose the rest
                return {"plan": plan["id"], "persona": name, "failed": repr(error), "turns": []}

    runs = await asyncio.gather(*[guarded(plan, name) for plan, name in jobs])
    out.write_text(json.dumps(runs, indent=1, ensure_ascii=False))
    print(f"{len(runs)} runs -> {out}")


if __name__ == "__main__":
    asyncio.run(main())
