"""What an expert's verdict leads to, as configuration (#194, #221).

Every verdict of every expert can carry the same rule fields, next to the
``action``/``template``/``description`` it already has in ``verdict_directives``:

- ``flag``: the verdict counts as a warning.
- ``tone``: the tone the reply should take.
- ``must_avoid``: lines the reply must not cross.
- ``reaction`` (one of ``REACTIONS``) and ``reaction_field``: what the agent
  does next, and which field of the expert's output holds the text for it.
- ``min_confidence`` and ``below``: how sure the agent must be of this verdict,
  and the verdict it steps down to when it isn't.
- ``overrides``: experts whose verdict this one wins over in a conflict.

An expert marked ``"safety": true`` (medical and legal by default) is a safety
expert. A configuration can't turn it off by omission, by ``enabled: false``
alone, or through an unfillable prompt placeholder: only a recorded
``safety_off`` entry does. Its ``never_step_down`` verdicts (``critical`` by
default) keep their level whatever ``min_confidence`` says.

Nothing here knows an expert by name: what differs between experts is in their
configuration. The platform owns the lists below; the backend keeps a copy in
``src/agent-package/manifest-defaults.ts`` that a test pins to this one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set

REACTIONS = ("none", "ask_followup", "redirect", "ask_about_pending", "ask_back", "repeat_request")

RULE_FIELDS = ("flag", "tone", "must_avoid", "reaction", "reaction_field", "min_confidence", "below", "overrides")

#: Verdicts a safety expert never steps down when its file doesn't name its own.
DEFAULT_NEVER_STEP_DOWN = ("critical",)


# ---------------------------------------------------------------------------
# Merging a saved configuration onto the expert's defaults
# ---------------------------------------------------------------------------


def merge_verdict_directives(
    defaults: Optional[Mapping[str, Any]], saved: Optional[Mapping[str, Any]]
) -> Dict[str, Dict[str, Any]]:
    """The expert's verdicts with a saved configuration laid over them, field by field.

    A saved verdict replaces only the fields it names, so a configuration saved
    before a field existed still gets that field's default. A verdict only the
    saved configuration has is kept as it is. Entries that aren't objects are
    ignored on either side.
    """
    merged: Dict[str, Dict[str, Any]] = {}
    for verdict, rule in (defaults or {}).items():
        if isinstance(rule, Mapping):
            merged[str(verdict)] = dict(rule)
    for verdict, rule in (saved or {}).items():
        if isinstance(rule, Mapping):
            merged[str(verdict)] = {**merged.get(str(verdict), {}), **rule}
    return merged


# ---------------------------------------------------------------------------
# What an agent supports, and checking rules against it
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VerdictRuleSupport:
    """What an agent's arbitration step declares it acts on."""

    reactions: Sequence[str] = ()
    fields: Sequence[str] = ()

    @staticmethod
    def from_declaration(value: Any) -> "VerdictRuleSupport":
        """From the ``verdict_rules`` entry of a pipeline node (``{reactions, fields}``)."""
        if not isinstance(value, Mapping):
            return VerdictRuleSupport()
        reactions = [str(r) for r in value.get("reactions") or [] if isinstance(r, str)]
        fields = [str(f) for f in value.get("fields") or [] if isinstance(f, str)]
        if reactions and "reaction" not in fields:
            fields.append("reaction")  # declaring reactions means acting on the field that names one
        return VerdictRuleSupport(tuple(reactions), tuple(fields))


def check_verdict_rules(
    expert: str, directives: Mapping[str, Any], support: VerdictRuleSupport
) -> List[str]:
    """Why these verdict rules can't run on this agent, one line each; empty when they can.

    Refused: a reaction that isn't one of ``REACTIONS``, or that the agent didn't
    declare; a rule field the agent didn't declare; a ``min_confidence`` outside
    0..1; a ``below`` that isn't one of the expert's verdicts; a value of the
    wrong type. The same checks as the platform's ``checkVerdictRules``.
    """
    problems: List[str] = []
    verdicts = set(directives)
    for verdict, rule in directives.items():
        if not isinstance(rule, Mapping):
            continue
        where = f'expert "{expert}" verdict "{verdict}"'
        for field in RULE_FIELDS:
            if field in rule and field not in support.fields:
                problems.append(f'{where}: this agent does not act on "{field}"')
        reaction = rule.get("reaction")
        if reaction is not None:
            if not isinstance(reaction, str) or reaction not in REACTIONS:
                problems.append(f'{where}: unknown reaction "{reaction}" (valid: {", ".join(REACTIONS)})')
            elif reaction not in support.reactions and reaction != "none":
                problems.append(f'{where}: this agent does not support the reaction "{reaction}"')
        confidence = rule.get("min_confidence")
        if confidence is not None and (
            isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1
        ):
            problems.append(f"{where}: min_confidence must be a number from 0 to 1")
        below = rule.get("below")
        if below is not None and (not isinstance(below, str) or below not in verdicts):
            problems.append(f'{where}: below "{below}" is not one of this expert\'s verdicts')
        if "flag" in rule and not isinstance(rule["flag"], bool):
            problems.append(f"{where}: flag must be true or false")
        for name in ("must_avoid", "overrides"):
            value = rule.get(name)
            if value is not None and not (isinstance(value, list) and all(isinstance(v, str) for v in value)):
                problems.append(f"{where}: {name} must be a list of texts")
        for name in ("tone", "reaction_field"):
            if rule.get(name) is not None and not isinstance(rule[name], str):
                problems.append(f"{where}: {name} must be text")
    return problems


