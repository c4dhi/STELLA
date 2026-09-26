import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from analysis import Criteria, LevelResult, find_capacity, percentile, playout_starvation


def summary(sessions, final_ms=500.0, ttfa_ms=300.0, starved=0.0, errors=0, utt=10, missed=0):
    r = LevelResult(sessions=sessions)
    r.stt_final_s = [final_ms / 1000.0] * utt
    r.stt_utterances = utt
    r.stt_finals_missed = missed
    r.tts_ttfa_s = [ttfa_ms / 1000.0] * 5
    r.tts_audio_s = 100.0
    r.tts_starved_s = starved
    r.errors = errors
    return r.summary()


def test_percentile_nearest_rank():
    assert percentile([], 95) is None
    assert percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50) == 5
    assert percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95) == 10
    assert percentile([7], 95) == 7


def test_starvation_is_zero_when_chunks_arrive_ahead_of_playback():
    # 4 x 1 s of audio arriving every 0.5 s: always ahead.
    assert playout_starvation([(0.0, 1.0), (0.5, 1.0), (1.0, 1.0), (1.5, 1.0)]) == (0.0, 4.0)


def test_starvation_counts_the_gap_when_the_buffer_runs_dry():
    # 1 s of audio, next chunk 3 s after the first arrived: 2 s of silence.
    starved, audio = playout_starvation([(0.0, 1.0), (3.0, 1.0)])
    assert starved == 2.0 and audio == 2.0


def test_preroll_absorbs_a_short_stall():
    # 0.5 s chunks, one arriving 0.3 s late: 0.6 s of pre-roll rides it out, none does not.
    chunks = [(0.0, 0.5), (0.5, 0.5), (1.3, 0.5), (1.5, 0.5)]
    assert playout_starvation(chunks, preroll_s=0.0)[0] > 0
    assert playout_starvation(chunks, preroll_s=0.6)[0] == 0.0


def test_a_baseline_that_already_stutters_gives_zero_capacity():
    cap = find_capacity([summary(1, starved=50.0), summary(2)], Criteria())
    assert cap["sessions"] == 0
    assert "starved" in cap["limited_by"][0]


def test_capacity_is_highest_passing_level():
    levels = [summary(1), summary(2), summary(4, final_ms=900), summary(6, final_ms=3000)]
    cap = find_capacity(levels, Criteria())
    assert cap["sessions"] == 4
    assert "speech recognition" in cap["limited_by"][0]


def test_capacity_stops_at_first_failure_even_if_a_later_level_passes():
    levels = [summary(1), summary(2, starved=20.0), summary(4)]
    cap = find_capacity(levels, Criteria())
    assert cap["sessions"] == 1
    assert "starved" in cap["limited_by"][0]


def test_missing_finals_and_errors_fail_a_level():
    assert find_capacity([summary(1), summary(2, missed=1)], Criteria())["sessions"] == 1
    assert find_capacity([summary(1), summary(2, errors=3)], Criteria())["sessions"] == 1


def test_every_level_passing_gives_the_top_level():
    cap = find_capacity([summary(1), summary(2), summary(4)], Criteria())
    assert cap == {"sessions": 4, "limited_by": []}
