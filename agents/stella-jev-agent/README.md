# STELLA Jev Agent

STELLA V2's turn with four stages swapped, in `src/stella_jev_agent/`:

| Stage | Here |
|---|---|
| Bridge | None. Nothing is said before the experts have decided |
| Experts | One Jev call for `common_sense`, `medical`, `legal`, `probing` and `timekeeper` |
| `task_extraction`, `companion_router` | Still language models, because they write values or call tools. They run after Jev and only when Jev says there may be something to do |
| Reply | gpt-5.4-mini, as in V2, plus a forced question when something does not fit |
| Barge-in | Jev |

When a message does not fit, the agent asks back and saves nothing that turn. It asks
at most once per statement and three times per session. A medical `critical` always wins.

If Jev cannot be reached, the experts run on the language model using the prompts in
`config/experts/`, and barge-in stops for the person.

Needs `TYPESAFE_API_KEY` as well as V2's environment. A session will not start without it.

## Evals

`evals/` uses only the hand-written text in `common_sense_cases.py`:

```bash
python evals/run_common_sense.py --split dev    # the judgements, with Jev only
python evals/run_turns.py --agent jev           # real turns with stand-in backend, timed
python evals/run_turns.py --agent v2            # the same turns on V2
```

Tune on `dev` and keep `holdout` for a final check.

`run_next_step.py` scores which task Jev picks and where it says the plan goes, on `next_step_cases.py`
(the German Focus Group plan, passed with `--plan`, and a plan with value branches). `--timed` also times the
first word with and without waiting for extraction.
