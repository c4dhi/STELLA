"""Who in a LiveKit room is a person, and who is the session's participant.

Agents (``agent-*``), the message recorder and system participants share the
room with the people in the session. Everything else, including an organiser
who joins as ``human``, is a person.

The session's participants are the people STELLA let in for the session: an
invitation link, a public project or a manual registration. They all join as
``participant-*``. An organiser watching from the session page is a person but
not a participant, so an agent that speaks first waits for a participant.
"""

from __future__ import annotations

from typing import Iterable, List

#: Identity prefixes of participants that are not people.
NON_HUMAN_PREFIXES = ("agent-", "message-recorder", "system-")

#: Identity prefix STELLA gives every session participant.
SESSION_PARTICIPANT_PREFIX = "participant-"


def is_human_participant(identity: str) -> bool:
    """Whether ``identity`` belongs to a person rather than an agent or service."""
    return isinstance(identity, str) and bool(identity) and not identity.startswith(NON_HUMAN_PREFIXES)


def human_identities(identities: Iterable[str]) -> List[str]:
    """The people among ``identities``, in the order given."""
    return [i for i in identities if is_human_participant(i)]


def is_session_participant(identity: str) -> bool:
    """Whether ``identity`` is a participant of the session, not an organiser watching."""
    return isinstance(identity, str) and identity.startswith(SESSION_PARTICIPANT_PREFIX)


def session_participants(identities: Iterable[str]) -> List[str]:
    """The session's participants among ``identities``, in the order given."""
    return [i for i in identities if is_session_participant(i)]
