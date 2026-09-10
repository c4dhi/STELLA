#!/bin/bash
# =============================================================================
# environment.sh - Environment detection and configuration loading
# =============================================================================

# Note: This file is sourced by start-k8s.sh after colors.sh and utils.sh
# Some functions may not be available until after sourcing is complete

# =============================================================================
# OS and Platform Detection (single-pass)
# =============================================================================

detect_platform() {
    # OS Detection
    case "$OSTYPE" in
        darwin*)  export OS_TYPE="macos" ;;
        linux*)   export OS_TYPE="linux" ;;
        *)        export OS_TYPE="linux"; warning "Unknown OS: $OSTYPE, defaulting to linux" ;;
    esac

    # Docker host configuration
    if [[ "$OS_TYPE" == "macos" ]]; then
        # macOS: OrbStack or Docker Desktop via dynamic detection
        if [[ -S "$HOME/.orbstack/run/docker.sock" ]]; then
            export DOCKER_HOST="unix://$HOME/.orbstack/run/docker.sock"
            export K8S_CONTEXT="orbstack"
        elif [[ -S "$HOME/.docker/run/docker.sock" ]]; then
            export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"
            export K8S_CONTEXT="docker-desktop"
        else
            export DOCKER_HOST="unix:///var/run/docker.sock"
            export K8S_CONTEXT="default"
        fi
    else
        # Linux: Standard Docker socket
        export DOCKER_HOST="${DOCKER_HOST:-unix:///var/run/docker.sock}"
        export K8S_CONTEXT="default"
    fi

    verbose "OS: $OS_TYPE | Docker: $DOCKER_HOST"
}

# =============================================================================
# Directory Setup
# =============================================================================

# Resolve and create the temp working directories from a requested base.
#
# The production default for STELLA_AI_TEMP_DIR is /mnt/stella-ai-temp (a large
# data disk), but on a freshly-cloned host /mnt is root-owned, so a non-root
# operator can't create it. Rather than abort the whole deploy with a cryptic
# "Permission denied" under `set -e`, this falls back to /tmp and tells the
# operator exactly how to opt into the intended path. Exports TEMP_DIR plus the
# namespaced PID/LOG/CHECKSUM dirs.
configure_temp_dirs() {
    local requested="${1:-/tmp}"

    # Scope temp dirs by namespace to prevent collisions between parallel instances
    local ns_suffix=""
    [[ "${KUBERNETES_NAMESPACE:-ai-agents}" != "ai-agents" ]] && ns_suffix="-${KUBERNETES_NAMESPACE}"

    # Use the requested base only if we can create it AND write to it;
    # otherwise fall back to /tmp with a clear, actionable warning.
    local base="$requested"
    if ! mkdir -p "$base" 2>/dev/null || [[ ! -w "$base" ]]; then
        if [[ "$base" != "/tmp" ]]; then
            warning "Temp directory '$base' is not writable — falling back to /tmp."
            echo -e "  ${DIM}STELLA_AI_TEMP_DIR points at '$base', which this user cannot create.${NC}"
            echo -e "  ${DIM}To use it (e.g. a large data disk), create it once:${NC}"
            echo -e "  ${DIM}  sudo mkdir -p $base && sudo chown \"\$USER\":\"\$USER\" $base${NC}"
            echo -e "  ${DIM}Or set STELLA_AI_TEMP_DIR to a path you own in .env.production.${NC}"
        fi
        base="/tmp"
        mkdir -p "$base" 2>/dev/null || true
    fi

    export TEMP_DIR="$base"
    export PID_DIR="${base}/stella-ai-k8s${ns_suffix}"
    export LOG_DIR="${base}/stella-ai-logs${ns_suffix}"
    export CHECKSUM_DIR="${base}/stella-ai-checksums${ns_suffix}"

    # Create required directories
    ensure_dir "$PID_DIR"
    ensure_dir "$LOG_DIR"
    ensure_dir "$CHECKSUM_DIR"
}

