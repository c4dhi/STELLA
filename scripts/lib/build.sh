#!/bin/bash
# =============================================================================
# build.sh - Smart Docker build system with content-addressable caching
# =============================================================================

# Track rebuilt services
declare -a REBUILT_SERVICES=()

# =============================================================================
# BuildKit Detection and Setup
# =============================================================================

setup_buildkit() {
    USE_BUILDKIT=false

    if docker buildx version >/dev/null 2>&1; then
        USE_BUILDKIT=true
        verbose "BuildKit: available"
    else
        verbose "BuildKit: not available"

        # Auto-install on Linux
        if [[ "$OS_TYPE" == "linux" ]]; then
            verbose "Installing docker-buildx..."

            # Try package installation first
            if sudo apt-get install -y docker-buildx-plugin >/dev/null 2>&1; then
                if docker buildx version >/dev/null 2>&1; then
                    USE_BUILDKIT=true
                    verbose "BuildKit: installed via apt"
                fi
            fi

            # Manual installation fallback
            if [[ "$USE_BUILDKIT" == "false" ]]; then
                mkdir -p ~/.docker/cli-plugins
                local buildx_version
                buildx_version=$(curl -s https://api.github.com/repos/docker/buildx/releases/latest | grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')

                if curl -sL "https://github.com/docker/buildx/releases/download/v${buildx_version}/buildx-v${buildx_version}.linux-amd64" -o ~/.docker/cli-plugins/docker-buildx; then
                    chmod +x ~/.docker/cli-plugins/docker-buildx
                    if docker buildx version >/dev/null 2>&1; then
                        USE_BUILDKIT=true
                        verbose "BuildKit: installed manually (v${buildx_version})"
                    fi
                fi
            fi

            if [[ "$USE_BUILDKIT" == "false" ]]; then
                verbose "BuildKit: installation failed, using legacy builder"
            fi
        fi
    fi

    # Detect CPU cores for parallel builds
    if [[ "$OS_TYPE" == "macos" ]]; then
        CPU_CORES=$(sysctl -n hw.ncpu 2>/dev/null || echo 4)
    else
        CPU_CORES=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 4)
    fi

    # Set max concurrent builds (default: number of cores, max 8 to avoid resource exhaustion)
    MAX_PARALLEL_BUILDS=${MAX_PARALLEL_BUILDS:-$((CPU_CORES > 8 ? 8 : CPU_CORES))}

    # Configure BuildKit for maximum parallelism within each build
    if [[ "$USE_BUILDKIT" == "true" ]]; then
        # BUILDKIT_STEP_LOG_MAX_SIZE: Increase log buffer
        # BUILDKIT_STEP_LOG_MAX_SPEED: Don't throttle logs
        export DOCKER_BUILDKIT=1
        export BUILDKIT_PROGRESS=plain
    fi

    verbose "CPU cores: $CPU_CORES, Max parallel builds: $MAX_PARALLEL_BUILDS"
    export USE_BUILDKIT CPU_CORES MAX_PARALLEL_BUILDS
}

# =============================================================================
# Checksum Calculation (with .env support)
# =============================================================================

# Env vars that actually reach a service's build as --build-arg. Only these
# belong in that service's rebuild checksum. See calculate_service_checksum.
#
# Derived from build_images(): stt/tts take ENABLE_GPU (and tts also
# TTS_PROVIDER). Everything else takes no env-derived build arg at all --
# session-management-server's only arg is PRISMA_SCHEMA_CHECKSUM (hashed from
# the schema file) and frontend-ui's APP_VERSION comes from package.json.
service_build_env_keys() {
    case "$1" in
        stt-service)               echo "ENABLE_GPU" ;;
        tts-service)               echo "ENABLE_GPU TTS_PROVIDER" ;;
        *)                         echo "" ;;
    esac
}

calculate_service_checksum() {
    local service_name="$1"
    local service_dir="$2"
    local dockerfile="$3"

    local checksum=""

    # Hash source files (with error suppression)
    if [[ "$OS_TYPE" == "macos" ]]; then
        checksum=$(find "$service_dir" -type f \
            \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \
            -o -name "*.py" -o -name "*.json" -o -name "*.yaml" -o -name "*.yml" \
            -o -name "Dockerfile*" -o -name "*.toml" -o -name "*.cfg" \
            -o -name "requirements*.txt" -o -name "package*.json" \
            -o -name "*.css" -o -name "*.html" -o -name "*.conf" -o -name "*.sh" \
            -o -name "*.prisma" -o -name "*.env.example" \) \
            ! -path "*/node_modules/*" ! -path "*/__pycache__/*" ! -path "*/.git/*" \
            ! -path "*/dist/*" ! -path "*/build/*" ! -path "*/.next/*" \
            -exec md5 -q {} \; 2>/dev/null | sort | md5 -q 2>/dev/null || echo "fallback-checksum-mac")
    else
        checksum=$(find "$service_dir" -type f \
            \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \
            -o -name "*.py" -o -name "*.json" -o -name "*.yaml" -o -name "*.yml" \
            -o -name "Dockerfile*" -o -name "*.toml" -o -name "*.cfg" \
            -o -name "requirements*.txt" -o -name "package*.json" \
            -o -name "*.css" -o -name "*.html" -o -name "*.conf" -o -name "*.sh" \
            -o -name "*.prisma" -o -name "*.env.example" \) \
            ! -path "*/node_modules/*" ! -path "*/__pycache__/*" ! -path "*/.git/*" \
            ! -path "*/dist/*" ! -path "*/build/*" ! -path "*/.next/*" \
            -exec md5sum {} \; 2>/dev/null | sort | md5sum 2>/dev/null | cut -d' ' -f1 || echo "fallback-checksum-linux")
    fi

    # Add Dockerfile hash (with fallback)
    if [[ -f "$dockerfile" ]]; then
        local df_hash
        df_hash=$(hash_file "$dockerfile" 2>/dev/null || echo "df")
        checksum="${checksum}${df_hash}"
    fi

    # Add ONLY the env vars this service actually builds with.
    #
    # This used to hash the whole of .env.local and .env.production into every
    # service's checksum. That made rotating any unrelated key -- an API token,
    # a webhook URL, a mail setting -- invalidate every service at once, forcing
    # a cold rebuild of the 15-16GB CUDA images, which read none of it. Scoping
    # to the real build args keeps the invalidation honest: change ENABLE_GPU
    # and stt/tts rebuild; change an OpenAI key and nothing rebuilds.
    local env_keys
    env_keys=$(service_build_env_keys "$service_name")
    if [[ -n "$env_keys" ]]; then
        local env_material="" k
        for k in $env_keys; do
            env_material+="${k}=${!k-}"$'\n'
        done
        local env_hash
        env_hash=$(printf '%s' "$env_material" | hash_string 2>/dev/null || echo "env")
        checksum="${checksum}${env_hash}"
    fi

    # Final combined hash (with fallback)
    echo "$checksum" | hash_string 2>/dev/null || echo "$checksum" | md5sum 2>/dev/null | cut -d' ' -f1 || echo "checksum-error"
}

