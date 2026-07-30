# TTS Service Dockerfile — single-provider image.
#
# The TTS_PROVIDER build arg selects exactly one provider's deps to
# install. Every other provider's `try: import …; except ImportError:`
# guard then sets `is_available=False`, so the running image only ever
# instantiates the one provider it was built for. This keeps the image
# small (each provider's deps are multi-GB on their own) and removes
# the "which torch wins" conflict between providers.
#
# Build args:
#   ENABLE_GPU=true       -> CUDA base image + CUDA-enabled wheels
#   TTS_PROVIDER=<name>   -> piper | kokoro | chatterbox | qwen3
#                            (also accepts `auto`, which installs the
#                             CPU-friendly fallback chain: piper + kokoro)
#
# Examples:
#   docker build --build-arg TTS_PROVIDER=qwen3   --build-arg ENABLE_GPU=true ...
#   docker build --build-arg TTS_PROVIDER=kokoro  --build-arg ENABLE_GPU=true ...
#   docker build --build-arg TTS_PROVIDER=piper   ...   # GPL-3.0 image

ARG ENABLE_GPU=false
ARG TTS_PROVIDER=piper

# ============================================================================
# CPU-only base image
# ============================================================================
FROM python:3.14-slim AS base-cpu

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ============================================================================
# GPU base image (NVIDIA CUDA 12.4 — compatible with torch 2.5.1+cu124)
# ============================================================================
FROM nvidia/cuda:13.3.1-cudnn-runtime-ubuntu22.04 AS base-gpu

WORKDIR /app

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

RUN apt-get update && apt-get install -y --no-install-recommends \
    software-properties-common \
    tzdata \
    && add-apt-repository ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
    python3.11 \
    python3.11-venv \
    python3.11-dev \
    python3-pip \
    libsndfile1 \
    ffmpeg \
    curl \
    ca-certificates \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.11 /usr/bin/python \
    && python3 -m pip install --upgrade pip \
    && rm -rf /var/lib/apt/lists/*

ENV CUDA_HOME=/usr/local/cuda
ENV LD_LIBRARY_PATH=/usr/local/cuda/lib64:${LD_LIBRARY_PATH}
ENV PATH=/usr/local/cuda/bin:${PATH}

# ============================================================================
# Final image — pick base by ENABLE_GPU
# ============================================================================
ARG ENABLE_GPU
FROM base-cpu AS final-false
FROM base-gpu AS final-true
FROM final-${ENABLE_GPU} AS final

WORKDIR /app

ARG ENABLE_GPU
ARG TTS_PROVIDER

# ----------------------------------------------------------------------------
# Step 1 — base deps (always)
# ----------------------------------------------------------------------------
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ----------------------------------------------------------------------------
# Step 2 — provider-specific installs (selected by TTS_PROVIDER)
# ----------------------------------------------------------------------------
COPY requirements-piper.txt requirements-kokoro.txt requirements-chatterbox.txt requirements-qwen3.txt ./

# Piper (GPL-3.0). Selected for TTS_PROVIDER=piper, or as the safe
# CPU-only fallback in `auto`.
RUN if [ "$TTS_PROVIDER" = "piper" ] || [ "$TTS_PROVIDER" = "auto" ]; then \
        echo "[TTS] Installing Piper (GPL-3.0)..." && \
        pip install --no-cache-dir -r requirements-piper.txt; \
    fi

# Kokoro (ONNX-based, no torch). Selected for TTS_PROVIDER=kokoro, or in auto.
RUN if [ "$TTS_PROVIDER" = "kokoro" ] || [ "$TTS_PROVIDER" = "auto" ]; then \
        echo "[TTS] Installing Kokoro ONNX..." && \
        pip install --no-cache-dir -r requirements-kokoro.txt; \
    fi

# ChatterBox needs torch (CUDA or CPU build) + an explicit dep list, then
# the package itself with --no-deps to skip its restrictive numpy pin.
RUN if [ "$TTS_PROVIDER" = "chatterbox" ]; then \
        echo "[TTS] Installing ChatterBox deps..." && \
        pip install --no-cache-dir -r requirements-chatterbox.txt && \
        if [ "$ENABLE_GPU" = "true" ]; then \
            pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cu121; \
        else \
            pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu; \
        fi && \
        pip install --no-cache-dir --no-deps "chatterbox-tts>=0.1.6"; \
    fi

# Qwen3-TTS needs CUDA + torch 2.5.1+cu124 (CUDA-graph capture is
# unreliable below that). CPU-only Qwen3 builds are rejected here —
# they would never be real-time and silently disappoint.
RUN if [ "$TTS_PROVIDER" = "qwen3" ]; then \
        if [ "$ENABLE_GPU" != "true" ]; then \
            echo "[TTS] ERROR: TTS_PROVIDER=qwen3 requires ENABLE_GPU=true."; exit 1; \
        fi && \
        echo "[TTS] Installing torch 2.5.1+cu124 for Qwen3..." && \
        pip install --no-cache-dir \
            torch==2.5.1+cu124 torchaudio==2.5.1+cu124 \
            --index-url https://download.pytorch.org/whl/cu124 && \
        echo "[TTS] Installing faster-qwen3-tts..." && \
        pip install --no-cache-dir -r requirements-qwen3.txt; \
    fi

# ----------------------------------------------------------------------------
# Step 3 — ONNX Runtime (only useful for Kokoro; skip otherwise)
# ----------------------------------------------------------------------------
RUN if [ "$TTS_PROVIDER" = "kokoro" ] || [ "$TTS_PROVIDER" = "auto" ]; then \
        if [ "$ENABLE_GPU" = "true" ]; then \
            echo "[TTS] Installing onnxruntime-gpu..." && \
            pip install --no-cache-dir "onnxruntime-gpu>=1.16.0"; \
        else \
            echo "[TTS] Installing onnxruntime (CPU)..." && \
            pip install --no-cache-dir "onnxruntime>=1.16.0"; \
        fi; \
    fi

# ----------------------------------------------------------------------------
# Step 4 — model download scripts + gRPC code + source
# ----------------------------------------------------------------------------
COPY download_kokoro_models.py .
COPY download_piper_models.py .
COPY download_chatterbox_models.py .

COPY proto/ ./proto/
RUN python -m grpc_tools.protoc \
    -I./proto \
    --python_out=. \
    --grpc_python_out=. \
    ./proto/tts.proto

COPY src/ ./src/

# Bundled Qwen3 reference clip (Apache-2.0-compatible, recorded by STELLA).
# The init container copies it to /models/qwen3/ref_audio.mp3 on the PVC if
# the operator hasn't already staged their own clip there.
COPY assets/ ./assets/

# Default env
ENV TTS_PROVIDER=${TTS_PROVIDER}
ENV ONNX_PROVIDER=CPUExecutionProvider
ENV GRPC_PORT=50052
ENV KOKORO_CACHE_DIR=/root/.cache/kokoro
ENV PIPER_CACHE_DIR=/root/.cache/piper
ENV CHATTERBOX_CACHE_DIR=/root/.cache/chatterbox
ENV PYTHONUNBUFFERED=1

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD python -c "import grpc; channel = grpc.insecure_channel('localhost:50052'); grpc.channel_ready_future(channel).result(timeout=5)" || exit 1

EXPOSE 50052

CMD ["python", "src/tts_server.py"]
