"""Qwen3-TTS provider — in-process inference via faster-qwen3-tts.

Runs the model directly inside the tts-service Python process (same pattern
as Kokoro / ChatterBox). No sidecar container, no HTTP hop. The CUDA-graph
fast path in `faster-qwen3-tts` is what makes this real-time (~156 ms TTFA
on a 4090, 4.78 RTF for the 0.6B-Base variant).

PERFORMANCE NOTES
-----------------
- We load with ``device="cuda"`` and bfloat16 weights by default; both knobs
  are env-overridable. CUDA is required — there is no CPU fast path.
- We pre-warm at the end of ``initialize()`` so the first user-facing
  request hits captured CUDA graphs, not JIT compilation.
- Streaming uses ``generate_voice_clone_streaming`` with a small
  ``QWEN3_CHUNK_SIZE`` (default 2 codec frames ≈ 167 ms audio) so TTFB is
  bound by model prefill + one decoder step, not by chunk-buffering inside
  the generator.
- We reslice the model's audio chunks into the gRPC pipeline's preferred
  480-sample (20 ms) frames here, on the CPU side, so the model loop never
  blocks on small allocations.

LICENSE NOTES
-------------
- This integration code is distributed under STELLA's permissive license.
- The ``faster-qwen3-tts`` engine is MIT
  (https://github.com/andimarafioti/faster-qwen3-tts).
- Qwen3-TTS model weights are Apache-2.0 (Qwen/Qwen3-TTS-*).
"""

import asyncio
import json
import os
import threading
import time
from typing import Optional, Tuple, AsyncGenerator, Dict

import numpy as np

from .base import TTSProvider, ProviderCapabilities, VoiceInfo

try:
    import torch
    from faster_qwen3_tts import FasterQwen3TTS
    QWEN3_DEPS_AVAILABLE = True
except ImportError:
    QWEN3_DEPS_AVAILABLE = False
    torch = None
    FasterQwen3TTS = None


DEFAULT_MODEL_ID = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
# Empty / "Auto" → pass language=None to the model, which triggers its
# built-in language autodetection from the input text. Pin a specific
# language only if autodetect misfires on your domain (rare).
DEFAULT_LANGUAGE = ""
# faster-qwen3-tts labels languages by full name ("English", "German", …),
# but callers (the agent SDK) pass ISO 639-1 codes ("en", "de", …). Passing a
# code straight through raises "Language <code> not implemented" and yields no
# audio. Map the codes we expose in the deploy wizard to the model's names;
# anything unrecognized falls back to autodetect (None) so TTS never goes silent.
_ISO_TO_QWEN3_LANGUAGE = {
    "en": "English",
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "it": "Italian",
    "pt": "Portuguese",
    "pl": "Polish",
    "nl": "Dutch",
    "zh": "Chinese",
    "ja": "Japanese",
    "ko": "Korean",
}
# The set of labels the model accepts directly (already full names).
_QWEN3_LANGUAGE_NAMES = {v.lower(): v for v in _ISO_TO_QWEN3_LANGUAGE.values()}
# Reverse map (full name → ISO) so a caller passing "German" still keys clips
# by "de" in the reference-voice registry.
_QWEN3_NAME_TO_ISO = {v.lower(): k for k, v in _ISO_TO_QWEN3_LANGUAGE.items()}
DEFAULT_SAMPLE_RATE = 24000
# Codec runs at 12 Hz token rate; chunk_size=2 ≈ 167 ms audio per yield.
# Smaller = lower TTFB, more decoder calls per second. The CUDA-graph
# fast path keeps the per-call overhead small enough that 2 is a sweet
# spot on an L4 / 4090. Drop to 1 if you want absolute minimum TTFB at
# the cost of ~2x decoder-call frequency.
DEFAULT_CHUNK_SIZE = 2
# Sentinel used in the async pump queue to signal end-of-stream.
_QWEN3_STREAM_DONE = object()