# =============================================================================
# Checksum Management
# =============================================================================

service_needs_rebuild() {
    local service_name="$1"
    local service_dir="$2"
    local dockerfile="$3"

    # Protect against set -e failures in checksum calculation
    # NOTE: Do NOT re-enable set -e in this function, as returning 1
    # (meaning "no rebuild needed") would be treated as an error
    set +e
    local current_checksum
    current_checksum=$(calculate_service_checksum "$service_name" "$service_dir" "$dockerfile" 2>/dev/null)
    local calc_exit=$?

    # If checksum calculation failed, force rebuild
    if [[ $calc_exit -ne 0 || -z "$current_checksum" ]]; then
        verbose "Checksum calculation failed for $service_name, forcing rebuild"
        return 0
    fi

    local cached_checksum_file="${CHECKSUM_DIR}/${service_name}.checksum"

    # Ensure checksum directory exists
    mkdir -p "$CHECKSUM_DIR" 2>/dev/null || true

    # No cached checksum = needs rebuild.
    # IMPORTANT: do NOT write the checksum here. This function is a pure
    # predicate — the checksum must only be written by update_service_checksum
    # AFTER a build is confirmed successful. Writing it at decision time was a
    # bug: if the build then failed, the checksum was already updated, so every
    # later deploy saw "unchanged" and silently skipped the still-broken image.
    if [[ ! -f "$cached_checksum_file" ]]; then
        return 0
    fi

    local cached_checksum
    cached_checksum=$(cat "$cached_checksum_file" 2>/dev/null || echo "")

    if [[ "$current_checksum" != "$cached_checksum" ]]; then
        return 0
    fi

    # Return 1 to indicate no rebuild needed (caller must use set +e)
    return 1
}

update_service_checksum() {
    local service_name="$1"
    local service_dir="$2"
    local dockerfile="$3"

    local current_checksum
    current_checksum=$(calculate_service_checksum "$service_name" "$service_dir" "$dockerfile")
    echo "$current_checksum" > "${CHECKSUM_DIR}/${service_name}.checksum"
}

# Record which image tag a service was last successfully built under, next to
# its checksum. Needed because IMAGE_TAG now varies per build (semver-run-sha)
# rather than being the constant "latest".
record_service_tag() {
    mkdir -p "$CHECKSUM_DIR" 2>/dev/null || true
    echo "${IMAGE_TAG}" > "${CHECKSUM_DIR}/${1}.tag" 2>/dev/null || true
}

# A service whose sources are unchanged is not rebuilt -- but the deploy still
# rewrites the manifests to ${IMAGE_TAG}, and sync_images_to_k3s only syncs
# images that exist under that exact tag. With a constant "latest" tag this was
# invisible; with per-build tags a skipped service would leave the cluster
# pointing at an image nobody ever built (ImagePullBackOff).
#
# So on skip, re-tag the image the previous build produced. Returns non-zero if
# that image is gone (pruned), in which case the caller must build after all.
reuse_service_image() {
    local service="$1"
    local tag_file="${CHECKSUM_DIR}/${service}.tag"
    local previous
    previous=$(cat "$tag_file" 2>/dev/null || echo "")

    [[ -z "$previous" ]] && return 1
    [[ "$previous" == "${IMAGE_TAG}" ]] && return 0

    if ! docker image inspect "${service}:${previous}" >/dev/null 2>&1; then
        verbose "reuse_service_image: ${service}:${previous} is gone, rebuilding"
        return 1
    fi

    docker tag "${service}:${previous}" "${service}:${IMAGE_TAG}" 2>/dev/null || return 1
    record_service_tag "$service"
    verbose "reuse_service_image: re-tagged ${service} ${previous} -> ${IMAGE_TAG}"
    return 0
}

