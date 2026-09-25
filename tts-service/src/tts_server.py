#!/usr/bin/env python3
"""
TTS gRPC Service supporting Piper, Kokoro, and ChatterBox providers.
Provides a standardized gRPC interface for text-to-speech synthesis.
"""

import asyncio
import grpc
from concurrent import futures
import numpy as np
import os
import sys
import time

# Add parent directory to path for proto imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import tts_pb2
import tts_pb2_grpc

from providers import KokoroProvider, PiperProvider, ChatterBoxProvider, Qwen3Provider, TTSProvider


class TTSEngine:
    """TTS Engine that manages provider selection and fallback."""

    def __init__(self):
        self.provider: TTSProvider = None
        self.fallback_provider: TTSProvider = None
        self.provider_name = "none"
        self.initialized = False
        # Synthesis calls in flight (real requests and warmups). The keep-alive
        # skips a tick while this is non-zero: a busy model is already warm, and
        # on the shared GPU a throwaway synthesis would compete with live speech.
        self._active = 0
        # True while a warmup synthesis runs. Live requests wait for it to
        # finish, and a warmup never starts while any live request is in flight:
        # two syntheses on one model instance is the cross-session garbling
        # tracked in #463, and a background timer must not cause it.
        self._warming = False
        self._gate = asyncio.Condition()
        # Seconds between keep-alive warmups; 0 disables. Runs only when the
        # provider can go cold (kernels/CUDA graphs evicted while idle).
        self.keepalive_interval = float(os.getenv("TTS_KEEPALIVE_INTERVAL", "180"))
        # The deployment-wide switch (STELLA_MODEL_KEEP_WARM, asked in the setup
        # wizard) turns the keep-alive off for STT and TTS together.
        if os.getenv("STELLA_MODEL_KEEP_WARM", "true").strip().lower() in ("false", "0", "no", "off"):
            self.keepalive_interval = 0
        self._keepalive_task = None

    async def initialize(self) -> bool:
        """Initialize TTS with provider selection based on TTS_PROVIDER env var."""
        try:
            tts_provider = os.getenv('TTS_PROVIDER', 'piper').lower()
            print(f"[TTS Engine] TTS_PROVIDER={tts_provider}")

            # Create providers. Each provider's deps are installed only when
            # the image was built with --build-arg TTS_PROVIDER=<that one>,
            # so providers other than the chosen one will report
            # is_available=False and be skipped silently.
            kokoro_provider = KokoroProvider()
            piper_provider = PiperProvider()
            chatterbox_provider = ChatterBoxProvider()
            qwen3_provider = Qwen3Provider()

            # The ordering below is the *intended* preference; the actual
            # winner is whichever provider's deps the image was built with.
            if tts_provider == 'piper':
                primary_providers = [piper_provider]
            elif tts_provider == 'chatterbox':
                primary_providers = [chatterbox_provider]
            elif tts_provider == 'kokoro':
                primary_providers = [kokoro_provider]
            elif tts_provider == 'qwen3':
                primary_providers = [qwen3_provider]
            elif tts_provider == 'auto':
                # Auto only includes the providers the Dockerfile installs
                # in `auto` mode (piper + kokoro). Other providers are not
                # present in an auto-built image.
                primary_providers = [piper_provider, kokoro_provider]
            else:
                # Default to Piper.
                primary_providers = [piper_provider]

            # Try to initialize providers in priority order
            for provider in primary_providers:
                if provider.is_available:
                    print(f"[TTS Engine] Trying to initialize {provider.name}...")
                    if await provider.initialize():
                        self.provider = provider
                        self.provider_name = provider.name
                        print(f"[TTS Engine] Primary provider: {provider.name}")
                        break
                    else:
                        print(f"[TTS Engine] {provider.name} initialization failed")
                else:
                    print(f"[TTS Engine] {provider.name} not available")

            # Set up fallback provider
            if self.provider:
                for provider in primary_providers:
                    if provider != self.provider and provider.is_available:
                        if await provider.initialize():
                            self.fallback_provider = provider
                            print(f"[TTS Engine] Fallback provider: {provider.name}")
                            break

            self.initialized = self.provider is not None
            return self.initialized

        except Exception as e:
            print(f"[TTS Engine] Initialization error: {e}")
            import traceback
            traceback.print_exc()
            return False

    async def synthesize(
        self,
        text: str,
        voice: str = None,
        speed: float = 1.0,
        language: str = None,
    ) -> tuple[bytes, int, int]:
        """Synthesize text to audio bytes.

        Returns:
            Tuple of (audio_bytes, sample_rate, duration_ms)
        """
        if not self.initialized or not self.provider:
            raise RuntimeError("TTS Engine not initialized")

        await self._enter_live()
        try:
            # Try primary provider
            result = await self.provider.synthesize(text, voice, speed, language=language)

            # Fallback if primary fails
            if result is None and self.fallback_provider:
                print(f"[TTS Engine] Primary provider failed, trying fallback...")
                result = await self.fallback_provider.synthesize(text, voice, speed, language=language)
        finally:
            self._active -= 1

        if result is None:
            raise RuntimeError(f"All TTS providers failed for text: {text[:50]}...")

        audio_data, sample_rate = result

        # Debug: log float32 audio stats
        print(f"[TTS Engine] Float32 audio: {len(audio_data)} samples, "
              f"range=[{np.min(audio_data):.4f}, {np.max(audio_data):.4f}]")

        # Convert float32 audio to int16 bytes
        audio_int16 = (np.clip(audio_data, -1.0, 1.0) * 32767).astype(np.int16)
        audio_bytes = audio_int16.tobytes()

        # Debug: log int16 audio stats
        print(f"[TTS Engine] Int16 audio: {len(audio_int16)} samples, "
              f"range=[{np.min(audio_int16)}, {np.max(audio_int16)}], "
              f"bytes={len(audio_bytes)}")

        # Calculate duration
        duration_ms = int(len(audio_int16) / sample_rate * 1000)

        return audio_bytes, sample_rate, duration_ms

    async def synthesize_stream(
        self,
        text: str,
        voice: str = None,
        speed: float = 1.0,
        chunk_size: int = 480,
        language: str = None,
    ):
        """Synthesize text to streaming audio chunks.

        Yields:
            Tuples of (audio_chunk_bytes, is_final, chunk_index)
        """
        if not self.initialized or not self.provider:
            raise RuntimeError("TTS Engine not initialized")

        chunk_index = 0
        await self._enter_live()
        try:
            async for chunk, is_final in self.provider.synthesize_stream(text, voice, speed, chunk_size, language=language):
                yield chunk.tobytes(), is_final, chunk_index
                chunk_index += 1
        finally:
            await self._exit_live()

    async def _enter_live(self) -> None:
        """Count a live request in, first waiting out any warmup in progress."""
        async with self._gate:
            await self._gate.wait_for(lambda: not self._warming)
            self._active += 1

    async def _exit_live(self) -> None:
        async with self._gate:
            self._active -= 1
            self._gate.notify_all()

    async def warmup(self) -> tuple:
        """Run a tiny throwaway synthesis to prime the model.

        Returns (success, elapsed_ms, message). Uses synthesize (not the
        stream) because only the side effect of running once matters.
        """
        t0 = time.time()
        if not self.initialized or self.provider is None:
            return False, 0, "TTS engine not initialized"
        # No await between this check and setting _warming, so a live request
        # cannot slip in between them on the event loop.
        if self._active > 0 or self._warming:
            return True, 0, "skipped: synthesis in progress, model already warm"
        self._warming = True
        try:
            result = await self.provider.synthesize("Hi.")
        except Exception as e:
            return False, int((time.time() - t0) * 1000), f"warm-up failed: {e}"
        finally:
            async with self._gate:
                self._warming = False
                self._gate.notify_all()
        elapsed_ms = int((time.time() - t0) * 1000)
        if result is None:
            return False, elapsed_ms, "Warm-up synthesis returned no audio"
        return True, elapsed_ms, "ok"

    def start_keepalive(self) -> None:
        """Warm up now, then every TTS_KEEPALIVE_INTERVAL seconds (needs a running loop)."""
        if self.keepalive_interval <= 0:
            print("[TTS Engine] Keep-alive disabled (TTS_KEEPALIVE_INTERVAL=0)")
            return
        if self._keepalive_task is not None and not self._keepalive_task.done():
            return
        self._keepalive_task = asyncio.create_task(self._keepalive_loop())
        print(f"[TTS Engine] Keep-alive started (every {self.keepalive_interval:.0f}s)")

    async def _keepalive_loop(self) -> None:
        # First pass runs at once: the model is warm before the first session.
        while True:
            ok, elapsed_ms, message = await self.warmup()
            print(f"[TTS Engine] Keep-alive warmup: ok={ok}, {elapsed_ms}ms, {message}")
            await asyncio.sleep(self.keepalive_interval)

    async def cleanup(self):
        """Clean up all providers."""
        if self._keepalive_task is not None:
            self._keepalive_task.cancel()
            self._keepalive_task = None
        if self.provider:
            await self.provider.cleanup()
        if self.fallback_provider:
            await self.fallback_provider.cleanup()


