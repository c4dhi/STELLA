#!/usr/bin/env python3
"""
STT gRPC Service with pluggable providers.

Supports:
- Sherpa-ONNX: Lightweight streaming model for development (~180MB)
- faster-whisper: GPU-accelerated model for production (~3GB for large-v3)

Provider selection via STT_PROVIDER environment variable:
- 'sherpa' (default): Use Sherpa-ONNX
- 'whisper': Use faster-whisper with Silero VAD
"""
import asyncio
import grpc
from concurrent import futures
import os
import sys
from typing import Optional

# Add parent directory to path for proto imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import stt_pb2
import stt_pb2_grpc

from providers import STTProvider, SherpaProvider, WhisperProvider


class STTEngine:
    """STT Engine with provider selection and fallback."""

    def __init__(self):
        self.provider: Optional[STTProvider] = None
        self.fallback_provider: Optional[STTProvider] = None
        self.provider_name = "none"
        self.initialized = False

    async def initialize(self) -> bool:
        """Initialize STT engine with configured provider."""
        stt_provider_env = os.getenv('STT_PROVIDER', 'sherpa').lower()
        print(f"[STT Engine] STT_PROVIDER={stt_provider_env}")

        # Create provider instances
        sherpa = SherpaProvider()
        whisper = WhisperProvider()

        # Determine priority order based on STT_PROVIDER
        if stt_provider_env == 'whisper':
            providers = [whisper, sherpa]
            print("[STT Engine] Priority: whisper -> sherpa (fallback)")
        else:
            providers = [sherpa, whisper]
            print("[STT Engine] Priority: sherpa -> whisper (fallback)")

        # Initialize primary provider
        for provider in providers:
            if provider.is_available:
                print(f"[STT Engine] Attempting to initialize {provider.name}...")
                try:
                    if await provider.initialize():
                        self.provider = provider
                        self.provider_name = provider.name
                        print(f"[STT Engine] ✓ PRIMARY PROVIDER: {provider.name}")
                        break
                    else:
                        print(f"[STT Engine] ✗ {provider.name} initialization returned False")
                except Exception as e:
                    print(f"[STT Engine] ✗ {provider.name} initialization failed: {e}")
                    import traceback
                    traceback.print_exc()
            else:
                print(f"[STT Engine] ✗ {provider.name} not available (dependencies missing)")

        if not self.provider:
            print("[STT Engine] CRITICAL: No STT provider available!")
            return False

        # Set up fallback provider (optional)
        for provider in providers:
            if provider != self.provider and provider.is_available:
                try:
                    if await provider.initialize():
                        self.fallback_provider = provider
                        print(f"[STT Engine] Fallback provider: {provider.name}")
                        break
                except Exception as e:
                    print(f"[STT Engine] Fallback {provider.name} init failed: {e}")

        self.initialized = True
        return True

    def get_status(self) -> dict:
        """Get engine status information."""
        return {
            "initialized": self.initialized,
            "primary_provider": self.provider_name,
            "fallback_provider": self.fallback_provider.name if self.fallback_provider else None,
            "capabilities": self.provider.get_capabilities() if self.provider else {},
        }

    async def warmup(self, duration_ms: int = 1000) -> dict:
        """Warm up the STT provider to eliminate cold-start latency.

        Args:
            duration_ms: Duration of dummy audio to process

        Returns:
            Dict with warmup result: success, warmup_time_ms, provider, message
        """
        import time
        start_time = time.time()

        if not self.provider:
            return {
                "success": False,
                "warmup_time_ms": 0,
                "provider": "none",
                "message": "No STT provider available",
            }

        try:
            success = await self.provider.warmup(duration_ms)
            warmup_time_ms = int((time.time() - start_time) * 1000)

            return {
                "success": success,
                "warmup_time_ms": warmup_time_ms,
                "provider": self.provider_name,
                "message": "Warmup completed" if success else "Warmup failed",
            }
        except Exception as e:
            warmup_time_ms = int((time.time() - start_time) * 1000)
            return {
                "success": False,
                "warmup_time_ms": warmup_time_ms,
                "provider": self.provider_name,
                "message": f"Warmup error: {e}",
            }


