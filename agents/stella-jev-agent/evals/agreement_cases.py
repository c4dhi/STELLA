"""Hand-written turns where Jev and task_extraction can disagree. No participant data.

Shaped like next_step_cases, plus:
  done     values of the tasks already collected in this state, by task
  history  the conversation before the latest message, when one question is not enough
  task     which task the message takes care of, by hand. ("fix", task) is a correction
           of a collected task. None: nothing to record. A tuple: any of these is fine.
  also     the other tasks it settles along the way: mentioned in passing, or ("fix", task)
           for an earlier answer it corrects. Only labelled where it matters.
"""

from next_step_cases import (
    BEWEGUNG, CHECKIN, EINSTIEG, HUERDEN, PLAUDEREI, SCHOENES, SPAZIER, VORSTELLUNG, WASSER, WETTER, WOCHE,
)

GREETING = (
    "Hallo, ich bin Grace. Heute ist Dienstag, der siebzehnte November, und wir plaudern einfach "
    "ein paar Minuten locker miteinander. Wie darf ich dich nennen?"
)


def _case(state, open_tasks, asked, said, task, done=None, history=None, also=None):
    case = {"state": state, "open": open_tasks, "asked": asked, "said": said, "task": task, "goes_to": None}
    if also is not None:
        case["also"] = also
    if done:
        case["done"] = done
    if history:
        case["history"] = [{"role": r, "content": c} for r, c in history]
    return case


CASES = [
    # The first study session: Jev was unsure about a plain name.
    _case("Vorstellung", [VORSTELLUNG, EINSTIEG], GREETING, "Mein Name ist Felix", VORSTELLUNG),
    _case("Vorstellung", [VORSTELLUNG, EINSTIEG], GREETING, "Felix", VORSTELLUNG),
    # The second: short and corrective answers, and a question asked again.
    _case("Vorstellung", [EINSTIEG], "Was geht dir gerade durch den Kopf?", "Nichts", (EINSTIEG, None),
          done={VORSTELLUNG: "Felix"}),
    _case(PLAUDEREI, [WOCHE, SCHOENES, WETTER], "Was ist letzte Woche denn passiert, das so stressig war?",
          "Letzte Woche war nicht stressig. Heute war stressig", (WOCHE, None),
          history=[("assistant", "Wie fühlt sich dein Tag bisher an?"),
                   ("user", "Er war recht stressig bis jetzt, aber jetzt freue ich mich, dass ich hier bin"),
                   ("assistant", "Was ist letzte Woche denn passiert, das so stressig war?")]),
    _case(PLAUDEREI, [SCHOENES, WETTER], "Was hast du letzte Woche denn so erlebt oder gemacht?",
          "Nicht viel", (("fix", WOCHE), None), done={WOCHE: "Letzte Woche war nicht stressig."}),
    _case(PLAUDEREI, [SCHOENES, WETTER],
          "Gab es denn in letzter Zeit etwas Kleines, das dir gefallen hat oder dich zum Lächeln gebracht hat?",
          "nein", SCHOENES, done={WOCHE: "nicht viel"}),
    _case(PLAUDEREI, [WETTER],
          "Gab es denn in letzter Zeit etwas Kleines, das dir gefallen hat oder dich zum Lächeln gebracht hat?",
          "nein", ("fix", SCHOENES), done={WOCHE: "nicht viel", SCHOENES: "Nicht viel"}),
    # Plain corrections of a collected answer, while another question is open.
    _case("Vorstellung", [EINSTIEG], "Wie geht es dir heute, Felix?",
          "Ach, sag lieber Fritz zu mir, so nennen mich alle.", ("fix", VORSTELLUNG), done={VORSTELLUNG: "Felix"}),
    _case(CHECKIN, [SPAZIER, BEWEGUNG, HUERDEN], "Gehst du in letzter Zeit spazieren?",
          "Moment, beim Trinken habe ich mich vertan, es sind eher zwei Liter am Tag.", ("fix", WASSER),
          done={WASSER: "ein Liter"}),
    _case(PLAUDEREI, [WETTER], "Wie ist das Wetter bei dir?",
          "Regnerisch. Und letzte Woche war übrigens doch was, meine Tochter war zu Besuch.",
          WETTER, done={WOCHE: "nichts Besonderes", SCHOENES: "früh aufgestanden"}, also=[("fix", WOCHE)]),
    # Mentioned in passing: saved, and not asked again.
    _case(PLAUDEREI, [WOCHE, SCHOENES, WETTER], "Wie war deine letzte Woche?",
          "Ruhig. Und heute regnet es schon den ganzen Tag, richtig ungemütlich.", WOCHE, also=[WETTER]),
    _case(PLAUDEREI, [WOCHE, SCHOENES, WETTER], "Wie war deine letzte Woche?",
          "Ruhig, aber am Sonntag hat mich meine Enkelin besucht, das hat mich so gefreut.", WOCHE, also=[SCHOENES]),
    _case(CHECKIN, [WASSER, SPAZIER, BEWEGUNG, HUERDEN], "Trinkst du genug Wasser über den Tag?",
          "So anderthalb Liter. Und jeden Morgen gehe ich eine halbe Stunde spazieren.", WASSER, also=[SPAZIER]),
    # Too vague to count as an answer, so it is still asked.
    _case(PLAUDEREI, [WOCHE, SCHOENES, WETTER], "Wie war deine letzte Woche?",
          "Ruhig. Na ja, das Wetter halt.", WOCHE, also=[]),
    # A repeat, or not remembering, is no correction.
    _case(PLAUDEREI, [WETTER], "Wie ist das Wetter bei dir?", "Sonnig. Und wie gesagt, letzte Woche war ruhig.",
          WETTER, done={WOCHE: "ruhig", SCHOENES: "Kaffee mit der Nachbarin"}, also=[]),
    _case(PLAUDEREI, [WETTER], "Wie ist das Wetter bei dir?",
          "Bewölkt. Was letzte Woche war, weiß ich eigentlich gar nicht mehr so genau.",
          WETTER, done={WOCHE: "Besuch der Tochter", SCHOENES: "Kaffee mit der Nachbarin"}, also=[]),
    # Answer and correction at once, on a task of the same state.
    _case(CHECKIN, [SPAZIER, BEWEGUNG, HUERDEN], "Gehst du in letzter Zeit spazieren?",
          "Ja, fast jeden Tag. Und beim Trinken habe ich mich vorhin vertan, es sind eher zwei Liter.",
          SPAZIER, done={WASSER: "ein Liter"}, also=[("fix", WASSER)]),
    # A question back, and small talk: nothing to record.
    _case(PLAUDEREI, [SCHOENES, WETTER], "Gab es in letzter Zeit etwas, das dich zum Lächeln gebracht hat?",
          "Und was bringt dich zum Lächeln?", None, done={WOCHE: "ruhig"}),
    _case(CHECKIN, [WASSER, SPAZIER, BEWEGUNG, HUERDEN], "Trinkst du genug Wasser über den Tag?",
          "Hm, warte mal, mein Telefon klingelt.", None),
]
