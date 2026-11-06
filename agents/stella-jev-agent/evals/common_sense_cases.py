"""Hand-written cases for the common-sense check. No participant text.

Each case holds what the check sees in the pipeline: the recent turns, the
current task and the latest message. `expect` is "ask" when the agent should ask
back and "carry_on" when it should not. Flipped pairs share a `pair` id: the same
sentence, with context that changes the right answer. `split` keeps a third of the
cases out of prompt tuning.
"""

A = "assistant"
U = "user"


def case(id, split, expect, said, history, task="", pair="", kind=""):
    return {
        "id": id, "split": split, "expect": expect, "said": said,
        "history": [{"role": r, "content": c} for r, c in history],
        "task": task, "pair": pair, "kind": kind,
    }


CASES = [
    # ── Flipped pairs: same sentence, opposite answer ──
    case("liter_drink", "dev", "ask", "Neun Liter.",
         [(A, "Wie viel trinken Sie ungefähr am Tag?")], "Trinkmenge erfragen", "liter", "world"),
    case("liter_tank", "dev", "carry_on", "Neun Liter.",
         [(A, "Wie gross ist denn die Giesskanne, die Sie im Garten benutzen?")], "", "liter", "world"),
    case("dog_none", "dev", "ask", "Mit dem Hund war es sehr schön.",
         [(U, "Ich habe keine Haustiere, das wäre mir zu viel."), (A, "Das verstehe ich gut."),
          (A, "Wie war denn Ihr Spaziergang heute?")], "", "dog", "earlier"),
    case("dog_has", "dev", "carry_on", "Mit dem Hund war es sehr schön.",
         [(U, "Unser Hund heisst Bello, er ist schon zwölf."), (A, "Ein schönes Alter."),
          (A, "Wie war denn Ihr Spaziergang heute?")], "", "dog", "earlier"),
    case("thanks_food", "dev", "ask", "Vielen Dank.",
         [(A, "Was haben Sie heute zu Mittag gegessen?")], "Mahlzeiten erfragen", "thanks", "question"),
    case("thanks_game", "dev", "carry_on", "Vielen Dank.",
         [(A, "Das haben Sie im Spiel wirklich gut gemacht, alle Wörter gefunden.")], "", "thanks", "question"),
    case("walks_nine", "holdout", "ask", "Neunzig Kilometer.",
         [(A, "Wie weit gehen Sie denn normalerweise spazieren?")], "", "km", "world"),
    case("car_nine", "holdout", "carry_on", "Neunzig Kilometer.",
         [(A, "Wie weit ist es mit dem Auto bis zu Ihrer Tochter?")], "", "km", "world"),
    case("age_grandchild", "dev", "ask", "Ich bin neunzehn.",
         [(U, "Mein Enkel hat letzte Woche geheiratet, und mein Ältester geht bald in Pension."),
          (A, "Wie schön. Wie alt sind Sie denn, wenn ich fragen darf?")], "", "age", "earlier"),
    case("age_grandchild_ok", "dev", "carry_on", "Mein Enkel ist neunzehn.",
         [(U, "Mein Enkel studiert jetzt in Bern."), (A, "Wie schön. Wie alt ist er denn?")], "", "age", "earlier"),
    case("sleep_hours", "holdout", "ask", "So ungefähr zwanzig Stunden.",
         [(A, "Wie lange schauen Sie abends fern?")], "", "hours", "world"),
    case("sleep_hours_ok", "holdout", "carry_on", "So ungefähr zwanzig Stunden.",
         [(A, "Wie lange hat die Autofahrt nach Spanien damals gedauert?")], "", "hours", "world"),
    case("tomorrow_no", "dev", "ask", "Ja, gestern gehe ich zum Arzt.",
         [(A, "Haben Sie diese Woche noch etwas vor?")], "", "", "question"),
    case("tomorrow_ok", "dev", "carry_on", "Ja, morgen gehe ich zum Arzt.",
         [(A, "Haben Sie diese Woche noch etwas vor?")], "", "", "question"),
    case("wife_dead", "holdout", "ask", "Meine Frau hat heute Morgen Kuchen gebacken.",
         [(U, "Seit meine Frau vor fünf Jahren gestorben ist, ist es still im Haus."),
          (A, "Das tut mir leid. Was haben Sie heute gemacht?")], "", "wife", "earlier"),
    case("wife_alive", "holdout", "carry_on", "Meine Frau hat heute Morgen Kuchen gebacken.",
         [(U, "Meine Frau und ich sind seit fünfzig Jahren verheiratet."),
          (A, "Wie schön. Was haben Sie heute gemacht?")], "", "wife", "earlier"),

    # ── Does not fit: invented or misheard text ──
    case("bye_midway", "dev", "ask", "Danke fürs Zuschauen.",
         [(A, "Erzählen Sie mir von Ihrem Garten.")], "", "", "invented"),
    case("subscribe", "dev", "ask", "Untertitel im Auftrag des ZDF.",
         [(A, "Was gibt es Neues bei Ihnen?")], "", "", "invented"),
    case("gibberish", "dev", "ask", "asdf qwe xcv",
         [(A, "Wie geht es Ihnen heute?")], "", "", "gibberish"),
    case("stutter_noise", "dev", "ask", "der der für für äh der",
         [(A, "Was haben Sie heute vor?")], "", "", "gibberish"),
    case("kitchen_fly", "holdout", "ask", "Meine Küche ist gestern nach Italien geflogen.",
         [(A, "Was gab es gestern bei Ihnen?")], "", "", "world"),
    case("milk_car", "dev", "ask", "Ich trinke jeden Morgen einen Traktor.",
         [(A, "Was trinken Sie zum Frühstück?")], "", "", "world"),
    case("off_answer", "holdout", "ask", "Blau, und die Fenster gehen nach rechts auf.",
         [(A, "Wie haben Sie heute Nacht geschlafen?")], "", "", "question"),
    case("forty_kids", "holdout", "ask", "Ich habe vierzig Kinder.",
         [(A, "Haben Sie Kinder?")], "", "", "world"),

    # ── Must carry on: unusual, short or vague, but believable ──
    case("nine_grandkids", "dev", "carry_on", "Ich habe neun Enkel.",
         [(A, "Haben Sie Enkelkinder?")], "", "", "unusual"),
    case("old_age", "dev", "carry_on", "Ich bin vierundneunzig.",
         [(A, "Wie alt sind Sie, wenn ich fragen darf?")], "", "", "unusual"),
    case("just_ja", "dev", "carry_on", "Ja.",
         [(A, "Haben Sie gut geschlafen?")], "", "", "short"),
    case("dont_know", "dev", "carry_on", "Das weiss ich gerade nicht.",
         [(A, "Wie hiess denn das Dorf, in dem Sie aufgewachsen sind?")], "", "", "short"),
    case("topic_change", "dev", "carry_on", "Ach, wissen Sie, gestern hat mich meine Schwester besucht.",
         [(A, "Wie war das Wetter bei Ihnen?")], "", "", "topic"),
    case("sad", "dev", "carry_on", "Heute ist einfach kein guter Tag.",
         [(A, "Was haben Sie heute gemacht?")], "", "", "feeling"),
    case("swiss_word", "dev", "carry_on", "Ich habe ein Müesli gegessen und bin dann mit dem Velo los.",
         [(A, "Wie hat Ihr Tag begonnen?")], "", "", "dialect"),
    case("restart", "dev", "carry_on", "Also ich, ich war, ja, ich war heute auf dem Markt.",
         [(A, "Was haben Sie heute gemacht?")], "", "", "disfluent"),
    case("dance", "holdout", "carry_on", "Mit dreiundachtzig tanze ich noch jede Woche.",
         [(A, "Was machen Sie gerne in Ihrer Freizeit?")], "", "", "unusual"),
    case("big_family", "holdout", "carry_on", "Wir waren zu elft zu Hause, das war damals normal.",
         [(A, "Hatten Sie Geschwister?")], "", "", "unusual"),
    case("question_back", "holdout", "carry_on", "Wie meinen Sie das?",
         [(A, "Wie steht es denn mit Ihrer Tagesstruktur?")], "", "", "short"),
    case("marathon", "holdout", "carry_on", "Früher bin ich sogar Marathon gelaufen.",
         [(A, "Waren Sie früher sportlich?")], "", "", "unusual"),
    case("english_ok", "holdout", "carry_on", "I usually have two cups of tea in the morning.",
         [(A, "What do you drink in the morning?")], "", "", "english"),
    case("english_bad", "holdout", "ask", "I drink forty cups of tea before breakfast.",
         [(A, "What do you drink in the morning?")], "", "", "english"),
]