class SpeechToTextServicer(stt_pb2_grpc.SpeechToTextServicer):
    """gRPC service implementation for Speech-to-Text."""

    def __init__(self, engine: STTEngine):
        self.engine = engine
        print(f"[STT Service] Servicer initialized with provider: {engine.provider_name}")

    async def StreamTranscribe(self, request_iterator, context):
        """Bidirectional streaming RPC for transcription."""
        session = None

        try:
            async for chunk in request_iterator:
                # Initialize session on first chunk
                if session is None:
                    if not self.engine.provider:
                        print("[STT Service] ERROR: No provider available")
                        return

                    session = self.engine.provider.create_session(
                        session_id=chunk.session_id,
                        participant_id=chunk.participant_id
                    )

                    if not session:
                        print("[STT Service] ERROR: Failed to create session")
                        return

                    print(f"[STT Service] New session: {chunk.session_id}, "
                          f"participant: {chunk.participant_id}, "
                          f"provider: {self.engine.provider_name}")

                # Forward the agent's language pin so transcription is steered to
                # the declared language. Forwarded on EVERY chunk, including when
                # it is empty: the agent may clear a pin (plan swapped, session
                # reused), and skipping the empty case would leave the old pin in
                # place for the life of the session. set_language_hint() is a
                # no-op when the value has not changed.
                session.set_language_hint(chunk.language)

                # Process audio and yield events
                # Pass sample_rate from proto (default to 16000 for backwards compatibility)
                sample_rate = chunk.sample_rate if chunk.sample_rate > 0 else 16000
                events = session.process_audio(chunk.audio_data, sample_rate=sample_rate)
                for event in events:
                    yield event

        except Exception as e:
            print(f"[STT Service] Stream error: {e}")
            import traceback
            traceback.print_exc()

        finally:
            if session:
                print(f"[STT Service] Session ended: {session.session_id}")

    async def HealthCheck(self, request, context):
        """Health check endpoint."""
        status = self.engine.get_status()
        return stt_pb2.HealthResponse(
            healthy=self.engine.initialized,
            model_status=f"provider={status['primary_provider']}, fallback={status['fallback_provider']}",
            version="2.0.0"
        )

    async def Warmup(self, request, context):
        """Warmup endpoint to eliminate cold-start latency."""
        duration_ms = request.duration_ms if request.duration_ms > 0 else 1000
        session_id = request.session_id or "unknown"

        print(f"[STT Service] Warmup request from session {session_id} (duration={duration_ms}ms)")

        result = await self.engine.warmup(duration_ms)

        print(f"[STT Service] Warmup result: success={result['success']}, "
              f"time={result['warmup_time_ms']}ms, provider={result['provider']}")

        return stt_pb2.WarmupResponse(
            success=result["success"],
            warmup_time_ms=result["warmup_time_ms"],
            provider=result["provider"],
            message=result["message"],
        )


async def serve():
    """Start the gRPC server."""
    port = os.getenv("GRPC_PORT", "50051")

    # Initialize STT engine
    engine = STTEngine()
    if not await engine.initialize():
        print("[STT Service] CRITICAL: Engine initialization failed!")
        return

    # Create gRPC server
    server = grpc.aio.server(
        futures.ThreadPoolExecutor(max_workers=10),
        options=[
            ('grpc.max_receive_message_length', 50 * 1024 * 1024),  # 50MB
            ('grpc.max_send_message_length', 50 * 1024 * 1024),
        ]
    )

    stt_pb2_grpc.add_SpeechToTextServicer_to_server(SpeechToTextServicer(engine), server)
    server.add_insecure_port(f'[::]:{port}')

    await server.start()

    status = engine.get_status()
    print("=" * 60)
    print(f"[STT Service] Server started on port {port}")
    print(f"[STT Service] ★ ACTIVE PROVIDER: {status['primary_provider']}")
    print(f"[STT Service]   Fallback: {status['fallback_provider']}")
    print(f"[STT Service]   Capabilities ({status['primary_provider']}): {status['capabilities']}")
    print("=" * 60)

    await server.wait_for_termination()


if __name__ == '__main__':
    print("=" * 60)
    print("STT gRPC Service - Multi-Provider Architecture")
    print("=" * 60)
    print(f"Environment:")
    print(f"  STT_PROVIDER: {os.getenv('STT_PROVIDER', 'sherpa')}")
    print(f"  WHISPER_MODEL: {os.getenv('WHISPER_MODEL', 'large-v3')}")
    print(f"  WHISPER_DEVICE: {os.getenv('WHISPER_DEVICE', 'cuda')}")
    print(f"  ONNX_PROVIDER: {os.getenv('ONNX_PROVIDER', 'CPUExecutionProvider')}")
    print("=" * 60)
    asyncio.run(serve())
