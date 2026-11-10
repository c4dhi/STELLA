"""Hand-written turns for the next-step forecast. No participant data.

Each case: which tasks are still open, what the assistant asked, what the person said,
and by hand which task that answers (None: nothing to record) and where the plan goes
(None: it stays). A tuple of tasks means the answer takes care of more than one and
either pick is fine.
"""

VORSTELLUNG, EINSTIEG = "Vorstellung", "Kurzer Einstieg"
WOCHE, SCHOENES, WETTER = "Letzte Woche", "Etwas Schönes", "Wetter"
WASSER, SPAZIER, BEWEGUNG, HUERDEN = "Wasser trinken", "Spaziergänge", "Andere Bewegung", "Hürden"
VORSCHLAG, TSCHUESS = "Persönlicher Vorschlag", "Auf Wiedersehen"
PLAUDEREI, CHECKIN, ABSCHIED, END = "Plauderei", "Aktivitäts-Check-in", "Verabschiedung", "__end__"


def _case(state, open_tasks, asked, said, task, goes_to=None):
    return {"state": state, "open": open_tasks, "asked": asked, "said": said, "task": task, "goes_to": goes_to}


GERMAN_FOCUS_GROUP = [
    _case("Vorstellung", [VORSTELLUNG, EINSTIEG], "Wie darf ich Sie nennen?", "Ich heiße Anna.", VORSTELLUNG),
    _case("Vorstellung", [VORSTELLUNG, EINSTIEG], "Wie darf ich Sie nennen?", "Sagen Sie einfach Hans zu mir.", VORSTELLUNG),
    _case("Vorstellung", [VORSTELLUNG, EINSTIEG], "Wie darf ich Sie nennen?", "Wozu wollen Sie das denn wissen?", None),
    _case("Vorstellung", [EINSTIEG], "Wie geht es Ihnen heute?", "Ganz gut, danke, nur ein bisschen müde.", EINSTIEG, PLAUDEREI),
    _case("Vorstellung", [EINSTIEG], "Wie geht es Ihnen heute?", "Geht so.", EINSTIEG, PLAUDEREI),
    _case("Vorstellung", [EINSTIEG], "Wie geht es Ihnen heute?", "Sind Sie eigentlich ein echter Mensch?", None),
    _case("Plauderei", [WOCHE, SCHOENES, WETTER], "Wie war Ihre letzte Woche?", "Ruhig, ich war viel zu Hause.", WOCHE),
    _case("Plauderei", [WOCHE, SCHOENES, WETTER], "Wie war Ihre letzte Woche?",
          "Ruhig, aber am Sonntag hat mich meine Enkelin besucht, das war wirklich schön.", (WOCHE, SCHOENES)),
    _case("Plauderei", [SCHOENES, WETTER], "Was war diese Woche schön?", "Meine Tochter hat angerufen.", SCHOENES),
    _case("Plauderei", [SCHOENES, WETTER], "Was war diese Woche schön?", "Hm, da muss ich überlegen.", None),
    _case("Plauderei", [WETTER], "Wie ist das Wetter bei Ihnen?", "Es regnet seit gestern, ich bleibe lieber drin.", WETTER, CHECKIN),
    _case("Plauderei", [WETTER], "Wie ist das Wetter bei Ihnen?", "Sonnig. Ich war sogar kurz draußen im Garten.", WETTER, CHECKIN),
    _case("Plauderei", [WETTER], "Wie ist das Wetter bei Ihnen?", "Welcher Tag ist heute eigentlich?", None),
    # Flexible states: a later task answered while an earlier one is still open.
    _case("Plauderei", [WOCHE, SCHOENES, WETTER], "Wie ist das Wetter bei Ihnen?", "Es schneit, wunderschön sieht das aus.", WETTER),
    _case(CHECKIN, [WASSER, SPAZIER, HUERDEN], "Was hält Sie manchmal davon ab, rauszugehen?", "Vor allem die Treppe im Haus.", HUERDEN),
    _case(CHECKIN, [WASSER, SPAZIER, BEWEGUNG, HUERDEN], "Wie viel trinken Sie am Tag?", "So anderthalb Liter, meistens Tee.", WASSER),
    _case(CHECKIN, [WASSER, SPAZIER, BEWEGUNG, HUERDEN], "Trinken Sie genug über den Tag?", "Ja, schon.", WASSER),
    _case(CHECKIN, [WASSER, SPAZIER, BEWEGUNG, HUERDEN], "Wie viel trinken Sie am Tag?", "Das weiß ich gar nicht so genau.", None),
    _case(CHECKIN, [SPAZIER, BEWEGUNG, HUERDEN], "Gehen Sie noch spazieren?", "Jeden Morgen eine Runde um den Block.", SPAZIER),
    _case(CHECKIN, [SPAZIER, BEWEGUNG, HUERDEN], "Gehen Sie noch spazieren?", "Nein, im Moment gar nicht, mein Knie macht nicht mit.", (SPAZIER, HUERDEN)),
    _case(CHECKIN, [BEWEGUNG, HUERDEN], "Bewegen Sie sich sonst noch irgendwie?", "Dienstags gehe ich zur Gymnastik.", BEWEGUNG),
    _case(CHECKIN, [HUERDEN], "Was hält Sie manchmal davon ab, sich zu bewegen?", "Wenn es glatt ist, traue ich mich nicht raus.", HUERDEN, VORSCHLAG),
    _case(CHECKIN, [HUERDEN], "Was hält Sie manchmal davon ab, sich zu bewegen?", "Eigentlich nichts.", HUERDEN, VORSCHLAG),
    _case(CHECKIN, [HUERDEN], "Was hält Sie manchmal davon ab, sich zu bewegen?", "Das Wetter war schön gestern.", None),
    _case(VORSCHLAG, [VORSCHLAG], "Wie wäre es, wenn Sie morgens nach dem Frühstück ein Glas Wasser mehr trinken?", "Ja, das kann ich probieren.", VORSCHLAG, ABSCHIED),
    _case(VORSCHLAG, [VORSCHLAG], "Wie wäre es, wenn Sie morgens nach dem Frühstück ein Glas Wasser mehr trinken?", "Nein, das mag ich nicht.", VORSCHLAG, ABSCHIED),
    _case(ABSCHIED, [TSCHUESS], "Es hat mich gefreut. Auf Wiedersehen!", "Danke, auf Wiedersehen.", TSCHUESS, END),
]

