import json

import pytest

from elias_interviewer.checker import ANSWERED, DECLINED, UNCLEAR, AnswerChecker, Verdict
from elias_interviewer.guide import TRANSCRIPT_ID_KEY, GuideError, build_plan, parse_guide, resume_point
from elias_interviewer.interview import ANSWER, REASK, SKIP, Interview

from fakes import GUIDE

# The real guide shape ELIAS returned for "Madeleine wills wissen" on 2026-11-05.
REAL_GUIDE = {
    "id": "a70e018e",
    "project_id": "954c1a87",
    "questions": [
        {"question": "What went through your mind when you were told you have type 2 diabetes?", "category": "Diagnosis", "order": 1, "subquestions": None},
        {"question": "What did you know or think about diabetes before your diagnosis?", "category": "Diagnosis", "order": 2, "subquestions": None},
        {"question": "What has changed in your daily routine since your diagnosis?", "category": "Everyday life", "order": 3, "subquestions": None},
        {"question": "What is the hardest part of managing diabetes in a normal day?", "category": "Everyday life", "order": 4, "subquestions": None},
        {"question": "Tell me about a moment when managing your diabetes went well.", "category": "Everyday life", "order": 5, "subquestions": None},
        {"question": "Who or what has helped you most in living with diabetes?", "category": "Support", "order": 6, "subquestions": None},
        {"question": "What kind of help or information do you wish you had received?", "category": "Support", "order": 7, "subquestions": None},
    ],
}


def test_real_guide_becomes_seven_questions_in_three_stages():
    qs = parse_guide(REAL_GUIDE)
    assert [q.order for q in qs] == [1, 2, 3, 4, 5, 6, 7]
    plan = build_plan(qs, project_id="954c1a87")
    assert [s["title"] for s in plan["states"]] == ["Diagnosis", "Everyday life", "Support"]
    assert [len(s["tasks"]) for s in plan["states"]] == [2, 3, 2]
    assert plan["initial_state_id"] == plan["states"][0]["id"]
    assert [s["transitions"][0]["target_state_id"] for s in plan["states"]] == [
        plan["states"][1]["id"], plan["states"][2]["id"], "__end__"]
    first = plan["states"][0]["tasks"][0]
    assert first["description"] == REAL_GUIDE["questions"][0]["question"]
    keys = {d["key"]: d["required"] for d in first["deliverables"]}
    assert keys == {"q1_answer": True, TRANSCRIPT_ID_KEY: False}
    json.dumps(plan)  # must be plain JSON for the state machine


def test_a_guide_that_returns_to_a_category_gets_a_state_per_run_in_question_order():
    # A, B, A: one state per category would put the second A question in the
    # first state, so completing it while the plan is in the third fails.
    qs = parse_guide({"questions": [
        {"question": "a1", "category": "A", "order": 1},
        {"question": "b1", "category": "B", "order": 2},
        {"question": "a2", "category": "A", "order": 3},
        {"question": "a3", "category": "A", "order": 4},
    ]})
    plan = build_plan(qs, project_id="p")
    assert [(s["id"], [t["id"] for t in s["tasks"]]) for s in plan["states"]] == [
        ("s1_a", ["q1"]), ("s2_b", ["q2"]), ("s3_a", ["q3", "q4"])]
    assert [s["transitions"][0]["target_state_id"] for s in plan["states"]] == ["s2_b", "s3_a", "__end__"]


def test_guide_order_wins_over_list_order_and_blank_questions_are_dropped():
    qs = parse_guide({"questions": [
        {"question": "B", "category": "X", "order": 2},
        {"question": "  ", "category": "X", "order": 3},
        {"question": "A", "category": "X", "order": 1},
    ]})
    assert [q.text for q in qs] == ["A", "B"]


@pytest.mark.parametrize("guide", [{}, {"questions": []}, {"questions": [{"question": ""}]}, None])
def test_empty_guide_is_an_error(guide):
    with pytest.raises(GuideError):
        parse_guide(guide)


def test_resume_point_skips_done_questions_and_finds_transcript():
    qs = parse_guide(GUIDE)
    state = {"states": [{"tasks": [
        {"id": "q1", "status": "completed", "deliverables": [{"key": TRANSCRIPT_ID_KEY, "value": "t9"}]},
        {"id": "q2", "status": "skipped", "deliverables": []},
        {"id": "q3", "status": "pending", "deliverables": []},
    ]}]}
    assert resume_point(qs, state) == {"next_index": 2, "transcript_id": "t9"}
    assert resume_point(qs, None) == {"next_index": 0, "transcript_id": None}


def _iv(max_attempts=3):
    return Interview(parse_guide(GUIDE), max_attempts=max_attempts)


def test_interview_three_asks_then_skip():
    iv = _iv()
    for expected in (REASK, REASK, SKIP):
        iv.mark_asked()
        iv.add_reply("hm")
        assert iv.resolve(Verdict(UNCLEAR)).kind == expected
    assert iv.index == 1 and iv.attempts == 0 and iv.replies == []


def test_interview_answer_and_decline():
    iv = _iv()
    iv.mark_asked(); iv.add_reply("yes")
    step = iv.resolve(Verdict(ANSWERED))
    assert step.kind == ANSWER and step.answer == "yes"
    iv.mark_asked(); iv.add_reply("rather not")
    assert iv.resolve(Verdict(DECLINED)).kind == SKIP
    assert iv.remaining == 1


def test_max_attempts_one_never_reasks():
    iv = _iv(max_attempts=1)
    iv.mark_asked(); iv.add_reply("hm")
    assert iv.resolve(Verdict(UNCLEAR)).kind == SKIP


@pytest.mark.asyncio
async def test_checker_parses_verdict_and_passes_question_and_replies():
    seen = {}

    async def completer(system, user):
        seen["user"] = user
        return json.dumps({"verdict": "Unclear", "reason": "off topic"})

    v = await AnswerChecker(completer).check("Q?", ["one", "two"])
    assert v == Verdict(UNCLEAR, "off topic")
    assert "Q?" in seen["user"] and "- one" in seen["user"] and "- two" in seen["user"]


@pytest.mark.asyncio
@pytest.mark.parametrize("reply", ["not json", json.dumps({"verdict": "maybe"})])
async def test_checker_fails_open(reply):
    async def completer(system, user):
        return reply

    v = await AnswerChecker(completer).check("Q?", ["x"])
    assert v.outcome == ANSWERED and v.fallback


@pytest.mark.asyncio
async def test_checker_fails_open_on_exception():
    async def completer(system, user):
        raise TimeoutError("slow")

    assert (await AnswerChecker(completer).check("Q?", ["x"])).fallback
