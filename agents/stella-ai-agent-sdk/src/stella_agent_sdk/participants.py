"""Who in a LiveKit room is a person.

Agents (``agent-*``), the message recorder and system participants share the
room with the people in the session. Everything else, including an organiser
who joins as ``human``, is a person.
"""

from __future__ import annotations

from typing import Iterable, List

#: Identity prefixes of participants that are not people.
NON_HUMAN_PREFIXES = ("agent-", "message-recorder", "system-")


def is_human_participant(identity: str) -> bool:
    """Whether ``identity`` belongs to a person rather than an agent or service."""
    return isinstance(identity, str) and bool(identity) and not identity.startswith(NON_HUMAN_PREFIXES)


def human_identities(identities: Iterable[str]) -> List[str]:
    """The people among ``identities``, in the order given."""
    return [i for i in identities if is_human_participant(i)]
