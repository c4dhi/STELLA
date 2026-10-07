"""The head start before each sentence is chosen from what synthesis actually does.

Rule under test (docs-site tts-pipeline.md): pre-roll >= D * (RTF - 1) / RTF for
a sentence of D ms, so playback never overtakes synthesis.
"""

from stella_agent_sdk.audio.preroll import PrerollController


def test_explicit_value_is_never_changed():
    c = PrerollController(fixed_ms=800)
    c.observe(audio_ms=4000, synth_ms=9000, bridged_ms=500)
    assert c.current_ms == 800
    assert c.fixed


def test_starts_at_the_floor_before_anything_is_measured():
    assert PrerollController().current_ms == 200


def test_fast_gpu_stays_at_the_floor():
    c = PrerollController()
    for _ in range(10):
        c.observe(audio_ms=4000, synth_ms=3000, bridged_ms=0)  # RTF 0.75
    assert c.current_ms == 200


def test_slow_gpu_gets_a_head_start_from_its_rtf():
    c = PrerollController()
    for _ in range(10):
        c.observe(audio_ms=4000, synth_ms=6000, bridged_ms=0)  # RTF 1.5
    # 4000 * (1 - 1/1.5) = 1333ms of unavoidable shortfall, plus margin.
    assert 1333 <= c.current_ms <= 2200


def test_never_exceeds_the_cap():
    c = PrerollController(max_ms=3000)
    for _ in range(10):
        c.observe(audio_ms=6000, synth_ms=30000, bridged_ms=0)  # RTF 5
    assert c.current_ms == 3000


def test_starvation_raises_it_at_once_even_when_rtf_says_fine():
    c = PrerollController()
    c.observe(audio_ms=4000, synth_ms=3000, bridged_ms=240)
    assert c.current_ms >= 400


def test_lowers_slowly_and_not_on_every_wobble():
    c = PrerollController()
    for _ in range(10):
        c.observe(audio_ms=4000, synth_ms=6000, bridged_ms=0)
    high = c.current_ms
    c.observe(audio_ms=4000, synth_ms=3000, bridged_ms=0)  # one good sentence
    assert c.current_ms >= high * 0.9 - 1  # at most one small step down
    for _ in range(30):
        c.observe(audio_ms=4000, synth_ms=3000, bridged_ms=0)
    assert c.current_ms == 200


def test_very_short_utterances_do_not_move_the_estimate():
    c = PrerollController()
    c.observe(audio_ms=300, synth_ms=900, bridged_ms=0)  # RTF 3, but a blip
    assert c.current_ms == 200
