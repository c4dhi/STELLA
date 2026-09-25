"""Agent and frontend must agree on the emotion-tag vocabulary (#face-emotions).

The two halves deploy separately and each owns a different half of the contract:
this package owns WHICH tags exist, and the frontend registry owns how each one
is drawn. Neither can import the other, so drift is possible — and it is silent.
A tag added here but missing there is dropped by the client's fallback and the
face simply never makes that expression, with nothing in any log to explain it.

Reading the frontend file is the only thing that actually catches that, so this
test does. It skips when the frontend is not checked out beside the SDK, so the
package stays independently installable.
"""

import re
from pathlib import Path

import pytest

from stella_agent_sdk.emotion.tags import EXPRESSION_TAGS, GESTURE_TAGS, STATE_TAGS

_REGISTRY = (
    Path(__file__).resolve().parents[3]
    / "frontend-ui/src/components/face/animations/emotionRegistry.ts"
)


def _tags(source: str, const_name: str) -> set:
    """Pull the keys out of one `export const NAME: Record<...> = { ... }` block."""
    match = re.search(
        rf"export const {const_name}[^=]*=\s*\{{(.*?)\n\}};", source, re.DOTALL
    )
    assert match, f"{const_name} not found in the frontend registry"
    return set(re.findall(r"^\s{2}([a-z_]+):", match.group(1), re.MULTILINE))


@pytest.fixture(scope="module")
def registry_source():
    if not _REGISTRY.exists():
        pytest.skip(f"frontend registry not present at {_REGISTRY}")
    return _REGISTRY.read_text()


def test_expressions_match_the_frontend_registry(registry_source):
    assert _tags(registry_source, "EXPRESSIONS") == set(EXPRESSION_TAGS)


def test_gestures_match_the_frontend_registry(registry_source):
    assert _tags(registry_source, "GESTURES") == set(GESTURE_TAGS)


def test_states_match_the_frontend_registry(registry_source):
    """`[sleep]` is the one tag whose drift the user cannot work around.

    An expression the client has never heard of is a face that does not react,
    which is invisible. A state tag that goes missing means the agent is asked
    to go to sleep, says goodnight, and simply stays awake — and there is no
    second way to ask.
    """
    match = re.search(r"export const STATES = \[(.*?)\] as const;", registry_source, re.DOTALL)
    assert match, "STATES not found in the frontend registry"
    assert set(re.findall(r"'([a-z_]+)'", match.group(1))) == set(STATE_TAGS)
