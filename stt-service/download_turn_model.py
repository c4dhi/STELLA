#!/usr/bin/env python3
"""
Pre-download the end-of-turn model named by TURN_MODEL into the Hugging Face cache.

Run by the init container, so the service itself never needs the network.

Environment variables:
- TURN_MODEL: smart_turn or voxturn
- HF_HOME: where the Hugging Face cache lives
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))

from vad.turn_model import download_turn_model  # noqa: E402

if __name__ == "__main__":
    name = os.environ["TURN_MODEL"]
    print(f"[Turn Model Download] Downloading: {name}")
    download_turn_model(name)
    print("[Turn Model Download] Done")