class TextToSpeechServicer(tts_pb2_grpc.TextToSpeechServicer):
    """gRPC service implementation for Text-to-Speech."""

    def __init__(self):
        self.engine = TTSEngine()
        print("[TTS Service] Servicer created")

    async def initialize(self):
        """Initialize the TTS engine."""
        success = await self.engine.initialize()
        print(f"[TTS Service] Initialization: {'success' if success else 'failed'}")
        return success

    async def Synthesize(self, request, context):
        """Synthesize text to complete audio response."""
        try:
            text = request.text
            if not text or not text.strip():
                context.abort(grpc.StatusCode.INVALID_ARGUMENT, "Empty text")
                return tts_pb2.SynthesizeResponse()

            print(f"[TTS Service] Synthesize request: '{text[:50]}...' session={request.session_id} lang={request.language}")

            audio_bytes, sample_rate, duration_ms = await self.engine.synthesize(
                text=text,
                voice=request.voice if request.voice else None,
                speed=request.speed if request.speed > 0 else 1.0,
                language=request.language if request.language else None,
            )

            print(f"[TTS Service] Synthesized {len(audio_bytes)} bytes, {duration_ms}ms")

            return tts_pb2.SynthesizeResponse(
                audio_data=audio_bytes,
                sample_rate=sample_rate,
                duration_ms=duration_ms,
            )

        except Exception as e:
            print(f"[TTS Service] Synthesize error: {e}")
            context.abort(grpc.StatusCode.INTERNAL, str(e))
            return tts_pb2.SynthesizeResponse()

    async def SynthesizeStream(self, request, context):
        """Synthesize text to streaming audio chunks."""
        try:
            text = request.text
            if not text or not text.strip():
                context.abort(grpc.StatusCode.INVALID_ARGUMENT, "Empty text")
                return

            print(f"[TTS Service] SynthesizeStream request: '{text[:50]}...'")

            async for audio_bytes, is_final, chunk_index in self.engine.synthesize_stream(
                text=text,
                voice=request.voice if request.voice else None,
                speed=request.speed if request.speed > 0 else 1.0,
                language=request.language if request.language else None,
            ):
                yield tts_pb2.AudioChunk(
                    audio_data=audio_bytes,
                    is_final=is_final,
                    chunk_index=chunk_index,
                )

            print(f"[TTS Service] Stream completed")

        except Exception as e:
            print(f"[TTS Service] SynthesizeStream error: {e}")
            context.abort(grpc.StatusCode.INTERNAL, str(e))

    async def Warmup(self, request, context):
        """Warm up the active TTS provider.

        The provider's own initialize() already runs a warm-up at startup,
        but providers can go cold between requests (e.g. a kokoro pod that's
        been idle long enough for the GPU context to be reset by the
        scheduler, or a Qwen3 model whose CUDA-graph cache was evicted).
        This RPC lets the agent re-prime the model at session start without
        racing the user's first utterance.
        """
        success, elapsed_ms, message = await self.engine.warmup()
        if success:
            print(f"[TTS Service] Warmup completed in {elapsed_ms}ms (session={request.session_id})")
        else:
            print(f"[TTS Service] Warmup failed: {message}")
        return tts_pb2.WarmupResponse(
            success=success,
            warmup_time_ms=elapsed_ms,
            provider=self.engine.provider_name,
            message=message,
        )

    async def HealthCheck(self, request, context):
        """Health check endpoint."""
        return tts_pb2.HealthResponse(
            healthy=self.engine.initialized,
            provider=self.engine.provider_name,
            version="1.0.0",
        )

    async def GetCapabilities(self, request, context):
        """Report the active provider's selectable voices and languages.

        Delegates to the active provider so the catalog always matches what
        will actually synthesize. Returns an empty (no-selection) catalog if
        no provider is initialized rather than erroring, so the UI can render
        a sane "voice selection unavailable" state.
        """
        provider = self.engine.provider
        if provider is None:
            return tts_pb2.CapabilitiesResponse(
                provider=self.engine.provider_name,
                supports_voice_selection=False,
            )
        caps = provider.get_capabilities()
        return tts_pb2.CapabilitiesResponse(
            provider=self.engine.provider_name,
            voices=[
                tts_pb2.VoiceInfo(
                    id=v.id,
                    display_name=v.display_name,
                    languages=list(v.languages),
                    default_language=v.default_language,
                )
                for v in caps.voices
            ],
            languages=list(caps.languages),
            default_voice=caps.default_voice,
            supports_voice_selection=caps.supports_voice_selection,
        )


async def serve():
    """Start the gRPC server."""
    port = os.getenv("GRPC_PORT", "50052")

    server = grpc.aio.server(
        futures.ThreadPoolExecutor(max_workers=10),
        options=[
            ('grpc.max_receive_message_length', 50 * 1024 * 1024),  # 50MB
            ('grpc.max_send_message_length', 50 * 1024 * 1024),
        ]
    )

    servicer = TextToSpeechServicer()

    # Initialize TTS engine
    if not await servicer.initialize():
        print("[TTS Service] CRITICAL: Failed to initialize TTS engine!")
        print("[TTS Service] Server will start but synthesize requests will fail")
    else:
        servicer.engine.start_keepalive()

    tts_pb2_grpc.add_TextToSpeechServicer_to_server(servicer, server)
    server.add_insecure_port(f'[::]:{port}')

    await server.start()
    print(f"[TTS Service] Server started on port {port}")
    print(f"[TTS Service] Provider: {servicer.engine.provider_name}")
    print(f"[TTS Service] Ready to accept connections")

    await server.wait_for_termination()


if __name__ == '__main__':
    print("=" * 60)
    print("TTS gRPC Service")
    print("=" * 60)
    asyncio.run(serve())