# ---------------------------------------------------------------------------
# Stepping a verdict down when the agent isn't sure enough
# ---------------------------------------------------------------------------


def settle_verdict(
    choice: str,
    probabilities: Mapping[str, float],
    directives: Mapping[str, Any],
    never_step_down: Iterable[str] = (),
) -> str:
    """The verdict to act on, given how sure the agent is of each.

    A verdict with ``min_confidence`` holds when its weight, with the weight of
    the verdicts already stepped past, reaches that number; otherwise it steps
    to its ``below`` and tries again. A verdict without ``min_confidence``, one
    in ``never_step_down``, or one whose ``below`` is missing or loops, holds.
    """
    keep = set(never_step_down)
    weight = 0.0
    seen: Set[str] = set()
    current = choice
    while True:
        seen.add(current)
        weight += float(probabilities.get(current, 0.0))
        rule = directives.get(current)
        if current in keep or not isinstance(rule, Mapping):
            return current
        threshold = rule.get("min_confidence")
        below = rule.get("below")
        if threshold is None or weight >= float(threshold) or not below or below in seen:
            return current
        current = str(below)


# ---------------------------------------------------------------------------
# The safety floor
# ---------------------------------------------------------------------------


def is_safety_expert(expert_defaults: Mapping[str, Any]) -> bool:
    return expert_defaults.get("safety") is True


def never_step_down(expert_defaults: Mapping[str, Any]) -> Sequence[str]:
    """The verdicts a safety expert keeps whatever the confidence; none for any other expert."""
    if not is_safety_expert(expert_defaults):
        return ()
    declared = expert_defaults.get("never_step_down")
    if isinstance(declared, list) and all(isinstance(v, str) for v in declared):
        return tuple(declared)
    return DEFAULT_NEVER_STEP_DOWN


def safety_switched_off(saved: Optional[Mapping[str, Any]]) -> bool:
    """A configuration turned a safety expert off only with a recorded, confirmed ``safety_off``."""
    if not isinstance(saved, Mapping):
        return False
    record = saved.get("safety_off")
    return isinstance(record, Mapping) and record.get("confirmed") is True


def expert_enabled(expert_defaults: Mapping[str, Any], saved: Optional[Mapping[str, Any]]) -> bool:
    """Whether an expert runs, given its defaults and the saved configuration's entry for it.

    A safety expert runs unless the configuration recorded ``safety_off``;
    ``enabled: false`` alone doesn't stop it. Any other expert follows the
    configuration's ``enabled``, else its own.
    """
    if is_safety_expert(expert_defaults):
        return not safety_switched_off(saved)
    if isinstance(saved, Mapping) and isinstance(saved.get("enabled"), bool):
        return bool(saved["enabled"])
    return expert_defaults.get("enabled", True) is not False


def may_drop_for(expert_defaults: Mapping[str, Any], saved: Optional[Mapping[str, Any]]) -> bool:
    """Whether a runtime problem with the expert (such as a prompt placeholder the
    session can't fill) may switch it off. Never for a safety expert still on."""
    return not is_safety_expert(expert_defaults) or safety_switched_off(saved)


# ---------------------------------------------------------------------------
# Gates: skip one expert when another says something
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Gate:
    """Skip ``skip`` when ``when`` says one of ``verdicts`` at least ``min_confidence`` sure."""

    skip: str
    when: str
    verdicts: Sequence[str]
    min_confidence: float = 0.0

    @staticmethod
    def parse(value: Any) -> Optional["Gate"]:
        if not isinstance(value, Mapping):
            return None
        skip, when, verdicts = value.get("skip"), value.get("when"), value.get("verdicts")
        if not isinstance(skip, str) or not isinstance(when, str) or not isinstance(verdicts, list):
            return None
        confidence = value.get("min_confidence", 0.0)
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            return None
        return Gate(skip, when, tuple(str(v) for v in verdicts), float(confidence))


def gated_experts(gates: Iterable[Gate], said: Mapping[str, tuple]) -> Set[str]:
    """The experts to skip, given ``{expert: (verdict, confidence)}`` already in."""
    skipped: Set[str] = set()
    for gate in gates:
        verdict = said.get(gate.when)
        if verdict and verdict[0] in gate.verdicts and float(verdict[1]) >= gate.min_confidence:
            skipped.add(gate.skip)
    return skipped
