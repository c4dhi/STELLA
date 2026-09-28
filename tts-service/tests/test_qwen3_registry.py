"""Tests for the Qwen3 reference-voice registry + resolution (#311).

These cover the pure registry/resolution/capabilities logic, which needs
neither torch nor the model weights (the heavy deps are import-guarded in the
provider). Runnable two ways:

    pytest tts-service/tests/test_qwen3_registry.py
    python tts-service/tests/test_qwen3_registry.py     # no pytest needed
"""

import json
import os
import sys
import tempfile

# Make `providers` importable (mirrors how the service runs from src/).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from providers.qwen3_provider import Qwen3Provider  # noqa: E402


def _make_clip(directory, name, with_text=True):
    audio = os.path.join(directory, name + ".mp3")
    with open(audio, "wb") as f:
        f.write(b"\x00")
    if with_text:
        with open(os.path.join(directory, name + ".txt"), "w", encoding="utf-8") as f:
            f.write("transcript for " + name)
    return audio


def _provider_with_manifest(directory, manifest):
    mpath = os.path.join(directory, "voices.json")
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(manifest, f)
    p = Qwen3Provider()
    p._voices_manifest = mpath
    p._ref_audio = _make_clip(directory, "ref_audio")
    p._ref_text = "LEGACY DEFAULT"
    p._load_registry()
    return p


def _standard_provider(directory):
    _make_clip(directory, "stella_en")
    _make_clip(directory, "stella_de")
    _make_clip(directory, "bob_en")
    manifest = {
        "default_voice": "stella",
        "voices": [
            {
                "id": "stella",
                "display_name": "Stella",
                "default_language": "en",
                "clips": {
                    "en": {"audio": "stella_en.mp3"},
                    "de": {"audio": "stella_de.mp3"},
                },
            },
            {
                "id": "bob",
                "display_name": "Bob",
                "default_language": "en",
                "clips": {"en": {"audio": "bob_en.mp3"}},
            },
        ],
    }
    return _provider_with_manifest(directory, manifest)


def test_exact_match():
    with tempfile.TemporaryDirectory() as d:
        p = _standard_provider(d)
        audio, text = p._resolve_ref("stella", "de")
        assert os.path.basename(audio) == "stella_de.mp3"
        assert text == "transcript for stella_de"


def test_unknown_language_falls_back_to_voice_default():
    with tempfile.TemporaryDirectory() as d:
        p = _standard_provider(d)
        audio, _ = p._resolve_ref("stella", "fr")  # stella has no fr
        assert os.path.basename(audio) == "stella_en.mp3"  # stella default_language=en


def test_voice_without_language_uses_its_default():
    with tempfile.TemporaryDirectory() as d:
        p = _standard_provider(d)
        audio, _ = p._resolve_ref("bob", "de")  # bob has no de
        assert os.path.basename(audio) == "bob_en.mp3"


def test_unknown_voice_falls_back_to_default_voice():
    with tempfile.TemporaryDirectory() as d:
        p = _standard_provider(d)
        audio, _ = p._resolve_ref("nobody", "de")  # -> default voice stella, de exists
        assert os.path.basename(audio) == "stella_de.mp3"


def test_region_and_full_name_normalization():
    with tempfile.TemporaryDirectory() as d:
        p = _standard_provider(d)
        assert os.path.basename(p._resolve_ref("stella", "de-AT")[0]) == "stella_de.mp3"
        assert os.path.basename(p._resolve_ref("stella", "German")[0]) == "stella_de.mp3"


def test_auto_language_uses_default_voice_default_language():
    with tempfile.TemporaryDirectory() as d:
        p = _standard_provider(d)
        for lang in (None, "", "Auto"):
            audio, _ = p._resolve_ref(None, lang)
            assert os.path.basename(audio) == "stella_en.mp3"


def test_clip_missing_transcript_is_skipped():
    with tempfile.TemporaryDirectory() as d:
        # German clip has audio but NO transcript -> must fall back, not go silent.
        _make_clip(d, "stella_en")
        _make_clip(d, "stella_de", with_text=False)
        manifest = {
            "default_voice": "stella",
            "voices": [{
                "id": "stella", "display_name": "Stella", "default_language": "en",
                "clips": {"en": {"audio": "stella_en.mp3"}, "de": {"audio": "stella_de.mp3"}},
            }],
        }
        p = _provider_with_manifest(d, manifest)
        audio, text = p._resolve_ref("stella", "de")
        assert os.path.basename(audio) == "stella_en.mp3"
        assert text == "transcript for stella_en"