TRINKEN, ART = "Trinkmenge", "Wie die Person unterwegs ist"
VALUE_BRANCH_PLAN = {
    "states": [
        {"id": "trinken", "title": "Trinken", "type": "flexible",
         "tasks": [{"id": TRINKEN, "description": TRINKEN, "instruction": "Fragen, wie viel die Person am Tag trinkt.",
                    "deliverables": [{"key": "liter", "description": "Liter, die die Person am Tag trinkt"}]}],
         "transitions": [
             {"target_state_id": "mehr", "condition_type": "deliverable_value_numeric", "priority": 0,
              "condition_config": {"key": "liter", "operator": "lt", "value": 1}},
             {"target_state_id": "viel", "condition_type": "deliverable_value_numeric", "priority": 1,
              "condition_config": {"key": "liter", "operator": "gt", "value": 3}},
             {"target_state_id": "alltag", "condition_type": "all_tasks_complete", "priority": 2},
         ]},
        {"id": "laufen", "title": "Gehen", "type": "flexible",
         "tasks": [{"id": ART, "description": ART, "instruction": "Fragen, wie die Person unterwegs ist.",
                    "deliverables": [{"key": "gehen", "description": "Wie die Person unterwegs ist"}]}],
         "transitions": [
             {"target_state_id": "hilfe", "condition_type": "deliverable_value_in", "priority": 0,
              "condition_config": {"key": "gehen", "values": ["Rollator", "Rollstuhl", "Gehstock"]}},
             {"target_state_id": "alltag", "condition_type": "deliverable_value", "priority": 1,
              "condition_config": {"key": "gehen", "value": "ohne Hilfe"}},
         ]},
        {"id": "mehr", "title": "Mehr trinken", "tasks": [{"id": "m", "description": "Mehr trinken", "deliverables": []}]},
        {"id": "viel", "title": "Sehr viel", "tasks": [{"id": "v", "description": "Sehr viel", "deliverables": []}]},
        {"id": "hilfe", "title": "Mit Hilfe", "tasks": [{"id": "h", "description": "Mit Hilfe", "deliverables": []}]},
        {"id": "alltag", "title": "Alltag", "tasks": [{"id": "a", "description": "Alltag", "deliverables": []}]},
    ],
}