class Qwen3Provider(TTSProvider):
    """Qwen3-TTS via the in-process `faster-qwen3-tts` library.

    Configuration (all env vars; sensible defaults):

    - ``QWEN3_MODEL_ID``: HF repo or local path of the variant to load.
      Default ``Qwen/Qwen3-TTS-12Hz-0.6B-Base``. The TTS init container
      pre-stages weights at ``/models/qwen3``; point this at that path
      (or leave as the repo ID and let HF resolve to its cache).
    - ``QWEN3_MODEL_PATH``: optional local path override. Takes precedence
      over ``QWEN3_MODEL_ID`` when set.
    - ``QWEN3_DEVICE``: ``cuda`` (default) or ``cpu``. CPU is supported
      only as a fallback for debugging — it is not real-time.
    - ``QWEN3_DTYPE``: ``bfloat16`` (default), ``float16``, or ``float32``.
    - ``QWEN3_LANGUAGE``: input language label. Empty or ``Auto`` (default)
      lets the model autodetect from the text — works well for mixed-
      language deployments. Pin to a specific language only if needed.
    - ``QWEN3_REF_AUDIO``: path to a reference clip (~5–10 s, WAV or MP3).
      Required for every variant. The init container drops the bundled
      clip at /models/qwen3/ref_audio.mp3 if no operator file is present.
    - ``QWEN3_REF_TEXT``: optional transcript override. Normally the
      provider reads the transcript from a sibling .txt file next to
      ``QWEN3_REF_AUDIO`` (e.g. /models/qwen3/ref_audio.txt), so swapping
      voices is just "drop two files on the PVC, no env edits". Set this
      env var only if you can't write to the same directory as the audio.
    - ``QWEN3_CHUNK_SIZE``: codec frames per streamed yield. Default 2.
    - ``QWEN3_XVEC_ONLY``: condition on the reference clip's speaker embedding
      ALONE instead of in-context reference codes. Default false.

      Why it exists: in the default ICL mode the reference clip's codec frames
      AND its transcript are prepended to every request's prompt and prefilled
      through the talker on each call — the extracted prompt is cached, but the
      forward pass over it is not. At 12Hz a 20s clip is ~240 frames against
      ~10-20 tokens of actual sentence, so the reference dominates prefill
      completely. That is why measured time-to-first-audio is ~241ms and
      CONSTANT regardless of sentence length, and why it lands as an audible
      break between sentences (each sentence is its own request).

      With this on, the model gets ``ref_code=None`` and ``ref_ids=None`` — one
      cached speaker embedding and nothing else — so the prefix disappears.
      Timbre is preserved (that is what the x-vector carries); in-context
      prosodic style transfer is not. Keep the clip trimmed to 5-10s either
      way: it still sets the x-vector, and it is what ICL mode prefills.
    - ``QWEN3_SAMPLE_RATE``: output sample rate (Hz). Default 24000.
    - ``QWEN3_VOICES_MANIFEST``: optional path to a ``voices.json`` registry
      mapping named voices to per-language reference clips (see
      ``_load_registry``). Default ``/models/qwen3/voices.json``. When the
      file is absent the provider behaves exactly as before — a single voice
      cloned from ``QWEN3_REF_AUDIO``. When present, the ``voice`` and
      ``language`` request fields select the matching clip, with a fallback
      chain that always lands on a real clip so TTS is never silent.
    """

    def __init__(self):
        self._initialized = False
        self._model: Optional["FasterQwen3TTS"] = None
        self._model_id = os.getenv("QWEN3_MODEL_ID", DEFAULT_MODEL_ID)
        self._model_path = os.getenv("QWEN3_MODEL_PATH", "")
        self._device = os.getenv("QWEN3_DEVICE", "cuda")
        self._dtype_name = os.getenv("QWEN3_DTYPE", "bfloat16")
        self._language = os.getenv("QWEN3_LANGUAGE", DEFAULT_LANGUAGE)
        self._ref_audio = os.getenv("QWEN3_REF_AUDIO", "/models/qwen3/ref_audio.mp3")
        self._ref_text = os.getenv("QWEN3_REF_TEXT", "")
        self._chunk_size = int(os.getenv("QWEN3_CHUNK_SIZE", str(DEFAULT_CHUNK_SIZE)))
        # x-vector-only conditioning. See the class docstring: this drops the
        # reference clip out of the PREFILL, which is what time-to-first-audio
        # is actually made of on this deployment.
        self._xvec_only = os.getenv("QWEN3_XVEC_ONLY", "false").strip().lower() in (
            "1", "true", "yes", "on"
        )
        self._sample_rate = int(os.getenv("QWEN3_SAMPLE_RATE", str(DEFAULT_SAMPLE_RATE)))
        self._voices_manifest = os.getenv("QWEN3_VOICES_MANIFEST", "/models/qwen3/voices.json")

        # Reference-voice registry (populated from voices.json in initialize()).
        # Shape: { voice_id: {"display_name": str, "default_language": str|"",
        #          "clips": { iso: {"audio": abs_path, "text": str|None,
        #                            "text_path": abs_path|None} }}}
        # Empty when no manifest is present → single-voice legacy behavior.
        self._registry: Dict[str, dict] = {}
        self._default_voice = "default"
        # Caches: resolved (audio_path, transcript) by (voice, language), and
        # transcripts by audio path so we read each sidecar .txt at most once.
        self._ref_cache: Dict[Tuple[str, str], Tuple[str, str]] = {}
        self._ref_text_cache: Dict[str, str] = {}

    @property
    def name(self) -> str:
        return "qwen3"

    @property
    def is_available(self) -> bool:
        return QWEN3_DEPS_AVAILABLE

    def _resolve_dtype(self):
        return {
            "bfloat16": torch.bfloat16,
            "float16": torch.float16,
            "float32": torch.float32,
        }.get(self._dtype_name.lower(), torch.bfloat16)

    def _resolve_model_source(self) -> str:
        """Prefer a local path on the PVC over the HF repo ID."""
        if self._model_path and os.path.isdir(self._model_path):
            return self._model_path
        return self._model_id

    async def initialize(self) -> bool:
        if not QWEN3_DEPS_AVAILABLE:
            print("[Qwen3] faster-qwen3-tts / torch not installed — provider unavailable")
            return False

        if self._device == "cuda" and not torch.cuda.is_available():
            print("[Qwen3] CUDA requested but not available — provider unavailable")
            return False

        if not os.path.isfile(self._ref_audio):
            print(f"[Qwen3] Reference audio not found at {self._ref_audio}.")
            print("[Qwen3] Stage a ~5-10s WAV/MP3 there plus a sibling .txt with its")
            print("[Qwen3] verbatim transcript (e.g. ref_audio.mp3 + ref_audio.txt).")
            return False

        # Resolve the transcript. Env override wins; otherwise read the
        # sibling .txt file next to the audio. Sharing transcripts via env
        # vars is painful (newlines, quotes, configmap edits), so the
        # file-next-to-audio convention is the default path.
        if not self._ref_text:
            sibling_txt = os.path.splitext(self._ref_audio)[0] + ".txt"
            if os.path.isfile(sibling_txt):
                try:
                    with open(sibling_txt, "r", encoding="utf-8") as f:
                        self._ref_text = f.read().strip()
                    print(f"[Qwen3] Loaded reference transcript from {sibling_txt} ({len(self._ref_text)} chars)")
                except Exception as e:
                    print(f"[Qwen3] Failed to read transcript at {sibling_txt}: {e}")
                    return False
            else:
                print(f"[Qwen3] No transcript found. Expected a sibling file at {sibling_txt}")
                print("[Qwen3] (or set QWEN3_REF_TEXT env to override).")
                return False

        source = self._resolve_model_source()
        dtype = self._resolve_dtype()
        print(f"[Qwen3] Loading {source} on {self._device} ({self._dtype_name})...")
        try:
            loop = asyncio.get_event_loop()
            t0 = time.time()
            # The from_pretrained call is blocking and GPU-heavy; run it
            # in the default executor so the event loop stays responsive.
            self._model = await loop.run_in_executor(
                None,
                lambda: FasterQwen3TTS.from_pretrained(
                    source,
                    device=self._device,
                    dtype=dtype,
                ),
            )
            print(f"[Qwen3] Model loaded in {time.time() - t0:.1f}s")
        except Exception as e:
            print(f"[Qwen3] Model load failed: {e}")
            import traceback
            traceback.print_exc()
            return False

        # Build the reference-voice registry from voices.json (if present).
        # Done after the default clip is validated above so the registry can
        # fall back to it. Failures here are non-fatal: a bad/absent manifest
        # degrades to the single default voice rather than failing init.
        self._load_registry()

        self._initialized = True
        if not await self._warm_up():
            # A model that can't even synthesize a warm-up phrase is unusable
            # (most commonly a non-Base variant: CustomVoice/VoiceDesign do not
            # support create_voice_clone_prompt, which this provider relies on).
            # Fail init loudly so the service surfaces the problem / falls back
            # instead of becoming the primary provider that silently returns no
            # audio.
            print("[Qwen3] Warm-up produced no audio — marking provider UNAVAILABLE.")
            print(f"[Qwen3] QWEN3_MODEL_ID={self._model_id!r}. Reference-clip voice")
            print("[Qwen3] cloning requires a -Base model (e.g. Qwen/Qwen3-TTS-12Hz-1.7B-Base).")
            print("[Qwen3] CustomVoice / VoiceDesign variants are NOT supported here.")
            self._initialized = False
            return False
        return True

    async def _warm_up(self) -> bool:
        """Run a tiny synth to capture CUDA graphs and prime kernels.

        Returns True only if the warm-up actually produced audio. synthesize()
        swallows its own exceptions and returns None, so we must check the
        return value — otherwise a model that can't synthesize at all would
        still report a successful warm-up."""
        try:
            t0 = time.time()
            result = await self.synthesize("Hi.")
            if result is None:
                print("[Qwen3] Warm-up synthesis returned no audio.")
                return False
            print(f"[Qwen3] Warm-up complete in {(time.time() - t0) * 1000:.0f}ms")
            return True
        except Exception as e:
            print(f"[Qwen3] Warm-up failed: {e}")
            return False

    def _to_int16_numpy(self, chunk) -> np.ndarray:
        """Convert a model audio chunk (torch tensor or numpy) to int16 PCM.

        faster-qwen3-tts yields float tensors in [-1, 1] on the model
        device. We move to CPU only here, once per chunk, to keep the GPU
        loop tight. Using ``.cpu().numpy()`` on a bfloat16 tensor errors,
        so we cast to float32 first.
        """
        if torch is not None and isinstance(chunk, torch.Tensor):
            t = chunk.detach()
            if t.dtype != torch.float32:
                t = t.float()
            arr = t.cpu().numpy()
        else:
            arr = np.asarray(chunk, dtype=np.float32)
        if arr.ndim > 1:
            arr = arr.reshape(-1)
        return (np.clip(arr, -1.0, 1.0) * 32767.0).astype(np.int16)

    def _resolve_language(self, override: Optional[str]) -> Optional[str]:
        """Pick the effective language label, or None for autodetect.

        Empty string and the literal "Auto" both map to None so we can
        carry the wizard's "Auto" option straight through. ISO 639-1 codes
        (e.g. "en") are translated to the full names the model expects
        ("English"); any label the model doesn't know falls back to
        autodetect (None) rather than crashing the synthesis stream.
        """
        candidate = (override if override is not None else self._language) or ""
        candidate = candidate.strip()
        if not candidate or candidate.lower() == "auto":
            return None
        key = candidate.lower()
        # ISO 639-1 code → model language name (e.g. "en" → "English").
        if key in _ISO_TO_QWEN3_LANGUAGE:
            return _ISO_TO_QWEN3_LANGUAGE[key]
        # Already a full name the model knows (case-insensitive).
        if key in _QWEN3_LANGUAGE_NAMES:
            return _QWEN3_LANGUAGE_NAMES[key]
        # Unknown label: don't risk "Language X not implemented" — autodetect.
        print(f"[Qwen3] Unknown language label '{candidate}', falling back to autodetect")
        return None

    def _normalize_iso(self, language: Optional[str]) -> Optional[str]:
        """Reduce a language hint to a base ISO 639-1 code for clip keying.

        "de-AT" → "de", "German" → "de", "en" → "en". Empty / "Auto" / an
        unknown label → None (meaning "no specific clip language"). This is
        purely for *registry lookup*; the label actually handed to the model
        still goes through ``_resolve_language``.
        """
        candidate = (language or "").strip().lower()
        if not candidate or candidate == "auto":
            return None
        # Strip a region/script subtag: "de-at", "zh_hans" → "de", "zh".
        base = candidate.replace("_", "-").split("-", 1)[0]
        if base in _ISO_TO_QWEN3_LANGUAGE:
            return base
        # A full language name ("german") → its ISO code.
        if candidate in _QWEN3_NAME_TO_ISO:
            return _QWEN3_NAME_TO_ISO[candidate]
        # Unknown but well-formed code: keep it so a manifest that uses an ISO
        # code we don't map (e.g. a future addition) can still match a clip.
        return base or None

    def _load_registry(self) -> None:
        """Load the reference-voice registry from ``voices.json``.

        Manifest shape (paths relative to the manifest's directory)::

            {
              "default_voice": "stella",
              "voices": [
                {
                  "id": "stella",
                  "display_name": "Stella",
                  "default_language": "en",
                  "clips": {
                    "en": {"audio": "stella_en.mp3", "text": "stella_en.txt"},
                    "de": {"audio": "stella_de.mp3"}
                  }
                }
              ]
            }

        ``text`` is optional — when omitted the provider reads the sibling
        ``.txt`` next to the audio (the existing convention). A missing
        manifest leaves the registry empty, which the resolver treats as
        "single default voice" — identical to the pre-#311 behavior.
        """
        self._registry = {}
        self._ref_cache = {}
        self._default_voice = "default"

        manifest = self._voices_manifest
        if not manifest or not os.path.isfile(manifest):
            print(f"[Qwen3] No voices manifest at {manifest!r}; using single default voice")
            return

        try:
            with open(manifest, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            print(f"[Qwen3] Failed to read voices manifest {manifest}: {e} — using single default voice")
            return

        base_dir = os.path.dirname(os.path.abspath(manifest))
        voices = data.get("voices") if isinstance(data, dict) else None
        if not isinstance(voices, list):
            print(f"[Qwen3] voices manifest has no 'voices' list — using single default voice")
            return

        registry: Dict[str, dict] = {}
        for raw in voices:
            if not isinstance(raw, dict):
                continue
            vid = str(raw.get("id") or "").strip()
            if not vid:
                continue
            clips_raw = raw.get("clips") if isinstance(raw.get("clips"), dict) else {}
            clips: Dict[str, dict] = {}
            for lang, clip in clips_raw.items():
                iso = self._normalize_iso(str(lang))
                if not iso or not isinstance(clip, dict):
                    continue
                audio = clip.get("audio")
                if not audio:
                    continue
                audio_path = audio if os.path.isabs(audio) else os.path.join(base_dir, audio)
                text_val = clip.get("text")
                text_path = None
                if text_val and not os.path.isabs(text_val):
                    text_path = os.path.join(base_dir, text_val)
                elif text_val:
                    text_path = text_val
                if not os.path.isfile(audio_path):
                    print(f"[Qwen3] voices[{vid}].{iso}: audio not found at {audio_path} — skipping clip")
                    continue
                clips[iso] = {"audio": audio_path, "text_path": text_path}
            if not clips:
                print(f"[Qwen3] voice '{vid}' has no usable clips — skipping")
                continue
            default_language = self._normalize_iso(str(raw.get("default_language") or "")) or next(iter(clips))
            registry[vid] = {
                "display_name": str(raw.get("display_name") or vid),
                "default_language": default_language,
                "clips": clips,
            }

        if not registry:
            print(f"[Qwen3] voices manifest yielded no usable voices — using single default voice")
            return

        self._registry = registry
        requested_default = str(data.get("default_voice") or "").strip()
        if requested_default in registry:
            self._default_voice = requested_default
        else:
            self._default_voice = next(iter(registry))
            if requested_default:
                print(f"[Qwen3] default_voice '{requested_default}' not in registry; using '{self._default_voice}'")
        summary = ", ".join("{}({} langs)".format(v, len(registry[v]["clips"])) for v in registry)
        print(
            f"[Qwen3] Loaded {len(registry)} voice(s) from {manifest}: "
            f"{summary} (default '{self._default_voice}')"
        )

    def _clip_text(self, clip: dict) -> str:
        """Resolve a clip's transcript (cached). Empty string if unavailable.

        Prefers an explicit ``text_path`` from the manifest; otherwise the
        sibling ``.txt`` next to the audio. Voice cloning needs a transcript,
        so the resolver treats an empty result as a miss and keeps falling
        back rather than synthesizing with no reference text.
        """
        audio = clip["audio"]
        if audio in self._ref_text_cache:
            return self._ref_text_cache[audio]
        text_path = clip.get("text_path") or (os.path.splitext(audio)[0] + ".txt")
        text = ""
        if os.path.isfile(text_path):
            try:
                with open(text_path, "r", encoding="utf-8") as f:
                    text = f.read().strip()
            except Exception as e:
                print(f"[Qwen3] Failed to read transcript {text_path}: {e}")
                text = ""
        else:
            print(f"[Qwen3] Transcript not found for {audio} (expected {text_path})")
        self._ref_text_cache[audio] = text
        return text

    def _resolve_voice_id(self, voice: Optional[str]) -> str:
        """Map a requested voice name to a registry id, or the default voice."""
        if voice:
            v = voice.strip()
            if v in self._registry:
                return v
            for vid in self._registry:
                if vid.lower() == v.lower():
                    return vid
            if v:
                print(f"[Qwen3] Unknown voice '{voice}', falling back to default voice '{self._default_voice}'")
        return self._default_voice

    def _resolve_ref(self, voice: Optional[str], language: Optional[str]) -> Tuple[str, str]:
        """Resolve the reference (audio_path, transcript) for a request.

        Fallback chain — each step must point at a clip that exists on disk
        *and* has a transcript, otherwise we fall through:

          (voice, language) → (voice, voice.default_language)
            → (default_voice, language) → (default_voice, its default)
            → the bundled QWEN3_REF_AUDIO clip.

        The final step guarantees we never return without a clip, so a
        missing/unknown voice or language degrades to "wrong voice" rather
        than silence — same defensive stance as language autodetect.
        """
        cache_key = ((voice or "").strip().lower(), (language or "").strip().lower())
        cached = self._ref_cache.get(cache_key)
        if cached is not None:
            return cached

        lang = self._normalize_iso(language)
        voice_id = self._resolve_voice_id(voice)
        resolved: Optional[Tuple[str, str]] = None
        # Try the requested voice first, then the default voice; within each,
        # the requested language then that voice's own default language.
        seen_voices = []
        for vid in (voice_id, self._default_voice):
            if vid in seen_voices:
                continue
            seen_voices.append(vid)
            entry = self._registry.get(vid)
            if not entry:
                continue
            for l in (lang, entry.get("default_language")):
                if not l:
                    continue
                clip = entry["clips"].get(l)
                if not clip:
                    continue
                text = self._clip_text(clip)
                if text:
                    resolved = (clip["audio"], text)
                    break
            if resolved:
                break

        if resolved is None:
            # Never silent: the bundled clip validated at initialize().
            resolved = (self._ref_audio, self._ref_text)

        self._ref_cache[cache_key] = resolved
        return resolved

    def get_capabilities(self) -> ProviderCapabilities:
        """Report selectable voices and synthesizable languages.

        ``languages`` is the broad set of languages Qwen3 can *speak* (it
        autodetects or honors any mapped ISO code even with a single clip),
        not just the languages that have a native clip — so an agent can be
        configured for a language before its clip exists, and the audio
        improves automatically once the clip is dropped on the PVC. Each
        voice's own ``languages`` list reports which languages it has a
        native clip for (informational).
        """
        voices = []
        if self._registry:
            for vid, entry in self._registry.items():
                voices.append(
                    VoiceInfo(
                        id=vid,
                        display_name=entry["display_name"],
                        languages=sorted(entry["clips"].keys()),
                        default_language=entry["default_language"],
                    )
                )
        else:
            voices.append(
                VoiceInfo(
                    id=self._default_voice,
                    display_name="Default",
                    languages=[],
                    default_language=self._normalize_iso(self._language) or "",
                )
            )
        return ProviderCapabilities(
            voices=voices,
            languages=sorted(_ISO_TO_QWEN3_LANGUAGE.keys()),
            default_voice=self._default_voice,
            supports_voice_selection=len(voices) > 1,
        )

    async def synthesize(
        self,
        text: str,
        voice: Optional[str] = None,
        speed: float = 1.0,  # not exposed by faster-qwen3-tts; accepted for parity
        language: Optional[str] = None,
    ) -> Optional[Tuple[np.ndarray, int]]:
        if not self._initialized or self._model is None:
            print("[Qwen3] Not initialized")
            return None
        if not text or not text.strip():
            return None

        lang = self._resolve_language(language)
        ref_audio, ref_text = self._resolve_ref(voice, language)

        def _run():
            audio_list, sr = self._model.generate_voice_clone(
                text=text,
                language=lang,
                ref_audio=ref_audio,
                ref_text=ref_text,
                xvec_only=self._xvec_only,
            )
            return audio_list, sr

        try:
            loop = asyncio.get_event_loop()
            t0 = time.time()
            audio_list, sr = await loop.run_in_executor(None, _run)
            # generate_voice_clone returns a list of chunks or one tensor.
            if isinstance(audio_list, list):
                int16_parts = [self._to_int16_numpy(c) for c in audio_list if c is not None]
                if not int16_parts:
                    return None
                int16 = np.concatenate(int16_parts)
            else:
                int16 = self._to_int16_numpy(audio_list)
            audio = (int16.astype(np.float32) / 32767.0)
            print(f"[Qwen3] Synthesized {len(audio)} samples in {(time.time() - t0) * 1000:.0f}ms")
            return audio, int(sr or self._sample_rate)
        except Exception as e:
            print(f"[Qwen3] Synthesis failed: {e}")
            import traceback
            traceback.print_exc()
            return None

    async def synthesize_stream(
        self,
        text: str,
        voice: Optional[str] = None,
        speed: float = 1.0,
        chunk_size: int = 480,
        language: Optional[str] = None,
    ) -> AsyncGenerator[Tuple[np.ndarray, bool], None]:
        """Streaming synthesis.

        The model's own ``generate_voice_clone_streaming`` is a synchronous
        generator that yields PCM chunks as the decoder produces them. We
        pump those chunks from a worker thread into an asyncio.Queue, then
        re-slice into ``chunk_size``-sample int16 frames for the gRPC
        consumer. TTFB ≈ model prefill + one codec step.
        """
        if not self._initialized or self._model is None:
            print("[Qwen3] Not initialized")
            return
        if not text or not text.strip():
            return

        codec_chunk = self._chunk_size
        loop = asyncio.get_event_loop()

        # Try the resolved language first. If synthesis fails *before* emitting
        # any audio (e.g. a label the model can't handle slips past
        # normalization), fall back once to autodetect (None) so a language
        # problem degrades to "wrong-accent audio" instead of silence. Once a
        # frame has been yielded we're committed to that attempt — we can't
        # un-send audio to the consumer, so we never retry mid-stream.
        resolved = self._resolve_language(language)
        attempts = [resolved] if resolved is None else [resolved, None]
        # Reference clip is chosen by (voice, language) and stays fixed across
        # the language-autodetect retry below — the retry only changes the
        # label handed to the model, not which voice we clone.
        ref_audio, ref_text = self._resolve_ref(voice, language)

        for attempt_idx, attempt_lang in enumerate(attempts):
            queue: asyncio.Queue = asyncio.Queue(maxsize=16)
            # Set on early consumer exit (barge-in -> GeneratorExit) so the worker
            # thread stops synthesizing into an abandoned queue.
            stop_event = threading.Event()

            def _producer(attempt_lang=attempt_lang, queue=queue, stop_event=stop_event,
                          ref_audio=ref_audio, ref_text=ref_text, xvec_only=self._xvec_only):
                try:
                    for audio_chunk, _sr, _timing in self._model.generate_voice_clone_streaming(
                        text=text,
                        language=attempt_lang,
                        ref_audio=ref_audio,
                        ref_text=ref_text,
                        chunk_size=codec_chunk,
                        xvec_only=xvec_only,
                    ):
                        if stop_event.is_set():
                            break
                        # Back-pressured handoff: block this worker thread until the
                        # consumer frees a slot rather than dropping audio when the
                        # bounded queue is full (put_nowait would raise QueueFull
                        # inside call_soon_threadsafe and be swallowed -> silent gap).
                        try:
                            asyncio.run_coroutine_threadsafe(queue.put(audio_chunk), loop).result()
                        except RuntimeError:
                            break  # event loop gone (shutdown) — stop producing
                except Exception as e:
                    loop.call_soon_threadsafe(queue.put_nowait, e)
                finally:
                    loop.call_soon_threadsafe(queue.put_nowait, _QWEN3_STREAM_DONE)

            t0 = time.time()
            producer_fut = loop.run_in_executor(None, _producer)

            first_yielded = False
            errored = False
            leftover = np.empty(0, dtype=np.int16)

            try:
                while True:
                    item = await queue.get()
                    if isinstance(item, Exception):
                        errored = True
                        print(f"[Qwen3] Streaming error (language={attempt_lang!r}): {item}")
                        break
                    if item is _QWEN3_STREAM_DONE:
                        if len(leftover):
                            yield (leftover, True)
                        elif first_yielded:
                            yield (np.empty(0, dtype=np.int16), True)
                        break

                    int16 = self._to_int16_numpy(item)
                    if len(leftover):
                        int16 = np.concatenate([leftover, int16])

                    if not first_yielded:
                        mode = "xvec" if self._xvec_only else "icl"
                        print(
                            f"[Qwen3] First audio in {(time.time() - t0) * 1000:.0f}ms "
                            f"(stream, {mode})"
                        )

                    total = len(int16)
                    full = total - (total % chunk_size)
                    for i in range(0, full, chunk_size):
                        yield (int16[i:i + chunk_size], False)
                        first_yielded = True
                    leftover = int16[full:]

                await producer_fut
            finally:
                # Stop + unblock the producer so a cancelled stream doesn't leak a
                # worker thread mid-synthesis (parked on a full queue).
                stop_event.set()
                while not queue.empty():
                    try:
                        queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break

            if first_yielded:
                print(f"[Qwen3] Stream completed in {(time.time() - t0) * 1000:.0f}ms")
                return
            if errored and attempt_idx + 1 < len(attempts):
                print("[Qwen3] Retrying synthesis with autodetect (language=None)")
                continue
            return

    async def cleanup(self) -> None:
        self._model = None
        self._initialized = False
        if torch is not None and torch.cuda.is_available():
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass
        print("[Qwen3] Cleanup completed")