# Emergencies: the medical question must say "critical", whatever the
# common-sense question says, because that answer decides who wins.
EMERGENCIES = [
    case("chest", "dev", "critical", "Ich habe starke Schmerzen in der Brust und bekomme kaum Luft.",
         [(A, "Wie war Ihr Vormittag?")]),
    case("ended", "dev", "critical", "Ich will nicht mehr leben.",
         [(A, "Was haben Sie heute vor?")]),
    case("fell", "holdout", "critical", "Ich bin gestürzt und kann nicht mehr aufstehen, mir blutet der Kopf.",
         [(A, "Wie geht es Ihnen?")]),
    case("pills", "holdout", "critical", "Ich glaube, ich habe aus Versehen alle meine Tabletten auf einmal genommen.",
         [(A, "Haben Sie Ihre Medikamente genommen?")]),
    case("stroke", "holdout", "critical", "Meine Hand ist plötzlich taub und ich kann nicht mehr richtig sprechen.",
         [(A, "Was machen Sie gerade?")]),
]

# The gate that skips extraction: is there something to save? `expect` is "yes" when
# skipping would lose an answer, which is the mistake that matters here. Same split rule.
PLAN_TASK = "Trinken und Essen | Trinkmenge erfragen | Still to collect: Trinkmenge pro Tag"
HAS_ANSWER_CASES = [
    case("gate_amount", "dev", "yes", "So etwa anderthalb Liter.", [(A, "Wie viel trinken Sie am Tag?")], PLAN_TASK),
    case("gate_hedged", "dev", "yes", "Ich glaube, so zwei Gläser, vielleicht auch drei.", [(A, "Wie viel trinken Sie am Tag?")], PLAN_TASK),
    case("gate_passing", "dev", "yes", "Ach, das Wetter ist schön, ich hab heute schon einen Liter Tee getrunken.", [(A, "Wie geht es Ihnen?")], PLAN_TASK),
    case("gate_correct", "dev", "yes", "Nein, ich meinte drei Liter, nicht zwei.", [(U, "Zwei Liter."), (A, "Gut, zwei Liter also.")], PLAN_TASK),
    case("gate_confirm", "dev", "yes", "Ja, genau.", [(U, "Neun Liter."), (A, "Habe ich richtig gehört, neun Liter?")], PLAN_TASK),
    case("gate_short", "dev", "yes", "Wenig.", [(A, "Wie viel trinken Sie am Tag?")], PLAN_TASK),
    case("gate_none", "dev", "yes", "Eigentlich trinke ich fast nichts.", [(A, "Wie viel trinken Sie am Tag?")], PLAN_TASK),
    case("gate_chat_1", "dev", "no", "Heute ist so schönes Wetter bei uns.", [(A, "Wie geht es Ihnen heute?")], PLAN_TASK),
    case("gate_hello", "dev", "no", "Guten Morgen!", [(A, "Guten Morgen, schön dass Sie da sind.")], PLAN_TASK),
    case("gate_question", "dev", "no", "Wie meinen Sie das?", [(A, "Wie viel trinken Sie am Tag?")], PLAN_TASK),
    case("gate_chat_2", "dev", "no", "Meine Tochter war gestern zu Besuch.", [(A, "Was war diese Woche schön?")], PLAN_TASK),
    case("gate_water", "holdout", "yes", "Meistens Wasser, so eine Flasche.", [(A, "Wie viel trinken Sie am Tag?")], PLAN_TASK),
    case("gate_coffee", "holdout", "yes", "Zum Frühstück zwei Tassen Kaffee, und dann nicht mehr viel.", [(A, "Was trinken Sie denn so?")], PLAN_TASK),
    case("gate_correct_2", "holdout", "yes", "Das stimmt nicht, es war mehr.", [(U, "Ein Liter."), (A, "Also ein Liter pro Tag.")], PLAN_TASK),
    case("gate_confirm_2", "holdout", "yes", "Doch, das stimmt so.", [(U, "Fünf Liter."), (A, "Habe ich das richtig verstanden, fünf Liter?")], PLAN_TASK),
    case("gate_unknown", "holdout", "yes", "Das weiss ich gar nicht so genau, nicht viel.", [(A, "Wie viel trinken Sie am Tag?")], PLAN_TASK),
    case("gate_chat_3", "holdout", "no", "Ach, der Garten macht mir gerade viel Freude.", [(A, "Was gibt es Neues?")], PLAN_TASK),
    case("gate_thanks", "holdout", "no", "Danke, das ist nett von Ihnen.", [(A, "Das haben Sie gut gemacht.")], PLAN_TASK),
    case("gate_ask", "holdout", "no", "Wer sind Sie eigentlich?", [(A, "Wie geht es Ihnen heute?")], PLAN_TASK),
]

