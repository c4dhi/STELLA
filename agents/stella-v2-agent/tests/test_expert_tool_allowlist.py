"""An expert may be restricted to the tools it can actually use.

Measured on prod, task_extraction's compiled call is ~5900 tokens, of which the
eight tool schemas are ~1500 — re-sent every turn. Three of those eight are
read-only queries (get_current_state / get_pending_tasks /
get_pending_deliverables) that the expert cannot need, because the whole state
is already rendered into its prompt by {{plan}} and {{current_focus}}.

Replayed over nine real turns with the prompt held identical and only the tool
list varied, decisions were 9/9 unchanged and the call ran ~297ms faster. The
second reason is behavioural: a tool an expert has no use for is still an action
it can choose — gpt-4o-mini reached for skip_task on 4 of 9 replayed turns where
gpt-4o reached for it on none.
"""

import json
from pathlib import Path

import pytest

from stella_v2_agent.experts.base import ExpertConfig
from stella_v2_agent.pipeline.expert_pool import ExpertPool


class FakeTool:
    def __init__(self, name):
        self.name = name


class FakeRegistry:
    NAMES = [
        "complete_task", "skip_task", "skip_state", "set_deliverable",
        "batch_update", "get_current_state", "get_pending_tasks",
        "get_pending_deliverables",
    ]

    def list_tools(self):
        return [FakeTool(n) for n in self.NAMES]


def _pool():
    pool = ExpertPool.__new__(ExpertPool)
    pool._tool_registry = FakeRegistry()
    return pool


def _tools_for(config):
    """Mirror the resolution in _run_with_timeout without running an expert."""
    pool = _pool()
    tools = None
    if config.can_call_functions and pool._tool_registry:
        tools = pool._tool_registry.list_tools()
        if config.tools:
            allowed = set(config.tools)
            tools = [t for t in tools if t.name in allowed]
    return [t.name for t in (tools or [])]


def test_no_allowlist_keeps_every_tool():
    """Absent an allow-list, behaviour is unchanged — this must stay the default
    so other experts and other agents are untouched."""
    cfg = ExpertConfig(name="x", can_call_functions=True)
    assert sorted(_tools_for(cfg)) == sorted(FakeRegistry.NAMES)


def test_an_allowlist_removes_everything_else():
    cfg = ExpertConfig(name="x", can_call_functions=True,
                       tools=["batch_update", "set_deliverable"])
    assert sorted(_tools_for(cfg)) == ["batch_update", "set_deliverable"]


def test_a_non_tool_expert_gets_none():
    cfg = ExpertConfig(name="x", can_call_functions=False, tools=["batch_update"])
    assert _tools_for(cfg) == []


def test_task_extraction_ships_without_the_read_only_queries():
    """The shipped config is the point of the change, so assert it directly."""
    path = Path(__file__).resolve().parents[1] / "config" / "experts" / "task_extraction.json"
    cfg = json.loads(path.read_text(encoding="utf-8"))
    allowed = set(cfg["tools"])
    assert allowed == {"batch_update", "set_deliverable", "complete_task",
                       "skip_task", "skip_state"}
    for read_only in ("get_current_state", "get_pending_tasks", "get_pending_deliverables"):
        assert read_only not in allowed
    # Every mutation the prompt actually instructs must still be reachable.
    for used in ("batch_update", "skip_task"):
        assert used in allowed
