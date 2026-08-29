"""Emotion tags — the vocabulary the LLM writes, and the parser that removes it.

The LLM marks up its reply with inline tags::

    [playful] That's a good question. [thinking] Let me work through it.

Those tags must never be heard and never be seen: they are stripped before the
text reaches TTS *or* the published ``agent_text``, and what comes back in their
place is a list of cues carrying the character offset — into the STRIPPED text —
where each one lands. The frontend already runs a character cursor across that
same text in time with the audio (the teleprompter, #241), so a cue fires at
exactly the moment its word is spoken.

Everything here is pure and offset-exact, because the offsets are shared with
the teleprompter: a tag removed without adjusting them by the right amount would
desynchronize the word highlight from the voice for the rest of the message.

── Unknown tags ───────────────────────────────────────────────────────────────

An LLM will eventually write ``[smiles]`` or ``[laughs]`` no matter what the
prompt says. Three behaviors were possible and the choice is not obvious, so:

  * known tag      -> removed, emits a cue
  * tag-SHAPED but unknown (``[smiles]``, ``[pause]``) -> removed, no cue
  * anything else (``[1]``, ``[Fig. 2]``, ``[TODO]``)  -> left alone

The middle rule exists because the hard requirement is that tags are not
narrated, and a hallucinated tag read aloud as the word "smiles" is the exact
failure this feature is meant to prevent. The third rule is what keeps it safe:
requiring lowercase means citations and bracketed references survive untouched.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Dict, List, Tuple

logger = logging.getLogger(__name__)

#: Sustained expressions. Each one holds until the next cue or the end of the
#: message, then the face decays back to its resting idle.
EXPRESSION_TAGS: Tuple[str, ...] = (
    "neutral",
    "happy",
    "excited",
    "curious",
    "thinking",
    "surprised",
    "concerned",
    "sad",
    "playful",
    "laughing",
)

#: One-shot gestures. These play once over whatever expression is active and
#: then hand it back — they do not replace it.
GESTURE_TAGS: Tuple[str, ...] = (
    "nod",
    "wink",
    "brow_flash",
    "glance_away",
    "eye_roll",
    "lean_in",
)

#: tag name -> kind. THE wire contract with the frontend. The frontend keeps its
#: own registry of how each tag is drawn (eyebrow curve, mouth shape, duration)
#: — data this side has no business knowing — and is required to ignore a tag it
#: does not recognize, because the agent and the frontend deploy separately.
EMOTION_TAGS: Dict[str, str] = {
    **{tag: "expression" for tag in EXPRESSION_TAGS},
    **{tag: "gesture" for tag in GESTURE_TAGS},
}

#: Longest tag body we will consider. Also bounds how much text may be withheld
#: mid-stream waiting for a closing bracket — see ``strip_emotion_tags``.
_MAX_TAG_BODY = 24

#: Bracketed word: short, letter-led, no sentence punctuation. Matching is
#: deliberately WIDER than the decision to remove — what to do with a match is
#: decided below, per case.
_TAG_RE = re.compile(r"\[([A-Za-z][A-Za-z0-9_ -]{0,%d})\]" % (_MAX_TAG_BODY - 1))

#: A trailing, not-yet-closed tag: ``"...and then [thin"``, down to the bare
#: ``"["`` that opens it. The bare case is not an edge case — a chunk boundary
#: lands there once per tag on average, and NOT holding it publishes a "[" that
#: the next chunk then removes. Text that shrinks mid-stream is not cosmetic:
#: the sentence splitter treats a non-extending update as a new turn and speaks
#: the whole reply a second time.
_PARTIAL_RE = re.compile(r"\[(?:[A-Za-z][A-Za-z0-9_ -]{0,%d})?$" % (_MAX_TAG_BODY - 1))

#: An unknown match is only DROPPED when it is written the way a model writes a
#: stage direction: all lowercase. Case is what separates ``[smiles]``, which
#: must never be spoken, from ``[TODO]`` and ``[Fig 2]``, which are the author's
#: own text and must survive untouched. Known tags ignore case entirely — the
#: name has to be in a closed vocabulary to match at all, so there is nothing
#: for leniency to damage there.
_STAGE_DIRECTION_RE = re.compile(r"^[a-z][a-z0-9_ -]*$")


def _last_char(parts: List[str]) -> str:
    """Last character emitted so far, or "" at the start of the text."""
    for part in reversed(parts):
        if part:
            return part[-1]
    return ""


def _normalize(body: str) -> str:
    """``"Brow Flash"``, ``"brow-flash"``, ``"brow_flash"`` all name one tag."""
    return body.strip().lower().replace("-", "_").replace(" ", "_")


@dataclass(frozen=True)
class EmotionCue:
    """One tag, and where it lands in the stripped text."""

    #: Character offset into the STRIPPED text — the first character spoken
    #: under this cue. Shares its coordinate space with the teleprompter cursor.
    char: int
    tag: str
    kind: str

    def to_payload(self) -> Dict[str, object]:
        return {"char": self.char, "tag": self.tag, "kind": self.kind}


@dataclass(frozen=True)
class StripResult:
    """Text safe to speak and publish, plus the cues taken out of it."""

    text: str
    cues: List[EmotionCue]
    #: True when a trailing partial tag was withheld from ``text``. The caller
    #: gets it on the next chunk; nothing is lost.
    held: bool


def strip_emotion_tags(raw: str, *, allow_partial_hold: bool = True) -> StripResult:
    """Remove emotion tags from ``raw`` and report where they were.

    Pure and idempotent over the ACCUMULATED text: the caller re-runs it on the
    whole reply-so-far each chunk rather than trying to strip incrementally,
    which is what keeps a tag split across a chunk boundary from being missed.

    ``allow_partial_hold`` withholds a trailing unterminated ``[thin`` so a
    half-written tag never flashes on screen or reaches the synthesizer. It is
    bounded by ``_MAX_TAG_BODY`` and by the character class, so an ordinary
    unmatched bracket ("the array [ is empty") is never mistaken for one and
    cannot swallow the rest of the message. Pass False on the final chunk, where
    there is no next chunk to release it.
    """
    if not raw:
        return StripResult(text="", cues=[], held=False)

    body = raw
    held = False
    if allow_partial_hold:
        partial = _PARTIAL_RE.search(raw)
        if partial:
            body = raw[: partial.start()]
            held = True

    out: List[str] = []
    cues: List[EmotionCue] = []
    clean_len = 0
    pos = 0

    for match in _TAG_RE.finditer(body):
        segment = body[pos : match.start()]
        out.append(segment)
        clean_len += len(segment)

        name = _normalize(match.group(1))
        kind = EMOTION_TAGS.get(name)
        pos = restore_pos = match.end()

        # Whitespace repair. Removing a tag from between two spaces would leave
        # a double space — which TTS renders as a hesitation and which shifts
        # every subsequent offset by one. Drop the following space only when
        # what precedes the tag already ends in one (or nothing does).
        if pos < len(body) and body[pos] == " " and _last_char(out) in ("", " "):
            pos += 1

        if kind is not None:
            cues.append(EmotionCue(char=clean_len, tag=name, kind=kind))
        elif _STAGE_DIRECTION_RE.match(match.group(1)):
            # Not ours, but written like a stage direction. Removed rather than
            # spoken — see the module docstring for why this is the safer of the
            # two mistakes.
            logger.debug("Emotion tags: dropping unrecognized tag %r", match.group(0))
        else:
            # The author's own bracketed text ([TODO], [Fig 2]). Put it back and
            # undo the whitespace repair, which assumed a removal.
            out.append(match.group(0))
            clean_len += len(match.group(0))
            pos = restore_pos

    tail = body[pos:]
    out.append(tail)
    return StripResult(text="".join(out), cues=cues, held=held)