_ASK_DRINK, _ASK_WALK = "Wie viel trinken Sie am Tag?", "Wie sind Sie unterwegs?"
VALUE_BRANCHES = [
    _case("Trinken", [TRINKEN], _ASK_DRINK, "Nur einen halben Liter.", TRINKEN, "Mehr trinken"),
    _case("Trinken", [TRINKEN], _ASK_DRINK, "Vielleicht zwei Tassen Kaffee, mehr nicht.", TRINKEN, "Mehr trinken"),
    _case("Trinken", [TRINKEN], _ASK_DRINK, "So fünf Liter, ich habe immer Durst.", TRINKEN, "Sehr viel"),
    _case("Trinken", [TRINKEN], _ASK_DRINK, "Ungefähr vier Liter.", TRINKEN, "Sehr viel"),
    _case("Trinken", [TRINKEN], _ASK_DRINK, "Anderthalb Liter etwa.", TRINKEN, "Alltag"),
    _case("Trinken", [TRINKEN], _ASK_DRINK, "Zwei Flaschen Wasser, also gut zwei Liter.", TRINKEN, "Alltag"),
    _case("Trinken", [TRINKEN], _ASK_DRINK, "Genau einen Liter.", TRINKEN, "Alltag"),
    _case("Trinken", [TRINKEN], _ASK_DRINK, "Das kommt ganz darauf an.", None),
    _case("Trinken", [TRINKEN], _ASK_DRINK, "Trinken Sie denn auch was?", None),
    _case("Gehen", [ART], _ASK_WALK, "Ich nehme immer den Rollator.", ART, "Mit Hilfe"),
    _case("Gehen", [ART], _ASK_WALK, "Mit dem Stock, seit der Operation.", ART, "Mit Hilfe"),
    _case("Gehen", [ART], _ASK_WALK, "Ich sitze im Rollstuhl.", ART, "Mit Hilfe"),
    _case("Gehen", [ART], _ASK_WALK, "Ganz ohne Hilfe, zum Glück.", ART, "Alltag"),
    _case("Gehen", [ART], _ASK_WALK, "Noch gut zu Fuß, ich brauche nichts.", ART, "Alltag"),
    _case("Gehen", [ART], _ASK_WALK, "Mit dem Auto meistens.", ART, None),
]

# Whole turns for the stopwatch: the reply must carry on from the forecast.
TIMED = [c for c in GERMAN_FOCUS_GROUP if c["said"] in {
    "Ich heiße Anna.", "Ganz gut, danke, nur ein bisschen müde.", "Meine Tochter hat angerufen.",
    "Es regnet seit gestern, ich bleibe lieber drin.", "So anderthalb Liter, meistens Tee.",
    "Wenn es glatt ist, traue ich mich nicht raus.", "Ruhig, ich war viel zu Hause.", "Jeden Morgen eine Runde um den Block.",
    "Dienstags gehe ich zur Gymnastik.", "Es schneit, wunderschön sieht das aus.", "Vor allem die Treppe im Haus.",
}]
