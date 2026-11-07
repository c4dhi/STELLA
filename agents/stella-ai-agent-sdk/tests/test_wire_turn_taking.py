"""run.py wires barge-in and take-back from what an agent declares, independently."""

from stella_agent_sdk.run import wire_turn_taking


class _Pipe:
    def __init__(self, barge_in_allowed=True):
        self.barge_in_allowed = barge_in_allowed
        self.barge_in_enabled = False
        self.decider = None
        self.take_back_ms = None

    def enable_barge_in(self):
        self.barge_in_enabled = self.barge_in_allowed

    def set_barge_in_decider(self, decider):
        self.decider = decider

    def enable_take_back(self, window_ms):
        self.take_back_ms = window_ms


class _Agent:
    def __init__(self, **attrs):
        self.__dict__.update(attrs)

    async def on_barge_in(self, session_id, transcript):
        return None


def test_barge_in_without_take_back_still_gets_its_decider():
    # STELLA V2: supports barge-in, no take-back. It lost its decider once (PR 878 review).
    pipe = _Pipe()
    wire_turn_taking(_Agent(supports_barge_in=True), pipe, "s")
    assert pipe.decider is not None and pipe.take_back_ms is None


def test_take_back_is_turned_on_only_by_its_window():
    pipe = _Pipe()
    wire_turn_taking(_Agent(supports_barge_in=True, take_back_window_ms=6000), pipe, "s")
    assert pipe.decider is not None and pipe.take_back_ms == 6000


def test_barge_in_switched_off_gets_no_decider():
    pipe = _Pipe(barge_in_allowed=False)
    wire_turn_taking(_Agent(supports_barge_in=True), pipe, "s")
    assert pipe.decider is None


def test_an_agent_without_barge_in_gets_neither():
    pipe = _Pipe()
    wire_turn_taking(_Agent(), pipe, "s")
    assert pipe.decider is None and pipe.take_back_ms is None and not pipe.barge_in_enabled
