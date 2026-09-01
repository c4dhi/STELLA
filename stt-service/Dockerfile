# STT Service Dockerfile
# Supports multiple providers:
# - Sherpa-ONNX: Lightweight streaming model (~180MB) - default
# - faster-whisper: GPU-accelerated model (~3GB for large-v3) - requires ENABLE_GPU=true
#
# Build args:
#   ENABLE_GPU=true - Use NVIDIA CUDA base image with GPU dependencies
#   ENABLE_GPU=false (default) - Use python:slim for CPU-only builds

ARG ENABLE_GPU=false

# ============================================================================
# CPU-only base image
# ============================================================================
FROM python:3.14-slim AS base-cpu

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    wget \
    curl \
    ca-certificates \
    libgomp1 \
    git \
    && rm -rf /var/lib/apt/lists/*

# ============================================================================
# GPU base image (NVIDIA CUDA 12.6 - compatible with driver 13.0+)
# ============================================================================
# PINNED, AND NOT SAFELY BUMPABLE. The CUDA version here must be supported by
# the GPU node's *driver*. The torch wheel installed below is unpinned and
# bundles its own CUDA runtime, so the base only has to satisfy the driver.
#
# Dependabot bumped this to 13.3.1 on 2026-07-30. When it was first rebuilt on
# 2026-08-25 every pod failed in the NVIDIA prestart hook before the container
# process even started:
#
#   nvidia-container-cli: requirement error: unsatisfied condition: cuda>=13.3
#
# Measured 2026-09-01: production (L4) runs driver 565.57.01 -> max CUDA 12.7;
# test (T4) runs 580.173.02 -> max CUDA 13.0. 13.3.1 is unrunnable on BOTH.
# Bump this only together with the node drivers, and only after actually
# starting the image on a GPU host. See .github/dependabot.yml.
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04 AS base-gpu

WORKDIR /app

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# Install Python 3.11 and system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    software-properties-common \
    tzdata \
    && add-apt-repository ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
    python3.11 \
    python3.11-venv \
    python3.11-dev \
    python3-pip \
    build-essential \
    wget \
    curl \
    ca-certificates \
    libgomp1 \
    git \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.11 /usr/bin/python \
    && python3 -m pip install --upgrade pip \
    && rm -rf /var/lib/apt/lists/*

# CUDA environment (set by NVIDIA base image, but ensure they're available)
ENV CUDA_HOME=/usr/local/cuda
ENV LD_LIBRARY_PATH=/usr/local/cuda/lib64:${LD_LIBRARY_PATH}
ENV PATH=/usr/local/cuda/bin:${PATH}

# ============================================================================
# Final image - select base based on ENABLE_GPU
# ============================================================================
ARG ENABLE_GPU
FROM base-cpu AS final-false
FROM base-gpu AS final-true
FROM final-${ENABLE_GPU} AS final

WORKDIR /app

# ============================================================================
# Base requirements (always installed - for Sherpa-ONNX)
# ============================================================================
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ============================================================================
# GPU requirements (only when ENABLE_GPU=true - for faster-whisper)
# ============================================================================
ARG ENABLE_GPU
COPY requirements-gpu.txt .
RUN if [ "$ENABLE_GPU" = "true" ]; then \
        echo "[STT] Installing GPU dependencies (faster-whisper, torch, ctranslate2)..." && \
        pip install --no-cache-dir -r requirements-gpu.txt && \
        pip install --no-cache-dir onnxruntime-gpu>=1.16.0 && \
        echo "[STT] GPU dependencies installed successfully"; \
    else \
        echo "[STT] Installing onnxruntime (CPU)..." && \
        pip install --no-cache-dir onnxruntime>=1.16.0; \
    fi

# ============================================================================
# Proto compilation
# ============================================================================
COPY proto/ ./proto/
RUN python -m grpc_tools.protoc \
    -I./proto \
    --python_out=. \
    --grpc_python_out=. \
    proto/stt.proto

# ============================================================================
# Model download scripts (models are downloaded at runtime via init container)
# ============================================================================
# Models are stored on PersistentVolume, not in the image.
# This keeps the image slim (~500MB instead of ~4GB for GPU builds).
# The init container runs these scripts to populate the PV on first startup.
COPY download_sherpa_model.py download_whisper_model.py download_silero_vad.py ./

# Environment defaults for cache directories (mounted from PV at runtime)
ENV WHISPER_MODEL=large-v3
ENV WHISPER_CACHE_DIR=/root/.cache/whisper
ENV SILERO_VAD_CACHE_DIR=/root/.cache/silero-vad

# ============================================================================
# Application code
# ============================================================================
COPY src/ ./src/

# ============================================================================
# Environment defaults
# ============================================================================
ENV PYTHONUNBUFFERED=1
ENV GRPC_PORT=50051

# STT Provider selection
# - 'sherpa' (default): Lightweight CPU model
# - 'whisper': GPU-accelerated model (requires ENABLE_GPU=true build)
ENV STT_PROVIDER=sherpa

# Sherpa-ONNX configuration
ENV SHERPA_ONNX_CACHE_DIR=/root/.cache/sherpa-onnx
ENV ONNX_PROVIDER=CPUExecutionProvider

# faster-whisper configuration (only used when STT_PROVIDER=whisper)
ENV WHISPER_CACHE_DIR=/root/.cache/whisper
ENV WHISPER_DEVICE=cpu
ENV WHISPER_COMPUTE_TYPE=int8
ENV WHISPER_BEAM_SIZE=5
ENV WHISPER_LANGUAGE=

# Silero VAD configuration (for whisper provider)
ENV SILERO_VAD_CACHE_DIR=/root/.cache/silero-vad

# ============================================================================
# Whisper VAD configuration (Silero VAD - 3-state machine)
# Industry-standard approach based on LiveKit, OpenAI Realtime, Deepgram
# ============================================================================
# Single VAD signal (probability threshold) - higher = stricter, less noise false positives
# 0.6+ recommended to avoid picking up TTS echo from speakers
ENV VAD_THRESHOLD=0.6
# RMS energy gate - filters quiet background noise before VAD processing
# 0.015 = ~-36dB, rejects ambient noise while accepting normal speech
# Increase to 0.02-0.03 for noisier environments
ENV VAD_RMS_THRESHOLD=0.015
# Silence duration to trigger MAYBE_ENDING state
ENV VAD_SILENCE_DURATION_MS=500
# Continuation window: additional wait in MAYBE_ENDING before final
# Handles natural pauses (thinking, hesitation) without fragmenting utterances
ENV VAD_CONTINUATION_WINDOW_MS=600
# Maximum total silence before forced endpoint (prevents infinite waiting)
ENV VAD_MAX_ENDPOINTING_DELAY_MS=2000
# Minimum speech duration to accept (filters short noise bursts)
ENV VAD_MIN_SPEECH_MS=400
# Safety timeout
ENV VAD_MAX_SPEECH_DURATION_MS=30000
# Partial transcript interval
ENV PARTIAL_INTERVAL_MS=1000
# Audio inactivity timeout (forces endpoint when no audio received)
ENV VAD_AUDIO_INACTIVITY_TIMEOUT_MS=1500
# Effective pause tolerance: silence_duration + continuation_window = 1100ms

# ============================================================================
# Sherpa VAD configuration (RMS-based - energy detection)
# ============================================================================
ENV SHERPA_SILENCE_THRESHOLD=1.5
ENV SHERPA_SPEECH_TIMEOUT=10.0
ENV SHERPA_RMS_THRESHOLD=0.001
ENV SHERPA_PRE_BUFFER_SAMPLES=8000
ENV SHERPA_MIN_TRANSCRIPT_CHARS=3

# Expose gRPC port
EXPOSE 50051

# Run the server
CMD ["python", "-u", "src/stt_server.py"]
