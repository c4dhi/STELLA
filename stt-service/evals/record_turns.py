#!/usr/bin/env python3
"""Record test turns for run_turn_model.py, one complete turn per file.

Each prompt asks for a kind of turn. Press Enter to start, speak, stop talking,
then press Enter again. Files land in evals/turn_recordings/<speaker>/, which git
ignores. They are voice recordings of a real person: get their consent, and keep
them on this machine.

Needs ffmpeg. On macOS the terminal needs microphone access (System Settings ->
Privacy & Security -> Microphone).

Usage: python evals/record_turns.py <speaker-initials> [--input ":0"]
"""
import argparse
import subprocess
import sys
from pathlib import Path

PROMPTS = [
    ("finished", "Was haben Sie heute gefrühstückt? Antworten Sie in einem normalen Satz."),
    ("finished", "Wie war das Wetter heute Morgen?"),
    ("finished", "Was machen Sie am liebsten am Wochenende?"),
    ("finished", "Wen haben Sie zuletzt angerufen, und worum ging es?"),
    ("finished", "Wie sind Sie heute hierher gekommen?"),
    ("thinking", "Was haben Sie letzte Woche alles gemacht? Lassen Sie sich Zeit und machen Sie zwischendurch echte Denkpausen."),
    ("thinking", "Wie heissen die Strassen rund um Ihr Zuhause? Überlegen Sie zwischendurch in Ruhe."),
    ("thinking", "Wann waren Sie zuletzt beim Arzt, und warum? Überlegen Sie, bevor Sie weiterreden."),
    ("thinking", "Welche Geburtstage kommen als Nächstes in Ihrer Familie? Denken Sie zwischendurch nach."),
    ("thinking", "Beschreiben Sie den Weg zum nächsten Supermarkt. Halten Sie an, wenn Sie überlegen müssen."),
    ("midsentence", "Beginnen Sie einen Satz, halten Sie mitten im Satz zwei Sekunden an und führen Sie ihn zu Ende: Heute Nachmittag gehe ich ... zu meiner Schwester."),
    ("midsentence", "Genauso: Am liebsten esse ich ... Kartoffeln mit Butter."),
    ("midsentence", "Genauso, mit Ihren eigenen Worten: Mein erstes Auto war ein ..."),
    ("midsentence", "Genauso: Ich habe gestern ... (überlegen) ... ja, ich habe den Keller aufgeräumt."),
    ("midsentence", "Genauso, und ziehen Sie das letzte Wort vor der Pause in die Länge: Und daaann ... sind wir nach Hause gefahren."),
    ("short", "Antworten Sie nur: Ja."),
    ("short", "Antworten Sie nur: Nein, danke."),
    ("short", "Antworten Sie nur: Genau."),
    ("short", "Antworten Sie nur: Ich weiss nicht."),
    ("short", "Antworten Sie nur: Vielleicht morgen."),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("speaker")
    parser.add_argument("--input", default=":0", help="ffmpeg avfoundation input; list with --list-inputs")
    parser.add_argument("--list-inputs", action="store_true")
    args = parser.parse_args()

    if args.list_inputs:
        subprocess.run(["ffmpeg", "-f", "avfoundation", "-list_devices", "true", "-i", ""])
        return

    folder = Path(__file__).resolve().parent / "turn_recordings" / args.speaker
    folder.mkdir(parents=True, exist_ok=True)
    counts = {}
    for number, (kind, prompt) in enumerate(PROMPTS, 1):
        counts[kind] = counts.get(kind, 0) + 1
        path = folder / f"{kind}_{args.speaker}_{counts[kind]}.wav"
        print(f"\n[{number}/{len(PROMPTS)}] {prompt}")
        if path.exists():
            print("  already recorded, skipping")
            continue
        input("  Enter to start > ")
        recorder = subprocess.Popen(
            ["ffmpeg", "-v", "error", "-f", "avfoundation", "-i", args.input, "-ac", "1", "-ar", "16000", str(path)],
            stdin=subprocess.PIPE,
        )
        input("  Recording. Enter when you have finished the turn > ")
        recorder.communicate(b"q")
        if recorder.returncode != 0:
            sys.exit("Recording failed. Check microphone access and --input.")
    print(f"\nDone: {folder}")


if __name__ == "__main__":
    main()