setup_directories() {
    # Script and project paths
    # BASH_SOURCE[0] is this file (lib/environment.sh)
    # We need to go up two levels (lib -> scripts -> project)
    local lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    export SCRIPT_DIR="$(dirname "$lib_dir")"
    export PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
    export WORKSPACE_ROOT="$(dirname "$PROJECT_DIR")"

    # Temp directory (can be overridden by STELLA_AI_TEMP_DIR in env files).
    # Falls back to /tmp gracefully if the requested base isn't writable.
    configure_temp_dirs "${STELLA_AI_TEMP_DIR:-/tmp}"

    # Prune old logs (older than 1 day) to prevent storage buildup
    find "$LOG_DIR" -type f -name "*.log" -mtime +1 -delete 2>/dev/null || true
    # Also cap total log directory size: if over 100MB, remove oldest files
    local log_size
    log_size=$(du -sm "$LOG_DIR" 2>/dev/null | cut -f1 || echo 0)
    if [[ "$log_size" -gt 100 ]]; then
        verbose "Log directory ${log_size}MB > 100MB, pruning old logs..."
        ls -t "$LOG_DIR"/*.log 2>/dev/null | tail -n +20 | xargs rm -f 2>/dev/null || true
    fi

    verbose "Project: $PROJECT_DIR"
    verbose "Temp: $TEMP_DIR"
}

# =============================================================================
# Environment File Loading
# =============================================================================

load_env_file() {
    local env_file="$1"
    local label="$2"

    if [[ -f "$env_file" ]]; then
        verbose "Loading $label: $env_file"
        set -a  # automatically export all variables
        # shellcheck disable=SC1090
        # Use direct source - more reliable than process substitution
        source "$env_file"
        set +a
        return 0
    fi
    return 1
}

load_environment() {
    info "${EMOJI_GEAR} Loading configuration..."

    # Change to project directory
    cd "$PROJECT_DIR" || { error "Cannot change to project directory: $PROJECT_DIR"; exit 1; }

    # Determine NODE_ENV (needed for check_setup_status). An explicit
    # --local/--production flag always wins. Otherwise auto-detect from which
    # env file is actually configured on disk, so a plain `start-k8s.sh` (and
    # the post-wizard reload below) deploys in the mode that was set up instead
    # of blindly assuming local and ignoring an existing .env.production. If
    # both files exist, local wins (dev default); if neither exists, fall back
    # to local so the setup wizard is offered.
    if [[ -n "${ENV_FLAG:-}" ]]; then
        export NODE_ENV="$ENV_FLAG"
    elif [[ -f ".env.local" ]]; then
        export NODE_ENV="local"
    elif [[ -f ".env.production" ]]; then
        export NODE_ENV="production"
    else
        export NODE_ENV="local"
    fi

    # Load only the environment-specific file
    local env_file=""
    if [[ "$NODE_ENV" == "production" ]]; then
        env_file=".env.production"
    else
        env_file=".env.local"
    fi

    if [[ -f "$env_file" ]]; then
        load_env_file "$env_file" "$NODE_ENV" || true
    else
        verbose "No $env_file file found - setup wizard will be offered"
    fi

    # Resolve the temp base after loading env. Priority: an explicit
    # STELLA_AI_TEMP_DIR wins; otherwise derive it from STELLA_DATA_ROOT (so
    # temp lives on the same disk as the rest of the heavy storage); otherwise
    # keep the /tmp default from setup_directories. configure_temp_dirs applies
    # the same graceful /tmp fallback if the chosen base isn't writable.
    if [[ -n "${STELLA_AI_TEMP_DIR:-}" ]]; then
        configure_temp_dirs "$STELLA_AI_TEMP_DIR"
    elif [[ -n "${STELLA_DATA_ROOT:-}" ]]; then
        configure_temp_dirs "${STELLA_DATA_ROOT}/tmp"
    fi

    # Set hardcoded defaults (must come before configure_urls — URLs depend on computed ports)
    set_defaults

    # Configure URLs based on environment
    configure_urls

    # Display configuration table (set_defaults calls configure_gpu_settings which displays the table)
}

# =============================================================================
# URL Configuration
# =============================================================================

configure_urls() {
    # Single source of truth for the three public endpoints. Each has a default
    # that follows STELLA's DNS convention, but ANY of them can be overridden by
    # exporting it in .env.<env> if your DNS layout differs — derivation never
    # fights an explicit value.
    #
    # Production DNS convention (matches the Caddy SNI routes on the host):
    #   apex domain      -> frontend   e.g. https://stella.example.org
    #   backend.<domain> -> API        e.g. https://backend.stella.example.org
    # NOTE: the frontend lives at the APEX, not a frontend.<domain> subdomain.
    if [[ "$NODE_ENV" == "production" ]]; then
        export PUBLIC_FRONTEND_URL="${PUBLIC_FRONTEND_URL:-https://${PRODUCTION_DOMAIN:-localhost}}"
        export PUBLIC_API_URL="${PUBLIC_API_URL:-https://backend.${PRODUCTION_DOMAIN:-localhost}}"
        export PUBLIC_DB_HOST="${PUBLIC_DB_HOST:-db.${PRODUCTION_DOMAIN:-localhost}}"
        export PUBLIC_DB_PORT="${PUBLIC_DB_PORT:-5432}"
    else
        export PUBLIC_FRONTEND_URL="${PUBLIC_FRONTEND_URL:-http://localhost:${FRONTEND_PORT}}"
        export PUBLIC_API_URL="${PUBLIC_API_URL:-http://localhost:${BACKEND_PORT}}"
        export PUBLIC_DB_HOST="${PUBLIC_DB_HOST:-localhost}"
        export PUBLIC_DB_PORT="${PUBLIC_DB_PORT:-${POSTGRES_PORT}}"
    fi

    # CORS_ORIGIN is NOT an independent setting: the browser's origin IS the
    # frontend URL, so it is always derived from PUBLIC_FRONTEND_URL. Keeping it
    # as a separate hardcoded value is exactly what drifted and broke CORS
    # before. (main.ts also accepts a comma-separated list here if ever needed.)
    export CORS_ORIGIN="$PUBLIC_FRONTEND_URL"

    # Map PUBLIC_LIVEKIT_URL to VITE_LIVEKIT_URL for frontend
    export VITE_LIVEKIT_URL="${PUBLIC_LIVEKIT_URL:-ws://localhost:7880}"

    verbose "Frontend: $PUBLIC_FRONTEND_URL"
    verbose "Backend: $PUBLIC_API_URL"
    verbose "LiveKit (internal): ${LIVEKIT_URL:-not set}"
    verbose "LiveKit (public): ${PUBLIC_LIVEKIT_URL:-not set}"
}

# =============================================================================
# GPU Detection and Auto-Configuration
# =============================================================================

detect_gpu() {
    # Check if NVIDIA GPU is available
    if command -v nvidia-smi &>/dev/null; then
        if nvidia-smi &>/dev/null; then
            # Get GPU info
            local gpu_name
            gpu_name=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
            local driver_version
            driver_version=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)
            local cuda_version
            cuda_version=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)

            export GPU_AVAILABLE="true"
            export GPU_NAME="${gpu_name:-Unknown}"
            export GPU_DRIVER="${driver_version:-Unknown}"

            verbose "GPU detected: $GPU_NAME (Driver: $GPU_DRIVER)"
            return 0
        fi
    fi

    export GPU_AVAILABLE="false"
    export GPU_NAME=""
    export GPU_DRIVER=""
    return 1
}

# Auto-configure GPU settings for production
configure_gpu_settings() {
    # First detect GPU (|| true to prevent exit on no GPU)
    detect_gpu || true

    # In production mode with GPU available, auto-enable GPU if not explicitly set
    if [[ "$NODE_ENV" == "production" && "$GPU_AVAILABLE" == "true" ]]; then
        # Only auto-set if ENABLE_GPU was not explicitly configured
        if [[ -z "${ENABLE_GPU_SET_BY_USER:-}" ]]; then
            export ENABLE_GPU="true"
            verbose "Auto-enabled GPU for production (detected: $GPU_NAME)"
        fi

        # Auto-configure optimal providers for GPU
        if [[ "$ENABLE_GPU" == "true" ]]; then
            # STT: Use Whisper with CUDA for best quality
            if [[ -z "${STT_PROVIDER_SET_BY_USER:-}" ]]; then
                export STT_PROVIDER="whisper"
                export WHISPER_DEVICE="cuda"
                export WHISPER_COMPUTE_TYPE="float16"
                verbose "Auto-configured STT: whisper (CUDA, float16)"
            fi

            # TTS: Use Kokoro with CUDA for lowest latency
            if [[ -z "${TTS_PROVIDER_SET_BY_USER:-}" ]]; then
                export TTS_PROVIDER="kokoro"
                verbose "Auto-configured TTS: kokoro (CUDA)"
            fi

            # ONNX Provider for GPU
            if [[ -z "${ONNX_PROVIDER_SET_BY_USER:-}" ]]; then
                export ONNX_PROVIDER="CUDAExecutionProvider,CPUExecutionProvider"
                verbose "Auto-configured ONNX: CUDAExecutionProvider"
            fi
        fi
    fi
}

# =============================================================================
# Configuration Display
# =============================================================================

# Display configuration summary
display_config_table() {
    # Format OS name nicely
    local os_display="Linux"
    [[ "$OS_TYPE" == "macos" ]] && os_display="macOS"

    # Format GPU status
    local gpu_display="disabled"
    if [[ "$ENABLE_GPU" == "true" ]]; then
        gpu_display="${GREEN}enabled${NC} (CUDA)"
    elif [[ "${GPU_AVAILABLE:-false}" == "true" ]]; then
        gpu_display="${YELLOW}available${NC} (not enabled)"
    fi

    # Format TTS provider with type/device indicator
    local tts_display="${TTS_PROVIDER:-piper}"
    case "${TTS_PROVIDER:-piper}" in
        piper)      tts_display="${tts_display} ${DIM}(local)${NC}" ;;
        kokoro)     tts_display="${tts_display} ${DIM}(local)${NC}" ;;
        elevenlabs) tts_display="${tts_display} ${DIM}(cloud)${NC}" ;;
        qwen3)
            # GPU provider: loads on CUDA unless pinned to cpu via QWEN3_DEVICE.
            if [[ "$ENABLE_GPU" == "true" && "${QWEN3_DEVICE:-cuda}" != "cpu" ]]; then
                tts_display="${tts_display} ${DIM}(CUDA)${NC}"
            else
                tts_display="${tts_display} ${DIM}(CPU)${NC}"
            fi
            ;;
        chatterbox)
            # GPU provider: CHATTERBOX_DEVICE=auto picks CUDA when available.
            if [[ "$ENABLE_GPU" == "true" && "${CHATTERBOX_DEVICE:-auto}" != "cpu" ]]; then
                tts_display="${tts_display} ${DIM}(CUDA)${NC}"
            else
                tts_display="${tts_display} ${DIM}(CPU)${NC}"
            fi
            ;;
    esac

    # Format STT provider with device indicator
    local stt_display="${STT_PROVIDER:-sherpa}"
    if [[ "$STT_PROVIDER" == "sherpa" ]]; then
        stt_display="${stt_display} ${DIM}(CPU)${NC}"
    elif [[ "$STT_PROVIDER" == "whisper" ]]; then
        if [[ "$WHISPER_DEVICE" == "cuda" ]]; then
            stt_display="${stt_display} ${DIM}(CUDA)${NC}"
        else
            stt_display="${stt_display} ${DIM}(CPU)${NC}"
        fi
    fi

    config_row "OS" "$os_display"
    config_row "Mode" "$NODE_ENV"
    config_row "GPU" "$gpu_display"
    config_row "TTS" "$tts_display"
    config_row "STT" "$stt_display"
}

# =============================================================================
# Default Values
# =============================================================================

set_defaults() {
    # Kubernetes configuration
    export KUBERNETES_NAMESPACE="${KUBERNETES_NAMESPACE:-ai-agents}"
    export DEFAULT_AGENT_TYPE="${DEFAULT_AGENT_TYPE:-stella-light-agent}"

    # Port offset: auto +100 for non-default namespace, 0 otherwise
    export PORT_OFFSET="${PORT_OFFSET:-0}"
    if [[ "$KUBERNETES_NAMESPACE" != "ai-agents" && "$PORT_OFFSET" == "0" ]]; then
        PORT_OFFSET=100
    fi
    export FRONTEND_PORT=$((8080 + PORT_OFFSET))
    export BACKEND_PORT=$((3000 + PORT_OFFSET))
    export POSTGRES_PORT=$((5432 + PORT_OFFSET))
    export PG_LOCAL_PORT=$((5433 + PORT_OFFSET))

    # Image tag: namespace name for non-default, latest for default
    if [[ "$KUBERNETES_NAMESPACE" == "ai-agents" ]]; then
        export IMAGE_TAG="${IMAGE_TAG:-latest}"
    else
        export IMAGE_TAG="${IMAGE_TAG:-${KUBERNETES_NAMESPACE}}"
    fi

    # Backend port
    export PORT="${PORT:-3000}"
    export AGENT_IMAGE_PULL_POLICY="${AGENT_IMAGE_PULL_POLICY:-IfNotPresent}"

    # Legacy compatibility
    export PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-localhost}"
    export ENABLE_NETWORK_ACCESS="${ENABLE_NETWORK_ACCESS:-false}"

    # Frontend configuration
    export VITE_USE_INPAGE_MOCK="${VITE_USE_INPAGE_MOCK:-0}"

    # Python Agent defaults
    export ROOM_NAME="${ROOM_NAME:-voice-ai-room}"
    export IDENTITY="${IDENTITY:-python-listener}"

    # Track if user explicitly set these (before we apply defaults)
    [[ -n "${ENABLE_GPU:-}" ]] && export ENABLE_GPU_SET_BY_USER="true"
    [[ -n "${STT_PROVIDER:-}" ]] && export STT_PROVIDER_SET_BY_USER="true"
    [[ -n "${TTS_PROVIDER:-}" ]] && export TTS_PROVIDER_SET_BY_USER="true"
    [[ -n "${ONNX_PROVIDER:-}" ]] && export ONNX_PROVIDER_SET_BY_USER="true"

    # STT Configuration (defaults - may be overridden by GPU auto-config)
    export STT_PROVIDER="${STT_PROVIDER:-sherpa}"
    export WHISPER_MODEL="${WHISPER_MODEL:-large-v3}"
    export WHISPER_DEVICE="${WHISPER_DEVICE:-cpu}"
    export WHISPER_COMPUTE_TYPE="${WHISPER_COMPUTE_TYPE:-int8}"
    export WHISPER_BEAM_SIZE="${WHISPER_BEAM_SIZE:-5}"
    export WHISPER_LANGUAGE="${WHISPER_LANGUAGE:-}"

    # VAD Configuration
    export VAD_THRESHOLD="${VAD_THRESHOLD:-0.5}"
    export VAD_SILENCE_DURATION_MS="${VAD_SILENCE_DURATION_MS:-800}"
    export VAD_CONTINUATION_WINDOW_MS="${VAD_CONTINUATION_WINDOW_MS:-1000}"
    export VAD_MAX_ENDPOINTING_DELAY_MS="${VAD_MAX_ENDPOINTING_DELAY_MS:-2000}"
    export VAD_MIN_SPEECH_MS="${VAD_MIN_SPEECH_MS:-500}"
    export VAD_MAX_SPEECH_DURATION_MS="${VAD_MAX_SPEECH_DURATION_MS:-30000}"
    export VAD_AUDIO_INACTIVITY_TIMEOUT_MS="${VAD_AUDIO_INACTIVITY_TIMEOUT_MS:-1500}"
    export VAD_RMS_THRESHOLD="${VAD_RMS_THRESHOLD:-0.008}"
    export PARTIAL_INTERVAL_MS="${PARTIAL_INTERVAL_MS:-1000}"
    export WHISPER_INITIAL_PROMPT="${WHISPER_INITIAL_PROMPT:-}"

    # Barge-in sensitivity and the two diagnostic switches. These reach the
    # configmap and must be exported like everything else in it — an unexported
    # one leaves its ${PLACEHOLDER} in the rendered YAML, and stt-service parses
    # BARGE_IN_MIN_SPEECH_MS with int(), so it crashloops on the literal.
    export BARGE_IN_MIN_SPEECH_MS="${BARGE_IN_MIN_SPEECH_MS:-600}"
    export STT_DECODE_DIAGNOSTICS="${STT_DECODE_DIAGNOSTICS:-0}"
    export DISABLE_AEC="${DISABLE_AEC:-false}"

    # TTS Configuration (defaults - may be overridden by GPU auto-config)
    export TTS_PROVIDER="${TTS_PROVIDER:-piper}"
    export ELEVENLABS_STABILITY="${ELEVENLABS_STABILITY:-0.5}"
    export ELEVENLABS_SIMILARITY_BOOST="${ELEVENLABS_SIMILARITY_BOOST:-0.8}"
    export ELEVENLABS_STYLE="${ELEVENLABS_STYLE:-0.0}"
    export ELEVENLABS_USE_SPEAKER_BOOST="${ELEVENLABS_USE_SPEAKER_BOOST:-true}"
    export KOKORO_MODEL_PATH="${KOKORO_MODEL_PATH:-./kokoro-models/kokoro-v1.0.onnx}"
    export KOKORO_VOICES_PATH="${KOKORO_VOICES_PATH:-./kokoro-models/voices-v1.0.bin}"
    export KOKORO_CACHE_DIR="${KOKORO_CACHE_DIR:-/root/.cache/kokoro}"

    # GPU Configuration (default - will be auto-detected in production)
    export ENABLE_GPU="${ENABLE_GPU:-false}"

    # Qwen3-TTS Configuration. Provider stays inert unless TTS_PROVIDER=qwen3.
    # Qwen3-TTS runs IN-PROCESS in the tts-service container via the
    # faster-qwen3-tts library (MIT). No sidecar. The tts-service image is
    # built single-provider via TTS_PROVIDER, so only qwen3's deps land in
    # the image when selected. Auto-enables ENABLE_GPU because the
    # CUDA-graph fast path is the whole point.
    #
    # QWEN3_MODEL_ID selects between Qwen3-TTS variants:
    #   - Qwen/Qwen3-TTS-12Hz-0.6B-Base       (~2GB VRAM, fastest)
    #   - Qwen/Qwen3-TTS-12Hz-1.7B-Base       (~5GB VRAM, higher quality)
    #   - Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice (voice cloning)
    #   - Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign (instruction-based voice design)
    export QWEN3_MODEL_ID="${QWEN3_MODEL_ID:-Qwen/Qwen3-TTS-12Hz-0.6B-Base}"
    # Reference clip for the voice-clone API (required even by Base
    # variants). The bundled clip lives at tts-service/assets/ref_audio.mp3
    # + ref_audio.txt in the repo, gets baked into the tts-service image,
    # and the init container copies both onto the PVC if no operator
    # files are there yet. The provider reads the transcript from the
    # sibling .txt file next to the audio — no env-var transcript sharing.
    export QWEN3_REF_AUDIO="${QWEN3_REF_AUDIO:-/models/qwen3/ref_audio.mp3}"
    # Auto = let the model autodetect from the input text. Pin only if
    # autodetect misfires on your domain (rare).
    export QWEN3_LANGUAGE="${QWEN3_LANGUAGE:-Auto}"
    # Codec frames per streamed yield. 2 ≈ 167ms audio per yield = low TTFB.
    export QWEN3_CHUNK_SIZE="${QWEN3_CHUNK_SIZE:-2}"
    # bfloat16 is the recommended dtype on Ampere+; drop to float16 on
    # cards without bf16 support (e.g. V100/T4).
    export QWEN3_DTYPE="${QWEN3_DTYPE:-bfloat16}"
    export HF_TOKEN="${HF_TOKEN:-}"
    if [[ "${TTS_PROVIDER:-}" == "qwen3" ]]; then
        if [[ "$ENABLE_GPU" != "true" ]]; then
            export ENABLE_GPU="true"
            verbose "TTS_PROVIDER=qwen3: auto-enabled ENABLE_GPU (faster-qwen3-tts needs CUDA)"
        fi
    fi

    # ONNX Provider (auto-set based on GPU)
    if [[ -z "${ONNX_PROVIDER:-}" ]]; then
        if [[ "$ENABLE_GPU" == "true" ]]; then
            export ONNX_PROVIDER="CUDAExecutionProvider,CPUExecutionProvider"
        else
            export ONNX_PROVIDER="CPUExecutionProvider"
        fi
    fi

    # TURN Configuration
    export LIVEKIT_TURN_ENABLED="${LIVEKIT_TURN_ENABLED:-false}"
    export LIVEKIT_TURN_DOMAIN="${LIVEKIT_TURN_DOMAIN:-localhost}"

    # Barge-in Configuration
    export MIN_INTERRUPTION_DURATION="${MIN_INTERRUPTION_DURATION:-0.5}"
    export MIN_INTERRUPTION_WORDS="${MIN_INTERRUPTION_WORDS:-1}"
    export FALSE_INTERRUPTION_TIMEOUT="${FALSE_INTERRUPTION_TIMEOUT:-2.0}"

    # Auto-configure GPU settings (after defaults are set)
    configure_gpu_settings

    # Display configuration table
    display_config_table
}

# =============================================================================
# Setup Status Detection
# =============================================================================

# Check if setup has been completed for current environment
# Returns 0 if setup is complete, 1 if not
#
# Priority: If all required variables are present in the active env file, skip the wizard
# even if the marker file is missing. The marker file is secondary.
check_setup_status() {
    local marker_file="$PROJECT_DIR/.stella-setup-complete"
    local current_mode="${NODE_ENV:-local}"

    # 1. First check if all critical variables are present
    #    If they are, setup is considered complete regardless of marker file
    local missing_vars=()

    [[ -z "${POSTGRES_PASSWORD:-}" ]] && missing_vars+=("POSTGRES_PASSWORD")
    [[ -z "${JWT_SECRET:-}" ]] && missing_vars+=("JWT_SECRET")
    [[ -z "${OPENAI_API_KEY:-}" ]] && missing_vars+=("OPENAI_API_KEY")

    # For production, also check additional requirements
    if [[ "$current_mode" == "production" ]]; then
        [[ -z "${ENV_VAR_ENCRYPTION_KEY:-}" ]] && missing_vars+=("ENV_VAR_ENCRYPTION_KEY")
        [[ -z "${LIVEKIT_API_KEY:-}" ]] && missing_vars+=("LIVEKIT_API_KEY")
        [[ -z "${LIVEKIT_API_SECRET:-}" ]] && missing_vars+=("LIVEKIT_API_SECRET")
        [[ -z "${PRODUCTION_DOMAIN:-}" ]] && missing_vars+=("PRODUCTION_DOMAIN")
    fi

    # 2. If all variables are present, setup is complete
    if [[ ${#missing_vars[@]} -eq 0 ]]; then
        # Auto-create marker file if it doesn't exist or doesn't match
        if [[ ! -f "$marker_file" ]] || [[ "$(cat "$marker_file" 2>/dev/null)" != "$current_mode" ]]; then
            verbose "All variables present, auto-creating setup marker for: $current_mode"
            echo "$current_mode" > "$marker_file"
        fi
        return 0
    fi

    # 3. Variables are missing - report them
    for var in "${missing_vars[@]}"; do
        verbose "Missing critical variable: $var"
    done
    return 1
}

# Mark setup as complete for given environment
mark_setup_complete() {
    local env="${1:-${NODE_ENV:-local}}"
    local marker_file="$PROJECT_DIR/.stella-setup-complete"

    echo "$env" > "$marker_file"
    verbose "Marked setup complete for: $env"
}

# Clear setup marker (force re-setup)
clear_setup_marker() {
    local marker_file="$PROJECT_DIR/.stella-setup-complete"

    if [[ -f "$marker_file" ]]; then
        rm -f "$marker_file"
        verbose "Cleared setup marker"
    fi
}

# Get the environment mode from setup marker
get_setup_mode() {
    local marker_file="$PROJECT_DIR/.stella-setup-complete"

    if [[ -f "$marker_file" ]]; then
        cat "$marker_file" 2>/dev/null || echo ""
    fi
}

# =============================================================================
# Main Detection Function
# =============================================================================

detect_environment() {
    detect_platform
    setup_directories
}