def test_clip_with_missing_audio_file_is_dropped_at_load():
    with tempfile.TemporaryDirectory() as d:
        _make_clip(d, "stella_en")
        manifest = {
            "default_voice": "stella",
            "voices": [{
                "id": "stella", "default_language": "en",
                "clips": {
                    "en": {"audio": "stella_en.mp3"},
                    "de": {"audio": "stella_de.mp3"},  # file never created
                },
            }],
        }
        p = _provider_with_manifest(d, manifest)
        assert set(p._registry["stella"]["clips"].keys()) == {"en"}


def test_no_manifest_is_legacy_single_voice():
    with tempfile.TemporaryDirectory() as d:
        p = Qwen3Provider()
        p._voices_manifest = os.path.join(d, "does-not-exist.json")
        p._ref_audio = os.path.join(d, "ref_audio.mp3")
        p._ref_text = "LEGACY"
        p._load_registry()
        assert p._registry == {}
        audio, text = p._resolve_ref("anything", "de")
        assert audio == p._ref_audio
        assert text == "LEGACY"
        caps = p.get_capabilities()
        assert [v.id for v in caps.voices] == ["default"]
        assert caps.supports_voice_selection is False


def test_capabilities_reports_registry():
    with tempfile.TemporaryDirectory() as d:
        p = _standard_provider(d)
        caps = p.get_capabilities()
        assert caps.default_voice == "stella"
        assert caps.supports_voice_selection is True  # 2 voices
        ids = {v.id for v in caps.voices}
        assert ids == {"stella", "bob"}
        stella = next(v for v in caps.voices if v.id == "stella")
        assert stella.languages == ["de", "en"]  # sorted
        # Broad synthesizable set is wider than the clips we have.
        assert "fr" in caps.languages


def test_resolution_is_cached():
    with tempfile.TemporaryDirectory() as d:
        p = _standard_provider(d)
        first = p._resolve_ref("stella", "de")
        assert ("stella", "de") in p._ref_cache
        assert p._resolve_ref("stella", "de") is first


def _run_standalone():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failures = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as e:
            failures += 1
            print(f"FAIL {fn.__name__}: {e}")
    print(f"\n{len(fns) - failures}/{len(fns)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(_run_standalone())


# ---------------------------------------------------------------------------
# x-vector-only conditioning (QWEN3_XVEC_ONLY)
# ---------------------------------------------------------------------------


def test_xvec_only_defaults_off():
    """ICL stays the default — it is the higher-fidelity mode."""
    old = os.environ.pop("QWEN3_XVEC_ONLY", None)
    try:
        assert Qwen3Provider()._xvec_only is False
    finally:
        if old is not None:
            os.environ["QWEN3_XVEC_ONLY"] = old


def test_xvec_only_parses_truthy_spellings():
    """Operators set this from a deploy UI / configmap, so be forgiving."""
    for raw, expected in [
        ("true", True), ("TRUE", True), ("  yes ", True), ("1", True), ("on", True),
        ("false", False), ("0", False), ("", False), ("nonsense", False),
    ]:
        os.environ["QWEN3_XVEC_ONLY"] = raw
        try:
            assert Qwen3Provider()._xvec_only is expected, raw
        finally:
            os.environ.pop("QWEN3_XVEC_ONLY", None)


def test_bundled_reference_clips_stay_within_the_recommended_length():
    """The clips are prefilled on EVERY request in ICL mode, so length is latency.

    They were 17-20s — 2-4x the 5-10s the provider documents — which is what
    made time-to-first-audio ~241ms and constant regardless of sentence length.
    That surfaced as an audible break between sentences, since each sentence is
    its own request. Guard the regression: a future re-record must not quietly
    reintroduce a 20s reference.
    """
    import wave  # noqa: F401  (kept: documents that these are audio assets)

    assets = os.path.join(os.path.dirname(__file__), "..", "assets")
    clips = [
        os.path.join(assets, "ref_audio.mp3"),
        os.path.join(assets, "voices", "stella_de.mp3"),
        os.path.join(assets, "voices", "stella_en.mp3"),
    ]
    # ~77-80kbps mono MP3: 10s is well under 130KB. Size is a proxy for
    # duration that needs no audio decoder in the test environment.
    for path in clips:
        if not os.path.isfile(path):
            continue
        size = os.path.getsize(path)
        assert size < 130_000, (
            f"{os.path.basename(path)} is {size}B — that is roughly "
            f"{size / 9700:.0f}s at this bitrate, over the 5-10s the provider "
            f"documents. Every ICL request prefills this clip."
        )
