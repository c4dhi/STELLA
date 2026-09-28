from datetime import datetime, timedelta, timezone

from stella_v2_agent.pipeline.history_scope import (
    ActivitySegment,
    parse_timestamp,
    scope_history,
)

T0 = datetime(2026, 9, 26, 1, 0, tzinfo=timezone.utc)


def at(minutes):
    return T0 + timedelta(minutes=minutes)


def entry(role, content, minutes):
    return {"role": role, "content": content, "at": at(minutes)}


TRANSCRIPT = [
    entry("user", "hi", 0),
    entry("assistant", "hello", 1),
    entry("user", "let's do the study", 2),
    entry("assistant", "what is your nickname?", 3),  # inside the activity
    entry("user", "Fee", 4),                          # inside
    entry("user", "stop", 5),                         # inside
    entry("assistant", "ok, we can just chat", 7),    # after it ended
]
SEGMENT = ActivitySegment("Study", started_at=at(2.5), ended_at=at(6), collected={"nickname": "Fee"})


def test_free_conversation_replaces_a_finished_activity_with_one_line():
    scoped = scope_history(TRANSCRIPT, [SEGMENT], active_since=None)
    assert scoped == [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
        {"role": "user", "content": "let's do the study"},
        {"role": "system", "content": 'Activity "Study" ended. Collected: nickname = Fee.'},
        {"role": "assistant", "content": "ok, we can just chat"},
    ]


def test_note_without_collected_values_is_just_the_title():
    bare = ActivitySegment("Study", at(2.5), at(6))
    scoped = scope_history(TRANSCRIPT, [bare], active_since=None)
    assert {"role": "system", "content": 'Activity "Study" ended.'} in scoped


def test_inside_an_activity_only_its_own_turns_are_visible():
    scoped = scope_history(TRANSCRIPT[:5], [], active_since=at(2.5))
    assert [m["content"] for m in scoped] == ["what is your nickname?", "Fee"]


def test_restarted_activity_does_not_see_the_previous_run():
    first = SEGMENT
    transcript = TRANSCRIPT + [
        entry("user", "again please", 10),
        entry("assistant", "sure, what is your nickname?", 12),
    ]
    scoped = scope_history(transcript, [first], active_since=at(11))
    assert [m["content"] for m in scoped] == ["sure, what is your nickname?"]


def test_no_activity_history_is_unchanged():
    scoped = scope_history(TRANSCRIPT, [], active_since=None)
    assert [m["content"] for m in scoped] == [e["content"] for e in TRANSCRIPT]


def test_entries_without_a_timestamp_are_kept():
    scoped = scope_history([{"role": "user", "content": "x", "at": None}], [SEGMENT], None)
    assert scoped == [{"role": "user", "content": "x"}]


def test_parse_timestamp_handles_z_and_garbage():
    assert parse_timestamp("2026-09-26T01:00:00Z") == T0
    assert parse_timestamp("nope") is None
    assert parse_timestamp(None) is None