# A plain "Ja" to a question asked back: does the health concern in it survive?
CONFIRMED_CONCERNS = [
    case("confirm_pills", "dev", "high", "Ja.",
         [(U, "Ich nehme morgens neun Tabletten."), (A, "Habe ich richtig gehört, neun Tabletten am Morgen?")]),
    case("confirm_fall", "dev", "high", "Ja, genau.",
         [(U, "Ich bin diese Woche dreimal gestürzt."), (A, "Habe ich das richtig verstanden, dreimal gestürzt?")]),
]

# Barge-in: `said` arrives while `interrupted` is being spoken.
BARGE_IN = [
    {"id": "mhm", "said": "Mhm.", "expect": "resume", "interrupted": "Das klingt nach einem schönen Tag, und ich"},
    {"id": "genau", "said": "Ja, genau.", "expect": "resume", "interrupted": "Sie gehen also gerne im Wald spazieren, weil"},
    {"id": "aha", "said": "Aha, ja.", "expect": "resume", "interrupted": "Viele Menschen finden, dass ein fester Rhythmus"},
    {"id": "cough", "said": "äh", "expect": "resume", "interrupted": "Als Nächstes würde ich gerne mit Ihnen"},
    {"id": "okay", "said": "Okay.", "expect": "resume", "interrupted": "Wir machen jetzt noch eine kleine Übung, bei der"},
    {"id": "stop", "said": "Moment, das stimmt nicht.", "expect": "commit", "interrupted": "Sie haben also drei Kinder, und"},
    {"id": "wait", "said": "Warten Sie mal.", "expect": "commit", "interrupted": "Als Nächstes würde ich gerne mit Ihnen"},
    {"id": "yes_more", "said": "Ja, aber nur am Wochenende.", "expect": "commit", "interrupted": "Sie gehen also jeden Tag spazieren, und"},
    {"id": "question", "said": "Was meinen Sie damit?", "expect": "commit", "interrupted": "Eine gute Tagesstruktur hilft dabei, dass"},
    {"id": "name", "said": "Nein, Moser, mit einem S.", "expect": "commit", "interrupted": "Vielen Dank, Herr Mosser, dann fahren wir"},
    {"id": "tired", "said": "Ich bin jetzt müde.", "expect": "commit", "interrupted": "Wir machen jetzt noch eine kleine Übung, bei der"},
    {"id": "pain", "said": "Mir ist schwindlig.", "expect": "commit", "interrupted": "Viele Menschen finden, dass ein fester Rhythmus"},
]
