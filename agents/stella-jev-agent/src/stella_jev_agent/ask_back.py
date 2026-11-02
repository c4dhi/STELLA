"""When the agent may ask back, and what it tells the reply model to do."""

ASK_BACK_INSTRUCTION = (
    "You may have misheard the user's last message. Ask only whether you heard it right, as "
    "a problem with your own hearing, in one short sentence. If it makes sense as a sentence, "
    "say what you understood and ask if that is right. If it is garbled, or sounds like "
    "something nobody would say to you here, such as a caption or a sign-off, do not repeat "
    "it: say you did not catch that and ask them to say it again. Do not react to what they "
    "said, do not correct them, do not continue the plan and ask nothing else. Use the "
    "conversation's language and the same form of address as before."
)

AFTER_ASK_BACK_INSTRUCTION = (
    "You just asked whether you heard them right, and this message is their answer. Take it "
    "as true, whatever it is. Do not comment on how likely it is, do not compare it with what "
    "you heard before and do not ask about it again. Carry on with the conversation."
)


class AskBack:
    """Asks at most once per statement and a fixed number of times per session."""

    def __init__(self, max_per_session: int = 3):
        self.max_per_session = max_per_session
        self.count = 0
        # This turn's reply has to ask back. Taken by the reply stage, so that a
        # later turn the agent opens itself is not written as a question.
        self.now = False
        self._asked_last_turn = False
        self._answering = False

    def decide(self, wanted: bool) -> bool:
        """Settle this turn. The turn after a question is its answer, so it never asks."""
        allowed = wanted and not self._asked_last_turn and self.count < self.max_per_session
        self._answering = self._asked_last_turn
        self.now = self._asked_last_turn = allowed
        if allowed:
            self.count += 1
        return allowed

    def take(self) -> bool:
        now, self.now = self.now, False
        return now

    def take_answer(self) -> bool:
        """Whether this turn answers the question the agent asked last turn."""
        answering, self._answering = self._answering, False
        return answering