clear_all_checksums() {
    rm -f "${CHECKSUM_DIR}"/*.checksum 2>/dev/null || true
}

# =============================================================================
# Single-Line Build Progress with Descriptive Steps
# =============================================================================

# Parse build log to get human-readable step description
get_build_step_description() {
    local log_line="$1"
    local image_name="$2"

    # Extract the command being run (after RUN, COPY, FROM, etc.)
    local desc=""

    # Check for specific patterns and provide friendly descriptions
    if echo "$log_line" | grep -qi "FROM.*nvidia/cuda"; then
        desc="Pulling NVIDIA CUDA base image"
    elif echo "$log_line" | grep -qi "FROM.*python"; then
        desc="Pulling Python base image"
    elif echo "$log_line" | grep -qi "FROM.*node"; then
        desc="Pulling Node.js base image"
    elif echo "$log_line" | grep -qi "apt-get update\|apt-get install"; then
        desc="Installing system dependencies"
    elif echo "$log_line" | grep -qi "add-apt-repository"; then
        desc="Adding package repository"
    elif echo "$log_line" | grep -qi "pip install.*requirements"; then
        desc="Installing Python dependencies"
    elif echo "$log_line" | grep -qi "pip install"; then
        desc="Installing Python packages"
    elif echo "$log_line" | grep -qi "npm install\|npm ci"; then
        desc="Installing Node.js dependencies"
    elif echo "$log_line" | grep -qi "npm run build"; then
        desc="Building application"
    elif echo "$log_line" | grep -qi "npx prisma generate"; then
        desc="Generating Prisma client"
    elif echo "$log_line" | grep -qi "grpc_tools.protoc\|protoc"; then
        desc="Compiling gRPC protobuf"
    elif echo "$log_line" | grep -qi "COPY.*requirements\|COPY.*package"; then
        desc="Copying dependency files"
    elif echo "$log_line" | grep -qi "COPY.*src\|COPY.*\."; then
        desc="Copying source code"
    elif echo "$log_line" | grep -qi "WORKDIR"; then
        desc="Setting up workspace"
    elif echo "$log_line" | grep -qi "ENV "; then
        desc="Configuring environment"
    elif echo "$log_line" | grep -qi "onnxruntime-gpu"; then
        desc="Installing ONNX Runtime (GPU)"
    elif echo "$log_line" | grep -qi "onnxruntime"; then
        desc="Installing ONNX Runtime"
    elif echo "$log_line" | grep -qi "faster-whisper\|ctranslate2"; then
        desc="Installing Whisper dependencies"
    elif echo "$log_line" | grep -qi "sherpa"; then
        desc="Installing Sherpa-ONNX"
    elif echo "$log_line" | grep -qi "kokoro"; then
        desc="Installing Kokoro TTS"
    elif echo "$log_line" | grep -qi "torch\|pytorch"; then
        desc="Installing PyTorch"
    elif echo "$log_line" | grep -qi "EXPOSE"; then
        desc="Configuring ports"
    elif echo "$log_line" | grep -qi "exporting to image"; then
        desc="Finalizing image"
    elif echo "$log_line" | grep -qi "writing image"; then
        desc="Writing image layers"
    fi

    echo "$desc"
}

build_with_progress() {
    local image_name="${1:-}"
    local tag="${2:-}"
    local context="${3:-}"
    local build_args="${4:-}"
    local dockerfile="${5:-Dockerfile}"

    # Validate required parameters
    if [[ -z "$image_name" || -z "$tag" || -z "$context" ]]; then
        echo ""
        error "build_with_progress: missing required parameters"
        echo "  image_name='$image_name' tag='$tag' context='$context'"
        exit 1
    fi

    local log_file="${LOG_DIR:-/tmp}/docker-build-${image_name}.log"

    # Dry-run mode
    if [[ "${DRY_RUN_MODE:-false}" == "true" ]]; then
        echo -e "   ${ARROW} ${image_name}... ${YELLOW}[dry-run]${NC}"
        return 0
    fi

    # Ensure log directory exists
    mkdir -p "${LOG_DIR:-/tmp}" 2>/dev/null || true

    # Clear previous log
    : > "$log_file" 2>/dev/null || true

    # Build flags
    local no_cache=""
    [[ "${REBUILD_MODE:-false}" == "true" ]] && no_cache="--no-cache"

    # Check dockerfile exists
    if [[ ! -f "$dockerfile" ]]; then
        echo ""
        error "Dockerfile not found: $dockerfile"
        echo "  Current directory: $(pwd)"
        echo "  Looking for: $dockerfile"
        ls -la "$(dirname "$dockerfile")" 2>/dev/null | head -10 || true
        exit 1
    fi

    # Check context exists
    if [[ ! -d "$context" && "$context" != "." ]]; then
        echo ""
        error "Build context not found: $context"
        exit 1
    fi

    # Check docker is available
    if ! command -v docker &>/dev/null; then
        echo ""
        error "Docker not found in PATH"
        exit 1
    fi

    # Check docker daemon is running
    if ! docker info &>/dev/null; then
        echo ""
        error "Docker daemon is not running"
        echo "  Try: sudo systemctl start docker"
        exit 1
    fi

    # Build the docker command
    # Use --output type=docker to force overwrite existing images (fixes "already exists" error)
    local docker_cmd="docker build --progress=plain"
    [[ -n "$no_cache" ]] && docker_cmd="$docker_cmd $no_cache"
    [[ -n "$build_args" ]] && docker_cmd="$docker_cmd $build_args"
    docker_cmd="$docker_cmd -f \"$dockerfile\" --network=host -t \"$tag\""

    # For BuildKit, add output flag to force overwrite
    if [[ "${USE_BUILDKIT:-false}" == "true" ]]; then
        docker_cmd="$docker_cmd --output type=docker"
    fi

    docker_cmd="$docker_cmd \"$context\""

    if [[ "${VERBOSE_MODE:-false}" == "true" ]]; then
        echo "[DEBUG] build_with_progress: docker_cmd=$docker_cmd"
        echo "[DEBUG] build_with_progress: USE_BUILDKIT=${USE_BUILDKIT:-false}"
    fi

    # Start build in background - protect with set +e
    set +e
    if [[ "${USE_BUILDKIT:-false}" == "true" ]]; then
        DOCKER_BUILDKIT=1 eval "$docker_cmd" > "$log_file" 2>&1 &
    else
        eval "$docker_cmd" > "$log_file" 2>&1 &
    fi
    local build_pid=$!
    local bg_exit=$?
    set -e

    if [[ "${VERBOSE_MODE:-false}" == "true" ]]; then
        echo "[DEBUG] build_with_progress: background job started, pid=$build_pid, bg_exit=$bg_exit"
    fi

    # Verify build process started
    sleep 0.2

    # Protect kill -0 check with set +e (already set above, but be explicit)
    set +e
    kill -0 $build_pid 2>/dev/null
    local process_check=$?
    set -e

    if [[ "${VERBOSE_MODE:-false}" == "true" ]]; then
        echo "[DEBUG] build_with_progress: process_check=$process_check (0=running, 1=not running)"
    fi

    if [[ $process_check -ne 0 ]]; then
        echo ""
        error "Docker build process failed to start for $image_name"
        echo "  Command: $docker_cmd"
        if [[ -f "$log_file" ]]; then
            echo "  Log contents:"
            head -20 "$log_file" 2>/dev/null || echo "  (could not read log)"
        fi
        exit 1
    fi

    # Initial status line
    echo -ne "   ${ARROW} ${image_name}... "

    # DEBUG: Add explicit checkpoints to find where script exits
    if [[ "${VERBOSE_MODE:-false}" == "true" ]]; then
        echo ""
        echo "[DEBUG] build_with_progress: after initial echo, pid=$build_pid"
    fi

    # Use set +e for all remaining logic to prevent any command from causing exit
    set +e

    local last_step=""
    local last_desc=""
    # Define spinner chars safely
    local spinner_chars
    spinner_chars=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
    local spinner_idx=0

    if [[ "${VERBOSE_MODE:-false}" == "true" ]]; then
        echo "[DEBUG] build_with_progress: entering while loop"
    fi

    # Monitor build progress
    while kill -0 "$build_pid" 2>/dev/null; do
        if [[ -f "$log_file" ]]; then
            # Get last meaningful lines from log
            local recent_log
            recent_log=$(tail -n 50 "$log_file" 2>/dev/null)

            # Extract current step number (e.g., "[5/12]" or "Step 5/12")
            local step_num
            step_num=$(echo "$recent_log" | grep -oE '\[#?[0-9]+ [0-9]+/[0-9]+\]|Step [0-9]+/[0-9]+|\[[0-9]+/[0-9]+\]' | tail -1)

            # Get the line containing RUN/COPY/FROM to understand what's happening
            local action_line
            action_line=$(echo "$recent_log" | grep -E '(RUN |COPY |FROM |ENV |WORKDIR |apt-get|pip install|npm |npx |exporting|writing)' | tail -1)

            # Get human-readable description
            local desc
            desc=$(get_build_step_description "$action_line" "$image_name")

            # Build display string
            local display=""
            if [[ -n "$step_num" ]]; then
                display="${step_num}"
            fi
            if [[ -n "$desc" ]]; then
                if [[ -n "$display" ]]; then
                    display="${display} ${desc}"
                else
                    display="${desc}"
                fi
            fi

            # Update display if changed
            if [[ -n "$display" && "$display" != "$last_desc" ]]; then
                # Truncate if too long (terminal width consideration)
                if [[ ${#display} -gt 50 ]]; then
                    display="${display:0:47}..."
                fi
                printf "\r   ${ARROW} ${image_name}... ${DIM}${display}${NC}%-20s" " "
                last_desc="$display"
            else
                # Show spinner for activity indication
                local spinner="${spinner_chars[$spinner_idx]}"
                spinner_idx=$(( (spinner_idx + 1) % ${#spinner_chars[@]} ))
                printf "\r   ${ARROW} ${image_name}... ${DIM}${last_desc:-Building}${NC} ${CYAN}${spinner}${NC}%-5s" " "
            fi
        fi
        sleep 0.2
    done

    if [[ "${VERBOSE_MODE:-false}" == "true" ]]; then
        echo ""
        echo "[DEBUG] build_with_progress: exited while loop, waiting for pid=$build_pid"
    fi

    # Wait for build to complete and get exit code
    # Note: set +e is already active from above
    wait $build_pid 2>/dev/null
    local exit_code=$?

    if [[ "${VERBOSE_MODE:-false}" == "true" ]]; then
        echo "[DEBUG] build_with_progress: wait completed, exit_code=$exit_code"
    fi

    # Clear line and show final status
    if [[ $exit_code -eq 0 ]]; then
        printf "\r   ${ARROW} ${image_name}... ${GREEN}${CHECK}${NC}%-60s\n" " "
        rm -f "$log_file" 2>/dev/null || true
        # Re-enable strict mode before returning
        set -e
        return 0
    else
        printf "\r   ${ARROW} ${image_name}... ${RED}${CROSS}${NC}%-60s\n" " "
        echo ""
        error "Build failed for ${image_name} (exit code: $exit_code)"
        echo ""
        echo -e "${BOLD}Build Log:${NC} $log_file"
        echo ""
        # Show more context from the log
        if [[ -f "$log_file" && -s "$log_file" ]]; then
            echo -e "${DIM}--- Last 50 lines of build output ---${NC}"
            tail -n 50 "$log_file" | sed 's/^/  /'
            echo -e "${DIM}--------------------------------------${NC}"
        else
            echo -e "${YELLOW}No build output captured. Docker may have failed to start.${NC}"
            echo "  Check if Docker is running: docker info"
            echo "  Check disk space: df -h"
        fi
        echo ""
        # Re-enable strict mode before exiting
        set -e
        exit 1
    fi
}

# =============================================================================
# Smart Build Wrapper
# =============================================================================

smart_build() {
    local image_name="$1"
    local tag="$2"
    local context="$3"
    local build_args="${4:-}"
    local dockerfile="${5:-Dockerfile}"

    [[ "${VERBOSE_MODE:-false}" == "true" ]] && echo "[DEBUG] smart_build: starting for $image_name"

    # Skip-build mode
    if [[ "$SKIP_BUILD_MODE" == "true" ]]; then
        echo -e "   ${ARROW} ${image_name}... ${YELLOW}skipped${NC}"
        return 0  # Not an error, just skipped
    fi

    # Determine paths
    local service_dir="$context"
    local dockerfile_path="${context}/${dockerfile}"
    if [[ "$context" == "." ]]; then
        dockerfile_path="./${dockerfile}"
    fi

    [[ "${VERBOSE_MODE:-false}" == "true" ]] && echo "[DEBUG] smart_build: dockerfile_path=$dockerfile_path"

    # Verify dockerfile exists before checking if rebuild needed
    if [[ ! -f "$dockerfile_path" ]]; then
        echo -e "   ${ARROW} ${image_name}... ${RED}${CROSS}${NC}"
        error "Dockerfile not found: $dockerfile_path"
        exit 1
    fi

    # Rebuild mode: always build
    if [[ "$REBUILD_MODE" == "true" ]]; then
        [[ "${VERBOSE_MODE:-false}" == "true" ]] && echo "[DEBUG] smart_build: REBUILD_MODE=true, calling build_with_progress"
        build_with_progress "$image_name" "$tag" "$context" "$build_args" "$dockerfile_path"
        # If we get here, build succeeded (build_with_progress exits on failure)
        [[ "${VERBOSE_MODE:-false}" == "true" ]] && echo "[DEBUG] smart_build: build_with_progress returned successfully"
        set +e
        update_service_checksum "$image_name" "$service_dir" "$dockerfile_path" 2>/dev/null
        record_service_tag "$image_name"
        set -e
        REBUILT_SERVICES+=("$image_name")
        return 0
    fi

    # Smart mode: check if rebuild needed
    set +e
    service_needs_rebuild "$image_name" "$service_dir" "$dockerfile_path"
    local needs_rebuild=$?
    set -e

    if [[ $needs_rebuild -eq 0 ]]; then
        build_with_progress "$image_name" "$tag" "$context" "$build_args" "$dockerfile_path"
        # If we get here, build succeeded (build_with_progress exits on failure)
        set +e
        update_service_checksum "$image_name" "$service_dir" "$dockerfile_path" 2>/dev/null
        record_service_tag "$image_name"
        set -e
        REBUILT_SERVICES+=("$image_name")
        return 0
    else
        if reuse_service_image "$image_name"; then
            echo -e "   ${ARROW} ${image_name}... ${DIM}unchanged${NC}"
            return 0  # Not an error, just unchanged
        fi
        verbose "smart_build: ${image_name} unchanged but image missing, building"
    fi
}

# =============================================================================
# Parallel Build Support
# =============================================================================

# Arrays to track parallel builds
declare -a PARALLEL_BUILD_PIDS=()
declare -a PARALLEL_BUILD_NAMES=()
declare -a PARALLEL_BUILD_LOGS=()
declare -a PARALLEL_BUILD_CHECKSUMS=()

# Start a build in background for parallel execution
# Usage: start_parallel_build "name" "tag" "context" "build_args" "dockerfile"
start_parallel_build() {
    local image_name="$1"
    local tag="$2"
    local context="$3"
    local build_args="${4:-}"
    local dockerfile="${5:-Dockerfile}"

    # Skip-build mode
    if [[ "$SKIP_BUILD_MODE" == "true" ]]; then
        echo -e "   ${ARROW} ${image_name}... ${YELLOW}skipped${NC}"
        return 0
    fi

    # Determine paths
    local service_dir="$context"
    local dockerfile_path="${context}/${dockerfile}"
    if [[ "$context" == "." ]]; then
        dockerfile_path="./${dockerfile}"
    fi

    # Verify dockerfile exists
    if [[ ! -f "$dockerfile_path" ]]; then
        echo -e "   ${ARROW} ${image_name}... ${RED}${CROSS}${NC} (Dockerfile not found)"
        return 1
    fi

    # Check if rebuild needed (unless in rebuild mode)
    if [[ "$REBUILD_MODE" != "true" ]]; then
        set +e
        service_needs_rebuild "$image_name" "$service_dir" "$dockerfile_path"
        local needs_rebuild=$?
        set -e

        if [[ $needs_rebuild -ne 0 ]]; then
            if reuse_service_image "$image_name"; then
                echo -e "   ${ARROW} ${image_name}... ${DIM}unchanged${NC}"
                return 0
            fi
            verbose "start_parallel_build: ${image_name} unchanged but image missing, building"
        fi
    fi

    # Dry-run mode
    if [[ "${DRY_RUN_MODE:-false}" == "true" ]]; then
        echo -e "   ${ARROW} ${image_name}... ${YELLOW}[dry-run]${NC}"
        return 0
    fi

    local log_file="${LOG_DIR:-/tmp}/docker-build-${image_name}.log"
    mkdir -p "${LOG_DIR:-/tmp}" 2>/dev/null || true
    : > "$log_file" 2>/dev/null || true

    # Build flags
    local no_cache=""
    [[ "${REBUILD_MODE:-false}" == "true" ]] && no_cache="--no-cache"

    # Build the docker command
    # Use --output type=docker to force overwrite existing images (fixes "already exists" error)
    local docker_cmd="docker build --progress=plain"
    [[ -n "$no_cache" ]] && docker_cmd="$docker_cmd $no_cache"
    [[ -n "$build_args" ]] && docker_cmd="$docker_cmd $build_args"
    docker_cmd="$docker_cmd -f \"$dockerfile_path\" --network=host -t \"$tag\""

    # For BuildKit, add output flag to force overwrite
    if [[ "${USE_BUILDKIT:-false}" == "true" ]]; then
        docker_cmd="$docker_cmd --output type=docker"
    fi

    docker_cmd="$docker_cmd \"$context\""

    # Start build in background
    if [[ "${USE_BUILDKIT:-false}" == "true" ]]; then
        DOCKER_BUILDKIT=1 eval "$docker_cmd" > "$log_file" 2>&1 &
    else
        eval "$docker_cmd" > "$log_file" 2>&1 &
    fi
    local build_pid=$!

    # Track this build
    PARALLEL_BUILD_PIDS+=("$build_pid")
    PARALLEL_BUILD_NAMES+=("$image_name")
    PARALLEL_BUILD_LOGS+=("$log_file")
    PARALLEL_BUILD_CHECKSUMS+=("${service_dir}:${dockerfile_path}")

    verbose "Started build: $image_name (pid $build_pid)"
}

# Get current build status from log file
get_build_status_from_log() {
    local log_file="$1"
    local status="starting..."

    if [[ -f "$log_file" && -s "$log_file" ]]; then
        local recent_log
        recent_log=$(tail -n 30 "$log_file" 2>/dev/null || echo "")

        if [[ -n "$recent_log" ]]; then
            # Try to get a meaningful status from the log
            local step_info
            step_info=$(echo "$recent_log" | grep -oE '\[#?[0-9]+ [0-9]+/[0-9]+\]|Step [0-9]+/[0-9]+|\[[0-9]+/[0-9]+\]' | tail -1)

            local action_line
            action_line=$(echo "$recent_log" | grep -E '(RUN |COPY |FROM |ENV |WORKDIR |apt-get|pip install|npm |npx |exporting|writing)' | tail -1)

            local desc
            desc=$(get_build_step_description "$action_line" "")

            if [[ -n "$step_info" && -n "$desc" ]]; then
                status="${step_info} ${desc}"
            elif [[ -n "$desc" ]]; then
                status="$desc"
            elif [[ -n "$step_info" ]]; then
                status="$step_info"
            else
                # Fallback: check for common patterns
                if echo "$recent_log" | grep -qi "downloading\|pulling"; then
                    status="Downloading..."
                elif echo "$recent_log" | grep -qi "extracting"; then
                    status="Extracting..."
                elif echo "$recent_log" | grep -qi "compiling\|building"; then
                    status="Compiling..."
                else
                    status="building..."
                fi
            fi
        fi
    fi

    # Truncate if too long
    if [[ ${#status} -gt 45 ]]; then
        status="${status:0:42}..."
    fi

    echo "$status"
}

# Wait for all parallel builds to complete with real-time status display
wait_for_parallel_builds() {
    if [[ ${#PARALLEL_BUILD_PIDS[@]} -eq 0 ]]; then
        return 0
    fi

    # Disable errexit for the entire monitoring function
    set +e

    local total=${#PARALLEL_BUILD_PIDS[@]}
    local completed=0
    local failed=0
    local failed_services=()

    echo ""
    info "Building $total images in parallel (using ${CPU_CORES:-4} CPU cores)..."
    echo ""

    # Store original arrays (we'll track status separately)
    declare -a all_pids=("${PARALLEL_BUILD_PIDS[@]}")
    declare -a all_names=("${PARALLEL_BUILD_NAMES[@]}")
    declare -a all_logs=("${PARALLEL_BUILD_LOGS[@]}")
    declare -a all_checksums=("${PARALLEL_BUILD_CHECKSUMS[@]}")
    declare -a all_status=()
    declare -a all_done=()

    # Initialize status for each build
    for i in "${!all_names[@]}"; do
        all_status[$i]="building..."
        all_done[$i]="false"
    done

    local spinner_idx=0

    # Track per-build start times
    declare -a all_start_times=()
    for i in "${!all_names[@]}"; do
        all_start_times[$i]=$SECONDS
    done

    # Get terminal width for line truncation — prevents wrapping which breaks
    # the cursor-up approach in narrow/split terminal panes
    local cols
    cols=$(tput cols 2>/dev/null || echo 80)

    # Print initial status lines for all services
    for i in "${!all_names[@]}"; do
        echo -e "   ${ARROW} ${all_names[$i]}...$(printf '%*s' $((30 - ${#all_names[$i]})) '')${DIM}building...${NC} ${CYAN}⠋${NC}"
    done

    # Main monitoring loop — multi-line in-place update via cursor-up
    while [[ $completed -lt $total ]]; do
        for i in "${!all_pids[@]}"; do
            if [[ "${all_done[$i]}" == "true" ]]; then
                continue
            fi

            local pid="${all_pids[$i]}"
            local name="${all_names[$i]}"
            local log="${all_logs[$i]}"
            local checksum_info="${all_checksums[$i]}"

            # Check if process is still running
            kill -0 "$pid" 2>/dev/null
            local still_running=$?

            if [[ $still_running -ne 0 ]]; then
                wait "$pid" 2>/dev/null
                local exit_code=$?
                local elapsed=$(( SECONDS - all_start_times[$i] ))

                ((completed++))
                all_done[$i]="true"

                if [[ $exit_code -eq 0 ]]; then
                    all_status[$i]="${CHECK} done  ${elapsed}s"
                    rm -f "$log" 2>/dev/null || true
                    REBUILT_SERVICES+=("$name")

                    local service_dir="${checksum_info%%:*}"
                    local dockerfile_path="${checksum_info#*:}"
                    update_service_checksum "$name" "$service_dir" "$dockerfile_path" 2>/dev/null || true
                    record_service_tag "$name"
                else
                    all_status[$i]="${CROSS} FAILED"
                    ((failed++))
                    failed_services+=("$name:$log")
                fi
            else
                local new_status
                new_status=$(get_build_status_from_log "$log" 2>/dev/null || echo "building...")
                all_status[$i]="$new_status"
            fi
        done

        # Move cursor up to redraw all status lines in place
        echo -ne "\033[${total}A"

        # Re-check terminal width (user may resize)
        cols=$(tput cols 2>/dev/null || echo 80)
        # Fixed prefix width: "   → name..." + padding = 40 visible chars
        # Remaining space for: status + spinner + margin
        local max_status=$(( cols - 42 ))
        [[ $max_status -lt 10 ]] && max_status=10

        for i in "${!all_names[@]}"; do
            local name="${all_names[$i]}"
            local status="${all_status[$i]}"

            echo -ne "\r\033[K"
            if [[ "${all_done[$i]}" == "true" ]]; then
                echo -e "   ${ARROW} ${name}...$(printf '%*s' $((30 - ${#name})) '')${GREEN}${status}${NC}"
            else
                # Truncate status to prevent line wrapping
                if [[ ${#status} -gt $max_status ]]; then
                    status="${status:0:$((max_status - 1))}…"
                fi
                local spinner="${SPINNER_CHARS[$spinner_idx]}"
                echo -e "   ${ARROW} ${name}...$(printf '%*s' $((30 - ${#name})) '')${DIM}${status}${NC} ${CYAN}${spinner}${NC}"
            fi
        done

        spinner_idx=$(( (spinner_idx + 1) % ${#SPINNER_CHARS[@]} ))
        sleep 0.2
    done

    echo ""

    # Clear tracking arrays
    PARALLEL_BUILD_PIDS=()
    PARALLEL_BUILD_NAMES=()
    PARALLEL_BUILD_LOGS=()
    PARALLEL_BUILD_CHECKSUMS=()

    # Report failures with full error details
    if [[ $failed -gt 0 ]]; then
        echo ""
        error "$failed of $total build(s) failed:"

        for entry in "${failed_services[@]}"; do
            local name="${entry%%:*}"
            local log="${entry#*:}"
            echo ""
            echo -e "${BOLD}═══ FAILED: $name ═══${NC}"
            echo -e "${DIM}Log file: $log${NC}"
            echo ""
            if [[ -f "$log" && -s "$log" ]]; then
                echo -e "${DIM}--- Build output (last 50 lines) ---${NC}"
                tail -n 50 "$log" | sed 's/^/  /'
                echo -e "${DIM}------------------------------------${NC}"
            else
                echo "  (no log output captured)"
            fi
        done
        echo ""

        # Re-enable errexit before returning
        set -e
        return 1
    fi

    # Re-enable errexit before returning
    set -e
    return 0
}

# =============================================================================
# Agent Auto-Discovery
# =============================================================================
# Scans agents/ for subdirectories containing a Dockerfile.
# This allows new agents to be built automatically without editing this script.

# Discovered agent names (populated by discover_agents)
declare -a DISCOVERED_AGENTS=()

discover_agents() {
    DISCOVERED_AGENTS=()
    local agents_dir="${PROJECT_DIR:-.}/agents"

    if [[ ! -d "$agents_dir" ]]; then
        verbose "No agents/ directory found"
        return
    fi

    for agent_dir in "$agents_dir"/*/; do
        # Skip if not a directory
        [[ ! -d "$agent_dir" ]] && continue

        local agent_name
        agent_name=$(basename "$agent_dir")

        # An agent must have a Dockerfile to be buildable
        if [[ -f "${agent_dir}Dockerfile" ]]; then
            DISCOVERED_AGENTS+=("$agent_name")
            verbose "Discovered agent: $agent_name"
        fi
    done

    if [[ ${#DISCOVERED_AGENTS[@]} -gt 0 ]]; then
        verbose "Auto-discovered ${#DISCOVERED_AGENTS[@]} agent(s): ${DISCOVERED_AGENTS[*]}"
    fi
}

# Returns the full list of all buildable image names (core services + agents).
# Used by cleanup_for_rebuild and sync_images_to_k3s for consistent handling.
get_all_image_names() {
    local core_images=("session-management-server" "stt-service" "tts-service" "frontend-ui" "message-recorder-python")
    echo "${core_images[@]} ${DISCOVERED_AGENTS[*]}"
}

# =============================================================================
# Build All Images
# =============================================================================

build_images() {
    info "${EMOJI_BUILD} Building Docker images..."

    [[ "${VERBOSE_MODE:-false}" == "true" ]] && echo "[DEBUG] build_images: starting"

    # Setup BuildKit
    setup_buildkit

    [[ "${VERBOSE_MODE:-false}" == "true" ]] && echo "[DEBUG] build_images: buildkit setup complete"

    # Auto-discover agents from agents/ directory (needed by cleanup and build)
    discover_agents

    # Clean up if rebuild mode
    if [[ "$REBUILD_MODE" == "true" ]]; then
        [[ "${VERBOSE_MODE:-false}" == "true" ]] && echo "[DEBUG] build_images: running cleanup_for_rebuild"
        cleanup_for_rebuild
        [[ "${VERBOSE_MODE:-false}" == "true" ]] && echo "[DEBUG] build_images: cleanup_for_rebuild complete"
    fi

    # Reset rebuilt services list
    REBUILT_SERVICES=()

    # Prepare build arguments
    local prisma_checksum
    prisma_checksum=$(hash_file "./prisma/schema.prisma" 2>/dev/null || echo "none")
    # No DATABASE_URL build arg: the Dockerfile never declares `ARG DATABASE_URL`
    # and `prisma generate` does not need a reachable database, so Docker
    # discarded it as an unconsumed arg. All it achieved was putting the
    # postgres password in the build host's process list and in CI logs. The
    # real value is supplied at runtime from the k8s secret.
    local session_args="--build-arg PRISMA_SCHEMA_CHECKSUM=${prisma_checksum}"

    local gpu_args=""
    if [[ "$ENABLE_GPU" == "true" ]]; then
        gpu_args="--build-arg ENABLE_GPU=true"
    fi

    # Get app version from package.json for frontend-ui
    local app_version
    app_version=$(grep '"version"' package.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
    local frontend_args="--build-arg APP_VERSION=${app_version}"

    # ==========================================================================
    # PARALLEL BUILDS - All services are independent, no inter-dependencies
    # ==========================================================================

    # Start all builds in parallel (each docker build uses multiple cores internally)

    # Core services
    start_parallel_build "session-management-server" "session-management-server:${IMAGE_TAG}" "." "$session_args"
    start_parallel_build "stt-service" "stt-service:${IMAGE_TAG}" "./stt-service" "$gpu_args"
    # The tts-service image is single-provider. TTS_PROVIDER picks which
    # provider's deps the build installs; every other provider's import
    # guard then reports is_available=False at runtime. Keeps the image
    # small and avoids per-provider torch/onnx version conflicts.
    local tts_args="$gpu_args --build-arg TTS_PROVIDER=${TTS_PROVIDER:-piper}"
    start_parallel_build "tts-service" "tts-service:${IMAGE_TAG}" "./tts-service" "$tts_args"
    start_parallel_build "frontend-ui" "frontend-ui:${IMAGE_TAG}" "./frontend-ui" "$frontend_args"
    start_parallel_build "message-recorder-python" "message-recorder-python:${IMAGE_TAG}" "./message-recorder-python"

    # Auto-discovered agents (any directory under agents/ with a Dockerfile)
    for agent_name in "${DISCOVERED_AGENTS[@]}"; do
        start_parallel_build "$agent_name" "${agent_name}:${IMAGE_TAG}" "." "" "agents/${agent_name}/Dockerfile"
    done

    # Wait for all parallel builds to complete
    local build_start=$SECONDS
    set +e
    wait_for_parallel_builds
    local build_result=$?
    set -e
    local build_elapsed=$(( SECONDS - build_start ))

    if [[ $build_result -ne 0 ]]; then
        exit 1
    fi

    # Summary
    echo ""
    if [[ ${#REBUILT_SERVICES[@]} -gt 0 ]]; then
        success "Built ${#REBUILT_SERVICES[@]} image(s) in ${build_elapsed}s"
    else
        success "All images up to date"
    fi

    # Import to K3s if on Linux
    if [[ "$OS_TYPE" == "linux" && ${#REBUILT_SERVICES[@]} -gt 0 ]]; then
        import_images_to_k3s
    fi

    # Always sync images to K3s on Linux (ensure all images are available)
    if [[ "$OS_TYPE" == "linux" ]]; then
        sync_images_to_k3s
    fi

    # Prune build cache after rebuild to reclaim disk space
    # Only on --rebuild since incremental builds benefit from the cache
    if [[ "$REBUILD_MODE" == "true" && ${#REBUILT_SERVICES[@]} -gt 0 ]]; then
        # Bound the cache, do not delete it. A full prune meant the next
        # build recompiled the entire CUDA/torch stack from nothing; the
        # disk it was protecting has hundreds of GB free.
        docker builder prune -f --max-used-space 50GB >/dev/null 2>&1 || true
        verbose "build_images: build cache trimmed to 50GB"
    fi
}

# =============================================================================
# K3s Image Import (Linux only)
# =============================================================================

# Import a single image to K3s with spinner
import_single_image_to_k3s() {
    local service="$1"
    docker save "${service}:${IMAGE_TAG}" | sudo k3s ctr images import - >/dev/null 2>&1
}

import_images_to_k3s() {
    [[ "$DRY_RUN_MODE" == "true" ]] && return 0
    [[ ${#REBUILT_SERVICES[@]} -eq 0 ]] && return 0

    info "${EMOJI_GEAR} Importing images to K3s..."

    for service in "${REBUILT_SERVICES[@]}"; do
        # Show spinner while importing
        echo -ne "   ${ARROW} ${service}... "

        # Start import in background
        docker save "${service}:${IMAGE_TAG}" 2>/dev/null | sudo k3s ctr images import - >/dev/null 2>&1 &
        local pid=$!

        # Spinner animation
        local spinner_idx=0
        while kill -0 $pid 2>/dev/null; do
            local spinner="${SPINNER_CHARS[$spinner_idx]}"
            printf "\r   ${ARROW} ${service}... ${CYAN}${spinner}${NC} "
            spinner_idx=$(( (spinner_idx + 1) % ${#SPINNER_CHARS[@]} ))
            sleep 0.1
        done

        wait $pid
        local exit_code=$?

        if [[ $exit_code -eq 0 ]]; then
            printf "\r   ${ARROW} ${service}... ${GREEN}${CHECK}${NC}    \n"
        else
            printf "\r   ${ARROW} ${service}... ${RED}${CROSS}${NC}    \n"
            warning "Failed to import ${service} to K3s"
        fi
    done
}

# =============================================================================
# K3s Image Sync (Linux only)
# =============================================================================
# Ensures all images that exist in Docker are also available in K3s containerd.
# This handles cases where images exist in Docker but not K3s (e.g., after
# a partial deploy or when images were built outside of start-k8s.sh).

sync_images_to_k3s() {
    [[ "$DRY_RUN_MODE" == "true" ]] && return 0

    # Build image list dynamically from core services + discovered agents
    local all_images
    read -ra all_images <<< "$(get_all_image_names)"
    local images_to_sync=()

    # Find images that exist in Docker but not in K3s
    for img in "${all_images[@]}"; do
        # Check if image exists in Docker
        if docker images -q "${img}:${IMAGE_TAG}" 2>/dev/null | grep -q .; then
            # Check if image exists in K3s containerd
            if ! sudo k3s ctr images ls -q 2>/dev/null | grep -q "docker.io/library/${img}:${IMAGE_TAG}"; then
                images_to_sync+=("$img")
            fi
        fi
    done

    # Sync missing images
    if [[ ${#images_to_sync[@]} -gt 0 ]]; then
        info "${EMOJI_GEAR} Syncing missing images to K3s..."
        for img in "${images_to_sync[@]}"; do
            # Show spinner while syncing
            echo -ne "   ${ARROW} ${img}... "

            # Start sync in background
            docker save "${img}:${IMAGE_TAG}" 2>/dev/null | sudo k3s ctr images import - >/dev/null 2>&1 &
            local pid=$!

            # Spinner animation
            local spinner_idx=0
            while kill -0 $pid 2>/dev/null; do
                local spinner="${SPINNER_CHARS[$spinner_idx]}"
                printf "\r   ${ARROW} ${img}... ${CYAN}${spinner}${NC} "
                spinner_idx=$(( (spinner_idx + 1) % ${#SPINNER_CHARS[@]} ))
                sleep 0.1
            done

            wait $pid
            local exit_code=$?

            if [[ $exit_code -eq 0 ]]; then
                printf "\r   ${ARROW} ${img}... ${GREEN}${CHECK}${NC}    \n"
            else
                printf "\r   ${ARROW} ${img}... ${RED}${CROSS}${NC}    \n"
            fi
        done
    fi
}

# =============================================================================
# Cleanup for Rebuild
# =============================================================================

cleanup_for_rebuild() {
    [[ "$DRY_RUN_MODE" == "true" ]] && return 0

    verbose "Cleaning up for rebuild..."
    [[ "${VERBOSE_MODE:-false}" == "true" ]] && echo "[DEBUG] cleanup_for_rebuild: starting"

    # Delete application pods (keep postgres unless reset-db)
    if [[ "$RESET_DB_MODE" == "true" ]]; then
        kubectl delete pods -n "$KUBERNETES_NAMESPACE" --all --grace-period=5 2>/dev/null || true
        kubectl delete pvc -n "$KUBERNETES_NAMESPACE" --all 2>/dev/null || true
    else
        kubectl delete pods -n "$KUBERNETES_NAMESPACE" -l app!=postgres --grace-period=5 2>/dev/null || true
    fi
    [[ "${VERBOSE_MODE:-false}" == "true" ]] && echo "[DEBUG] cleanup_for_rebuild: pods deleted"

    # Clean up failed pods
    kubectl delete pods -n "$KUBERNETES_NAMESPACE" --field-selector=status.phase=Failed 2>/dev/null || true

    # Remove old Docker images (core services + discovered agents)
    local images
    read -ra images <<< "$(get_all_image_names)"
    for img in "${images[@]}"; do
        docker rmi "${img}:${IMAGE_TAG}" 2>/dev/null || true
    done
    [[ "${VERBOSE_MODE:-false}" == "true" ]] && echo "[DEBUG] cleanup_for_rebuild: docker images removed"

    # Clean K3s containerd images (Linux)
    if [[ "$OS_TYPE" == "linux" ]]; then
        for img in "${images[@]}"; do
            sudo k3s ctr images rm "docker.io/library/${img}:${IMAGE_TAG}" 2>/dev/null || true
        done
        [[ "${VERBOSE_MODE:-false}" == "true" ]] && echo "[DEBUG] cleanup_for_rebuild: k3s images removed"
    fi

    # Trim, don't wipe: --rebuild should force fresh *images*, not throw away
    # the layer cache that makes the rebuild survivable.
    docker builder prune -f --max-used-space 50GB 2>/dev/null || true
    [[ "${VERBOSE_MODE:-false}" == "true" ]] && echo "[DEBUG] cleanup_for_rebuild: build cache pruned"

    # Clear checksums
    clear_all_checksums
    [[ "${VERBOSE_MODE:-false}" == "true" ]] && echo "[DEBUG] cleanup_for_rebuild: checksums cleared"

    verbose "Cleanup complete"
    [[ "${VERBOSE_MODE:-false}" == "true" ]] && echo "[DEBUG] cleanup_for_rebuild: complete"
}

# =============================================================================
# Service Rebuild Check
# =============================================================================

service_was_rebuilt() {
    local service="$1"
    # Check if array has elements before checking
    [[ ${#REBUILT_SERVICES[@]} -eq 0 ]] && return 1
    array_contains "$service" "${REBUILT_SERVICES[@]}"
}