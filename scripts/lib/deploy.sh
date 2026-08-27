#!/bin/bash
# =============================================================================
# deploy.sh - Kubernetes deployment logic
# =============================================================================

# =============================================================================
# Service Definitions (Bash 3.x compatible - no associative arrays)
# =============================================================================

# Get deployment name for a service
get_deployment_name() {
    local service="$1"
    case "$service" in
        "session-management-server") echo "session-management-server" ;;
        "frontend-ui") echo "frontend-ui" ;;
        "stt-service") echo "stt-service" ;;
        "tts-service") echo "tts-service" ;;
        "message-recorder-python") echo "message-recorder" ;;
        *) echo "$service" ;;
    esac
}

# Get timeout for a deployment
# Note: STT/TTS have longer timeouts for first-time model downloads (init containers)
get_service_timeout() {
    local deploy="$1"
    case "$deploy" in
        "session-management-server") echo 180 ;;
        "frontend-ui") echo 120 ;;
        "stt-service") echo 600 ;;  # 10 min for model downloads
        "tts-service") echo 300 ;;  # 5 min for model downloads
        "message-recorder") echo 60 ;;
        *) echo 120 ;;
    esac
}

# All services list
ALL_SERVICES="session-management-server frontend-ui stt-service tts-service message-recorder-python"
ALL_DEPLOYMENTS="session-management-server frontend-ui stt-service tts-service message-recorder"

# =============================================================================
# Manifest Preparation (namespace + image tag substitution)
# =============================================================================

prepare_manifest() {
    local source="$1"
    local dest="${TEMP_DIR}/k8s-manifests/$(basename "$source")"
    mkdir -p "${TEMP_DIR}/k8s-manifests"
    sed -e "s|namespace: ai-agents|namespace: ${KUBERNETES_NAMESPACE}|g" \
        -e "s|name: ai-agents|name: ${KUBERNETES_NAMESPACE}|g" \
        -e "s|KUBERNETES_NAMESPACE: \"ai-agents\"|KUBERNETES_NAMESPACE: \"${KUBERNETES_NAMESPACE}\"|g" \
        -e "s|:latest|:${IMAGE_TAG}|g" \
        "$source" > "$dest"
    echo "$dest"
}

# =============================================================================
# ConfigMap Generation
# =============================================================================

generate_configmap() {
    local output_file="${TEMP_DIR}/04-configmap-updated.yaml"

    if [[ "$DRY_RUN_MODE" == "true" ]]; then
        verbose "Would generate configmap [dry-run]"
        return 0
    fi

    # Auto-detect K8s DNS IP in production (if not already set)
    if [[ "$NODE_ENV" == "production" && -z "${KUBERNETES_DNS_IP:-}" ]]; then
        local detected_dns
        detected_dns=$(kubectl get svc -n kube-system kube-dns -o jsonpath='{.spec.clusterIP}' 2>/dev/null || echo "")
        if [[ -n "$detected_dns" ]]; then
            export KUBERNETES_DNS_IP="$detected_dns"
            verbose "Auto-detected K8s DNS IP: $KUBERNETES_DNS_IP"
        else
            warning "Could not auto-detect K8s DNS IP - agent pods may fail to resolve internal services"
        fi
    fi

    # Detect host gateway IP for message-recorder
    local host_gateway_ip
    if [[ "$OS_TYPE" == "macos" ]]; then
        # Run detection pod and filter out kubectl status messages
        host_gateway_ip=$(kubectl run gateway-detector --rm -i --restart=Never \
            --image=busybox:1.36 -- sh -c 'ip route | grep default | awk "{print \$3}"' 2>/dev/null \
            | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
        # Fallback to OrbStack default if detection fails
        [[ -z "$host_gateway_ip" ]] && host_gateway_ip="192.168.194.1"
    else
        host_gateway_ip=$(hostname -I | awk '{print $1}')
    fi

    # Generate configmap from template - substitute all environment variables
    sed -e "s|\${LIVEKIT_URL}|${LIVEKIT_URL:-}|g" \
        -e "s|\${PUBLIC_LIVEKIT_URL}|${PUBLIC_LIVEKIT_URL:-}|g" \
        -e "s|\${VITE_LIVEKIT_URL}|${VITE_LIVEKIT_URL:-}|g" \
        -e "s|\${NODE_ENV}|${NODE_ENV:-local}|g" \
        -e "s|\${PUBLIC_API_URL}|${PUBLIC_API_URL:-}|g" \
        -e "s|\${CORS_ORIGIN}|${CORS_ORIGIN:-}|g" \
        -e "s|\${PUBLIC_FRONTEND_URL}|${PUBLIC_FRONTEND_URL:-}|g" \
        -e "s|\${PUBLIC_DB_HOST}|${PUBLIC_DB_HOST:-}|g" \
        -e "s|\${PUBLIC_DB_PORT}|${PUBLIC_DB_PORT:-}|g" \
        -e "s|\${STT_PROVIDER}|${STT_PROVIDER:-sherpa}|g" \
        -e "s|\${TTS_PROVIDER}|${TTS_PROVIDER:-piper}|g" \
        -e "s|\${WHISPER_MODEL}|${WHISPER_MODEL:-base.en}|g" \
        -e "s|\${WHISPER_DEVICE}|${WHISPER_DEVICE:-cpu}|g" \
        -e "s|\${WHISPER_COMPUTE_TYPE}|${WHISPER_COMPUTE_TYPE:-int8}|g" \
        -e "s|\${WHISPER_BEAM_SIZE}|${WHISPER_BEAM_SIZE:-5}|g" \
        -e "s|\${WHISPER_LANGUAGE}|${WHISPER_LANGUAGE:-}|g" \
        -e "s|\${ONNX_PROVIDER}|${ONNX_PROVIDER:-CPUExecutionProvider}|g" \
        -e "s|\${ENABLE_GPU}|${ENABLE_GPU:-false}|g" \
        -e "s|\${VAD_THRESHOLD}|${VAD_THRESHOLD:-0.5}|g" \
        -e "s|\${VAD_SILENCE_DURATION_MS}|${VAD_SILENCE_DURATION_MS:-800}|g" \
        -e "s|\${VAD_CONTINUATION_WINDOW_MS}|${VAD_CONTINUATION_WINDOW_MS:-1000}|g" \
        -e "s|\${VAD_MAX_ENDPOINTING_DELAY_MS}|${VAD_MAX_ENDPOINTING_DELAY_MS:-2000}|g" \
        -e "s|\${VAD_MIN_SPEECH_MS}|${VAD_MIN_SPEECH_MS:-500}|g" \
        -e "s|\${VAD_MAX_SPEECH_DURATION_MS}|${VAD_MAX_SPEECH_DURATION_MS:-30000}|g" \
        -e "s|\${VAD_AUDIO_INACTIVITY_TIMEOUT_MS}|${VAD_AUDIO_INACTIVITY_TIMEOUT_MS:-1500}|g" \
        -e "s|\${VAD_RMS_THRESHOLD}|${VAD_RMS_THRESHOLD:-0.008}|g" \
        -e "s|\${PARTIAL_INTERVAL_MS}|${PARTIAL_INTERVAL_MS:-1000}|g" \
        -e "s|\${BARGE_IN_MIN_SPEECH_MS}|${BARGE_IN_MIN_SPEECH_MS:-600}|g" \
        -e "s|\${STT_DECODE_DIAGNOSTICS}|${STT_DECODE_DIAGNOSTICS:-0}|g" \
        -e "s|\${DISABLE_AEC}|${DISABLE_AEC:-false}|g" \
        -e "s|\${WHISPER_INITIAL_PROMPT}|${WHISPER_INITIAL_PROMPT:-}|g" \
        -e "s|\${LIVEKIT_TURN_ENABLED}|${LIVEKIT_TURN_ENABLED:-false}|g" \
        -e "s|\${LIVEKIT_TURN_DOMAIN}|${LIVEKIT_TURN_DOMAIN:-localhost}|g" \
        -e "s|\${ELEVENLABS_VOICE_ID}|${ELEVENLABS_VOICE_ID:-}|g" \
        -e "s|\${ELEVENLABS_MODEL_ID}|${ELEVENLABS_MODEL_ID:-}|g" \
        -e "s|\${QWEN3_MODEL_ID}|${QWEN3_MODEL_ID:-Qwen/Qwen3-TTS-12Hz-0.6B-Base}|g" \
        -e "s|\${QWEN3_REF_AUDIO}|${QWEN3_REF_AUDIO:-/models/qwen3/ref_audio.mp3}|g" \
        -e "s|\${QWEN3_LANGUAGE}|${QWEN3_LANGUAGE:-Auto}|g" \
        -e "s|\${QWEN3_CHUNK_SIZE}|${QWEN3_CHUNK_SIZE:-2}|g" \
        -e "s|\${QWEN3_DTYPE}|${QWEN3_DTYPE:-bfloat16}|g" \
        -e "s|\${CUSTOM_DNS_SERVERS}|${CUSTOM_DNS_SERVERS:-}|g" \
        -e "s|\${KUBERNETES_DNS_IP}|${KUBERNETES_DNS_IP:-}|g" \
        -e "s|namespace: ai-agents|namespace: ${KUBERNETES_NAMESPACE}|g" \
        -e "s|KUBERNETES_NAMESPACE: \"ai-agents\"|KUBERNETES_NAMESPACE: \"${KUBERNETES_NAMESPACE}\"|g" \
        -e "s|:latest|:${IMAGE_TAG}|g" \
        k8s/04-configmap.yaml > "$output_file"

    # Every ${PLACEHOLDER} in the template must have had a rule above. One that
    # does not survives into the live ConfigMap as its own literal text, and the
    # services then parse that: BARGE_IN_MIN_SPEECH_MS reached stt-service as
    # the string "${BARGE_IN_MIN_SPEECH_MS}", int() raised, and STT crashlooped
    # through a deploy that otherwise reported success. It had been missing a
    # rule since the key was added; nothing noticed until the ConfigMap was next
    # regenerated. Fail here instead — a missed rule is a deploy bug, not
    # something to hand to a running cluster.
    local leftover
    leftover=$(grep -oE '\$\{[A-Z0-9_]+[^}]*\}' "$output_file" | sort -u || true)
    if [[ -n "$leftover" ]]; then
        error "ConfigMap has unsubstituted placeholders — add a sed rule in generate_configmap():"
        echo "$leftover" | sed 's/^/    /'
        return 1
    fi

    # Generate message-recorder manifest with host gateway
    sed -e "s/192.168.194.1/${host_gateway_ip}/g" \
        -e "s|namespace: ai-agents|namespace: ${KUBERNETES_NAMESPACE}|g" \
        -e "s|:latest|:${IMAGE_TAG}|g" \
        k8s/06-message-recorder.yaml > "${TEMP_DIR}/06-message-recorder-updated.yaml"

    # Detect ConfigMap changes by comparing generated file to last deployed version
    local configmap_checksum_file="${CHECKSUM_DIR}/configmap.sha"
    local new_configmap_hash
    new_configmap_hash=$(shasum "$output_file" 2>/dev/null | cut -d' ' -f1 || echo "unknown")

    local prev_configmap_hash=""
    [[ -f "$configmap_checksum_file" ]] && prev_configmap_hash=$(cat "$configmap_checksum_file" 2>/dev/null || echo "")

    if [[ "$new_configmap_hash" != "$prev_configmap_hash" ]]; then
        export CONFIGMAP_CHANGED="true"
        verbose "ConfigMap changed - services will be restarted"
    else
        export CONFIGMAP_CHANGED="false"
        verbose "ConfigMap unchanged"
    fi

    # Save new checksum (after apply succeeds, but generate it now)
    export CONFIGMAP_CHECKSUM_FILE="$configmap_checksum_file"
    export CONFIGMAP_NEW_HASH="$new_configmap_hash"

    verbose "ConfigMap generated with host gateway: $host_gateway_ip"
}

# =============================================================================
# Session Management Server Manifest
# =============================================================================

generate_session_server_manifest() {
    local output_file="${TEMP_DIR}/06-session-management-server-updated.yaml"

    if [[ "$DRY_RUN_MODE" == "true" ]]; then
        verbose "Would generate session-server manifest [dry-run]"
        return 0
    fi

    # Replace placeholder with actual project directory path
    # This makes it work regardless of where the project is cloned
    sed -e "s|__PROJECT_DIR_PLACEHOLDER__|${PROJECT_DIR}|g" \
        -e "s|namespace: ai-agents|namespace: ${KUBERNETES_NAMESPACE}|g" \
        -e "s|:latest|:${IMAGE_TAG}|g" \
        k8s/06-session-management-server.yaml > "$output_file"

    # K3s volume mounts: enabled on Linux (K3s runtime), removed on macOS (OrbStack/Docker Desktop)
    if [[ "$OS_TYPE" == "linux" ]]; then
        sed -i 's|# K3S: ||g' "$output_file"
        verbose "K3s volume mounts enabled (Linux)"
    else
        if [[ "$OS_TYPE" == "macos" ]]; then
            sed -i '' '/# K3S:/d' "$output_file"
        else
            sed -i '/# K3S:/d' "$output_file"
        fi
        verbose "K3s volume mounts skipped (macOS)"
    fi

    verbose "Project directory mounted: ${PROJECT_DIR}"
}

# =============================================================================
# Apply Custom DNS to All Service Manifests
# =============================================================================
# Applies custom DNS configuration to bypass SSL inspection proxies.
# This is needed when corporate proxies intercept HTTPS traffic to external APIs.

apply_dns_to_all_manifests() {
    if [[ -z "${CUSTOM_DNS_SERVERS:-}" ]]; then
        return 0
    fi

    if [[ "$DRY_RUN_MODE" == "true" ]]; then
        verbose "Would apply custom DNS config [dry-run]"
        return 0
    fi

    verbose "Applying custom DNS to all services: $CUSTOM_DNS_SERVERS"

    # Copy frontend-ui manifest to temp dir for modification (with namespace/image substitution)
    sed -e "s|namespace: ai-agents|namespace: ${KUBERNETES_NAMESPACE}|g" \
        -e "s|:latest|:${IMAGE_TAG}|g" \
        k8s/07-frontend-ui.yaml > "${TEMP_DIR}/07-frontend-ui-updated.yaml"

    # List of all manifests that need DNS config (services that make external API calls)
    local manifests=(
        "${TEMP_DIR}/06-session-management-server-updated.yaml"
        "${TEMP_DIR}/07-frontend-ui-updated.yaml"
        "${TEMP_DIR}/06-message-recorder-updated.yaml"
        "${TEMP_DIR}/08-stt-service.yaml"
        "${TEMP_DIR}/09-tts-service.yaml"
    )

    for manifest in "${manifests[@]}"; do
        if [[ -f "$manifest" ]]; then
            add_dns_config_to_manifest "$manifest"
            verbose "DNS config added to: $(basename "$manifest")"
        fi
    done

    # Export the updated frontend manifest path
    export FRONTEND_MANIFEST="${TEMP_DIR}/07-frontend-ui-updated.yaml"
}

# =============================================================================
# GPU Manifest Generation
# =============================================================================

generate_gpu_manifests() {
    # Start with base manifests (with namespace/image substitution)
    sed -e "s|namespace: ai-agents|namespace: ${KUBERNETES_NAMESPACE}|g" \
        -e "s|:latest|:${IMAGE_TAG}|g" \
        k8s/08-stt-service.yaml > "${TEMP_DIR}/08-stt-service.yaml"
    sed -e "s|namespace: ai-agents|namespace: ${KUBERNETES_NAMESPACE}|g" \
        -e "s|:latest|:${IMAGE_TAG}|g" \
        k8s/09-tts-service.yaml > "${TEMP_DIR}/09-tts-service.yaml"

    # Enable GPU runtime class if requested
    # NOTE: We only enable runtimeClassName (for CUDA access), NOT nvidia.com/gpu resource requests
    # This allows multiple services (STT + TTS) to share a single GPU via CUDA
    # If nvidia.com/gpu: 1 is requested, Kubernetes reserves the GPU exclusively for that pod
    if [[ "$ENABLE_GPU" == "true" ]]; then
        verbose "Enabling GPU runtime class (shared GPU mode)..."
        # Enable runtimeClassName: nvidia on STT, TTS, and session-management-server
        # Also enable NVIDIA_VISIBLE_DEVICES on session-management-server (node:20-slim
        # doesn't set it like the nvidia/cuda base images do, so nvidia runtime won't
        # inject nvidia-smi without it)
        # NOTE: We do NOT uncomment nvidia.com/gpu resource requests — that would
        # reserve GPUs exclusively and prevent sharing between pods
        local sms_manifest="${TEMP_DIR}/06-session-management-server-updated.yaml"
        if [[ "$OS_TYPE" == "macos" ]]; then
            sed -i '' 's/# GPU: runtimeClassName: nvidia/runtimeClassName: nvidia/' \
                "${TEMP_DIR}/08-stt-service.yaml"
            sed -i '' 's/# GPU: runtimeClassName: nvidia/runtimeClassName: nvidia/' \
                "${TEMP_DIR}/09-tts-service.yaml"
            sed -i '' 's/# GPU: runtimeClassName: nvidia/runtimeClassName: nvidia/' \
                "$sms_manifest"
            # Enable NVIDIA_VISIBLE_DEVICES env var for GPU monitoring
            sed -i '' '/# GPU: - name: NVIDIA_VISIBLE_DEVICES/{s/# GPU: //;}' "$sms_manifest"
            sed -i '' '/# GPU:   value: "all"/{s/# GPU: //;}' "$sms_manifest"
        else
            sed -i 's/# GPU: runtimeClassName: nvidia/runtimeClassName: nvidia/' \
                "${TEMP_DIR}/08-stt-service.yaml"
            sed -i 's/# GPU: runtimeClassName: nvidia/runtimeClassName: nvidia/' \
                "${TEMP_DIR}/09-tts-service.yaml"
            sed -i 's/# GPU: runtimeClassName: nvidia/runtimeClassName: nvidia/' \
                "$sms_manifest"
            # Enable NVIDIA_VISIBLE_DEVICES env var for GPU monitoring
            sed -i '/# GPU: - name: NVIDIA_VISIBLE_DEVICES/{s/# GPU: //;}' "$sms_manifest"
            sed -i '/# GPU:   value: "all"/{s/# GPU: //;}' "$sms_manifest"
        fi
        verbose "GPU manifests: runtimeClassName=nvidia + NVIDIA_VISIBLE_DEVICES=all (shared GPU mode)"
    fi

    # Enable Qwen3-TTS provider manifest lines when TTS_PROVIDER=qwen3.
    # Strips the `# QWEN3: ` marker prefix (uncommenting the block) and
    # deletes `# QWEN3_DISABLE: ` lines (which hold the lower-resource
    # defaults used by every other provider). Mirrors the `# GPU: ` pattern.
    if [[ "${TTS_PROVIDER:-}" == "qwen3" ]]; then
        verbose "Enabling Qwen3-TTS manifest lines (mount, env, resources, probes)"
        if [[ "$OS_TYPE" == "macos" ]]; then
            sed -i '' 's|# QWEN3: ||g' "${TEMP_DIR}/09-tts-service.yaml"
            sed -i '' '/# QWEN3_DISABLE: /d' "${TEMP_DIR}/09-tts-service.yaml"
        else
            sed -i 's|# QWEN3: ||g' "${TEMP_DIR}/09-tts-service.yaml"
            sed -i '/# QWEN3_DISABLE: /d' "${TEMP_DIR}/09-tts-service.yaml"
        fi
    else
        # Non-Qwen3 providers: drop the QWEN3: lines, keep the DISABLE defaults.
        if [[ "$OS_TYPE" == "macos" ]]; then
            sed -i '' '/# QWEN3: /d' "${TEMP_DIR}/09-tts-service.yaml"
            sed -i '' 's|# QWEN3_DISABLE: ||g' "${TEMP_DIR}/09-tts-service.yaml"
        else
            sed -i '/# QWEN3: /d' "${TEMP_DIR}/09-tts-service.yaml"
            sed -i 's|# QWEN3_DISABLE: ||g' "${TEMP_DIR}/09-tts-service.yaml"
        fi
    fi

    # NOTE: Custom DNS is now applied globally via apply_dns_to_all_manifests()

    export STT_MANIFEST="${TEMP_DIR}/08-stt-service.yaml"
    export TTS_MANIFEST="${TEMP_DIR}/09-tts-service.yaml"
}

# =============================================================================
# DNS Configuration for Manifests
# =============================================================================
# Adds custom DNS configuration to bypass SSL inspection proxies while
# maintaining ability to resolve internal Kubernetes services.
#
# Uses dnsPolicy: None with:
# - Kubernetes CoreDNS as first nameserver (for internal service resolution)
# - Custom external DNS as second nameserver (for bypassing SSL proxy)
# - K8s search domains (for short service name resolution like "postgres")

add_dns_config_to_manifest() {
    local manifest_file="$1"

    # Get Kubernetes DNS IP (auto-detected or from env)
    local k8s_dns_ip="${KUBERNETES_DNS_IP:-}"
    if [[ -z "$k8s_dns_ip" ]]; then
        k8s_dns_ip=$(kubectl get svc -n kube-system kube-dns -o jsonpath='{.spec.clusterIP}' 2>/dev/null || echo "10.43.0.10")
    fi

    # Build nameservers YAML: K8s DNS first (for internal), then external DNS (for external)
    local dns_yaml=""
    dns_yaml="${dns_yaml}        - \"${k8s_dns_ip}\"\n"
    for server in $CUSTOM_DNS_SERVERS; do
        dns_yaml="${dns_yaml}        - \"${server}\"\n"
    done

    # Find the line with "initContainers:" or "containers:" (first occurrence after spec:)
    # and insert dnsPolicy and dnsConfig before it
    awk -v dns_servers="$dns_yaml" '
    /^[[:space:]]*initContainers:/ && !dns_added {
        match($0, /^[[:space:]]*/)
        indent = substr($0, RSTART, RLENGTH)
        print indent "dnsPolicy: None"
        print indent "dnsConfig:"
        print indent "  nameservers:"
        printf "%s", dns_servers
        print indent "  searches:"
        print indent "    - \"'${KUBERNETES_NAMESPACE}'.svc.cluster.local\""
        print indent "    - \"svc.cluster.local\""
        print indent "    - \"cluster.local\""
        dns_added = 1
    }
    { print }
    ' "$manifest_file" > "${manifest_file}.tmp" && mv "${manifest_file}.tmp" "$manifest_file"
}

# =============================================================================
# Secrets Management
# =============================================================================

create_secrets() {
    if [[ "$DRY_RUN_MODE" == "true" ]]; then
        echo -e "   ${ARROW} Secrets... ${YELLOW}[dry-run]${NC}"
        return 0
    fi

    local db_url="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public"

    kubectl create secret generic stella-ai-secrets -n "$KUBERNETES_NAMESPACE" \
        --from-literal=postgres-db="$POSTGRES_DB" \
        --from-literal=postgres-user="$POSTGRES_USER" \
        --from-literal=postgres-password="$POSTGRES_PASSWORD" \
        --from-literal=database-url="$db_url" \
        --from-literal=openai-api-key="$OPENAI_API_KEY" \
        --from-literal=openai-plan-generator-api-key="${OPENAI_PLAN_GENERATOR_API_KEY:-$OPENAI_API_KEY}" \
        --from-literal=jwt-secret="${JWT_SECRET:-$(openssl rand -base64 32)}" \
        --from-literal=livekit-api-key="$LIVEKIT_API_KEY" \
        --from-literal=livekit-api-secret="$LIVEKIT_API_SECRET" \
        --from-literal=livekit-webhook-secret="${LIVEKIT_WEBHOOK_SECRET:-webhook-secret}" \
        --from-literal=elevenlabs-api-key="${ELEVENLABS_API_KEY:-}" \
        --from-literal=huggingface-token="${HF_TOKEN:-}" \
        --from-literal=env-var-encryption-key="${ENV_VAR_ENCRYPTION_KEY:-}" \
        --dry-run=client -o yaml | kubectl apply -f - >/dev/null

    verbose "Secrets created"
}

# =============================================================================
# Database Migrations
# =============================================================================
# Runs Prisma migrations against the PostgreSQL database with intelligent
# error handling, auto-recovery, and detailed diagnostics.
#
# Features:
# - Checks migration status before applying
# - Auto-recovery from common issues (type/table already exists, failed migrations)
# - Detailed error diagnosis with specific remediation steps
# - Fails fast on unrecoverable errors
# =============================================================================

# Global for cleanup
PG_FORWARD_PID=""
PG_LOCAL_PORT="${PG_LOCAL_PORT:-5433}"
MIGRATION_DB_URL=""

cleanup_port_forward() {
    if [[ -n "$PG_FORWARD_PID" ]]; then
        kill $PG_FORWARD_PID 2>/dev/null || true
        wait $PG_FORWARD_PID 2>/dev/null || true
        PG_FORWARD_PID=""
    fi
}

setup_port_forward() {
    local pf_error_file="/tmp/stella-pf-error-$$.log"

    # Check if port is already in use
    if nc -z localhost ${PG_LOCAL_PORT} 2>/dev/null; then
        verbose "Port ${PG_LOCAL_PORT} already in use, attempting cleanup..."
        pkill -f "kubectl port-forward.*${PG_LOCAL_PORT}" 2>/dev/null || true
        sleep 1

        if nc -z localhost ${PG_LOCAL_PORT} 2>/dev/null; then
            error "Port ${PG_LOCAL_PORT} is already in use"
            echo "  Check what's using it: sudo lsof -i :${PG_LOCAL_PORT}"
            return 1
        fi
    fi

    # Start port-forward to PostgreSQL in background (suppress all output)
    kubectl port-forward svc/postgres ${PG_LOCAL_PORT}:5432 -n "$KUBERNETES_NAMESPACE" >/dev/null 2>"$pf_error_file" &
    PG_FORWARD_PID=$!

    # Wait for port-forward to be ready
    local max_wait=30
    local waited=0
    while ! nc -z localhost ${PG_LOCAL_PORT} 2>/dev/null; do
        sleep 1
        waited=$((waited + 1))

        if ! kill -0 $PG_FORWARD_PID 2>/dev/null; then
            error "PostgreSQL port-forward failed to start"
            [[ -f "$pf_error_file" ]] && echo "  Error: $(cat "$pf_error_file")"
            rm -f "$pf_error_file"
            return 1
        fi

        if [[ $waited -ge $max_wait ]]; then
            cleanup_port_forward
            error "Timeout waiting for PostgreSQL port-forward (${max_wait}s)"
            echo "  Check PostgreSQL pod: kubectl get pods -n $KUBERNETES_NAMESPACE -l app=postgres"
            rm -f "$pf_error_file"
            return 1
        fi
    done
    rm -f "$pf_error_file"
    return 0
}

# =============================================================================
# Migration Diagnostics - Analyze errors and provide specific guidance
# =============================================================================

diagnose_migration_error() {
    local output="$1"
    local failed_migration="$2"

    echo ""
    echo -e "${BOLD}┌─────────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${BOLD}│  📋 MIGRATION DIAGNOSTIC REPORT                                 │${NC}"
    echo -e "${BOLD}└─────────────────────────────────────────────────────────────────┘${NC}"
    echo ""

    # Detect specific error types and provide targeted guidance
    local error_type="unknown"
    local auto_fixable=false

    # P3018: A migration failed to apply
    if echo "$output" | grep -q "P3018"; then
        echo -e "  ${BOLD}Error Type:${NC} P3018 - Migration failed to apply"
        echo ""

        # Sub-categorize the P3018 error
        if echo "$output" | grep -qE "42710|type.*already exists"; then
            error_type="type_exists"
            auto_fixable=true
            echo -e "  ${BOLD}Cause:${NC} A database TYPE (enum) already exists"
            echo -e "  ${BOLD}Why:${NC} The migration tried to create a type that's already in the database."
            echo "        This usually happens when:"
            echo "        - A previous migration partially succeeded"
            echo "        - The schema was modified manually"
            echo "        - The migration was interrupted"

        elif echo "$output" | grep -qE "42P07|relation.*already exists|table.*already exists"; then
            error_type="relation_exists"
            auto_fixable=true
            echo -e "  ${BOLD}Cause:${NC} A database TABLE or INDEX already exists"
            echo -e "  ${BOLD}Why:${NC} The table/index was created but the migration wasn't recorded."

        elif echo "$output" | grep -qE "42703|column.*does not exist"; then
            error_type="column_missing"
            echo -e "  ${BOLD}Cause:${NC} A required COLUMN doesn't exist"
            echo -e "  ${BOLD}Why:${NC} The migration expects a column that was never created or was dropped."

        elif echo "$output" | grep -qE "23505|duplicate key|unique.*violation"; then
            error_type="duplicate_key"
            echo -e "  ${BOLD}Cause:${NC} Duplicate key violation"
            echo -e "  ${BOLD}Why:${NC} The migration tried to insert data that violates a unique constraint."

        elif echo "$output" | grep -qE "42P01|relation.*does not exist|table.*does not exist"; then
            error_type="relation_missing"
            echo -e "  ${BOLD}Cause:${NC} A required TABLE doesn't exist"
            echo -e "  ${BOLD}Why:${NC} The migration references a table that was never created or was dropped."

        elif echo "$output" | grep -qE "foreign key|23503"; then
            error_type="fk_violation"
            echo -e "  ${BOLD}Cause:${NC} Foreign key constraint violation"
            echo -e "  ${BOLD}Why:${NC} The migration violates referential integrity."
        fi
    fi

    # P3009: Found failed migrations
    if echo "$output" | grep -q "P3009"; then
        error_type="failed_migrations"
        echo -e "  ${BOLD}Error Type:${NC} P3009 - Failed migrations found"
        echo -e "  ${BOLD}Cause:${NC} Previous migration(s) failed and were not resolved"
        echo -e "  ${BOLD}Why:${NC} Prisma won't apply new migrations until failed ones are resolved."
    fi

    # P3006: Migration history not in sync
    if echo "$output" | grep -q "P3006"; then
        error_type="history_mismatch"
        echo -e "  ${BOLD}Error Type:${NC} P3006 - Migration history mismatch"
        echo -e "  ${BOLD}Cause:${NC} Database schema doesn't match migration history"
        echo -e "  ${BOLD}Why:${NC} Schema was modified outside of Prisma migrations."
    fi

    echo ""
    echo -e "${BOLD}┌─────────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${BOLD}│  🔧 RECOMMENDED SOLUTIONS                                       │${NC}"
    echo -e "${BOLD}└─────────────────────────────────────────────────────────────────┘${NC}"
    echo ""

    # Provide specific solutions based on error type
    case "$error_type" in
        "type_exists"|"relation_exists")
            echo -e "  ${GREEN}Option 1 (Recommended):${NC} Mark migration as already applied"
            echo "  The schema already exists, so we just need to record it in the migration history."
            echo ""
            echo "    kubectl port-forward svc/postgres ${PG_LOCAL_PORT}:5432 -n $KUBERNETES_NAMESPACE &"
            echo "    cd $PROJECT_DIR"
            echo "    DATABASE_URL=\"postgresql://\${POSTGRES_USER}:\${POSTGRES_PASSWORD}@localhost:5433/\${POSTGRES_DB}\" \\"
            echo "      npx prisma migrate resolve --applied ${failed_migration}"
            echo "    pkill -f 'port-forward.*${PG_LOCAL_PORT}'"
            echo ""
            echo -e "  ${YELLOW}Option 2:${NC} Drop the existing object and re-run migration"
            echo "  Use this if the existing schema is incorrect/outdated."
            echo ""
            if [[ "$error_type" == "type_exists" ]]; then
                local type_name
                type_name=$(echo "$output" | grep -oP 'type "\K[^"]+' | head -1)
                echo "    # Connect to database and drop the type"
                echo "    kubectl port-forward svc/postgres ${PG_LOCAL_PORT}:5432 -n $KUBERNETES_NAMESPACE &"
                echo "    PGPASSWORD=\${POSTGRES_PASSWORD} psql -h localhost -p ${PG_LOCAL_PORT} -U \${POSTGRES_USER} -d \${POSTGRES_DB} \\"
                echo "      -c 'DROP TYPE IF EXISTS \"${type_name:-TypeName}\" CASCADE;'"
            else
                echo "    # Connect to database and drop the table/index"
                echo "    kubectl port-forward svc/postgres ${PG_LOCAL_PORT}:5432 -n $KUBERNETES_NAMESPACE &"
                echo "    PGPASSWORD=\${POSTGRES_PASSWORD} psql -h localhost -p ${PG_LOCAL_PORT} -U \${POSTGRES_USER} -d \${POSTGRES_DB}"
                echo "    # Then: DROP TABLE IF EXISTS \"table_name\" CASCADE;"
            fi
            ;;

        "failed_migrations")
            echo -e "  ${GREEN}Option 1:${NC} Resolve the failed migration as applied (if schema exists)"
            echo ""
            echo "    kubectl port-forward svc/postgres ${PG_LOCAL_PORT}:5432 -n $KUBERNETES_NAMESPACE &"
            echo "    cd $PROJECT_DIR"
            echo "    DATABASE_URL=\"postgresql://\${POSTGRES_USER}:\${POSTGRES_PASSWORD}@localhost:5433/\${POSTGRES_DB}\" \\"
            echo "      npx prisma migrate resolve --applied ${failed_migration}"
            echo ""
            echo -e "  ${YELLOW}Option 2:${NC} Mark the failed migration as rolled back"
            echo ""
            echo "    DATABASE_URL=\"...\" npx prisma migrate resolve --rolled-back ${failed_migration}"
            ;;

        "column_missing"|"relation_missing")
            echo -e "  ${YELLOW}This requires manual database repair:${NC}"
            echo ""
            echo "  1. Check what's missing in the database:"
            echo "     kubectl port-forward svc/postgres ${PG_LOCAL_PORT}:5432 -n $KUBERNETES_NAMESPACE &"
            echo "     PGPASSWORD=\${POSTGRES_PASSWORD} psql -h localhost -p ${PG_LOCAL_PORT} -U \${POSTGRES_USER} -d \${POSTGRES_DB}"
            echo "     \\dt   -- list tables"
            echo "     \\d table_name  -- describe table"
            echo ""
            echo "  2. Either manually create the missing object, or reset migrations:"
            echo "     DATABASE_URL=\"...\" npx prisma migrate reset --force  # WARNING: Loses data!"
            ;;

        "history_mismatch")
            echo -e "  ${GREEN}Option 1:${NC} Baseline the current schema"
            echo ""
            echo "    cd $PROJECT_DIR"
            echo "    DATABASE_URL=\"...\" npx prisma db pull  # Introspect current schema"
            echo "    # Review changes in schema.prisma, then:"
            echo "    DATABASE_URL=\"...\" npx prisma migrate dev --name baseline"
            echo ""
            echo -e "  ${RED}Option 2:${NC} Reset and start fresh (loses all data)"
            echo ""
            echo "    DATABASE_URL=\"...\" npx prisma migrate reset --force"
            ;;

        *)
            echo -e "  ${YELLOW}General troubleshooting steps:${NC}"
            echo ""
            echo "  1. Check migration status:"
            echo "     kubectl port-forward svc/postgres ${PG_LOCAL_PORT}:5432 -n $KUBERNETES_NAMESPACE &"
            echo "     cd $PROJECT_DIR"
            echo "     DATABASE_URL=\"...\" npx prisma migrate status"
            echo ""
            echo "  2. View migration history in database:"
            echo "     PGPASSWORD=\${POSTGRES_PASSWORD} psql -h localhost -p ${PG_LOCAL_PORT} -U \${POSTGRES_USER} -d \${POSTGRES_DB} \\"
            echo "       -c 'SELECT * FROM _prisma_migrations ORDER BY started_at DESC LIMIT 10;'"
            echo ""
            echo "  3. If stuck, you can mark migrations as resolved:"
            echo "     DATABASE_URL=\"...\" npx prisma migrate resolve --applied ${failed_migration:-MIGRATION_NAME}"
            ;;
    esac

    echo ""
    echo -e "${BOLD}┌─────────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${BOLD}│  ⚠️  NUCLEAR OPTIONS (Use with caution)                         │${NC}"
    echo -e "${BOLD}└─────────────────────────────────────────────────────────────────┘${NC}"
    echo ""
    echo -e "  ${RED}Reset database entirely (DESTROYS ALL DATA):${NC}"
    echo "    DATABASE_URL=\"...\" npx prisma migrate reset --force"
    echo ""
    echo -e "  ${RED}Delete migration history (keeps data, re-applies all migrations):${NC}"
    echo "    PGPASSWORD=\${POSTGRES_PASSWORD} psql ... -c 'DROP TABLE IF EXISTS _prisma_migrations;'"
    echo "    DATABASE_URL=\"...\" npx prisma migrate deploy"
    echo ""

    return 0
}

# =============================================================================
# Check Migration Status - Detect issues before running migrations
# =============================================================================

check_migration_status() {
    local db_url="$1"

    verbose "Checking migration status..."

    set +e
    local status_output
    status_output=$(DATABASE_URL="$db_url" npx prisma migrate status 2>&1)
    local status_code=$?
    set -e

    # Check for failed migrations
    if echo "$status_output" | grep -qE "failed|Following migration.*failed"; then
        local failed_migration
        failed_migration=$(echo "$status_output" | grep -oP "^\d+_[a-zA-Z_]+" | head -1)

        echo -e "   ${ARROW} ${YELLOW}⚠${NC}  Found failed migration: ${failed_migration:-unknown}"

        # Check if this is an "already exists" type failure that we can auto-resolve
        if echo "$status_output" | grep -qE "already exists|42710|42P07"; then
            echo -e "   ${ARROW} ${CYAN}→${NC}  Attempting auto-resolution..."
            return 1  # Signal that we should try auto-recovery
        fi

        return 2  # Signal that manual intervention is needed
    fi

    # Check for pending migrations
    if echo "$status_output" | grep -q "Following migration.*have not yet been applied"; then
        local pending_count
        pending_count=$(echo "$status_output" | grep -c "^\d" 2>/dev/null)
        pending_count="${pending_count:-some}"
        verbose "Found $pending_count pending migration(s)"
    fi

    return 0
}

# =============================================================================
# Attempt Auto-Fix for Known Issues
# =============================================================================

attempt_auto_fix() {
    local db_url="$1"
    local output="$2"
    local failed_migration="$3"

    # Can we auto-fix "already exists" errors?
    if echo "$output" | grep -qE "already exists|42710|42P07"; then
        echo -e "   ${ARROW} ${CYAN}→${NC}  Schema exists in DB but migration not recorded"
        echo -e "   ${ARROW} ${CYAN}→${NC}  Marking migration as applied: ${failed_migration}"

        set +e
        local resolve_output
        resolve_output=$(DATABASE_URL="$db_url" npx prisma migrate resolve --applied "$failed_migration" 2>&1)
        local resolve_code=$?
        set -e

        if [[ $resolve_code -eq 0 ]]; then
            echo -e "   ${ARROW} ${GREEN}✓${NC}  Successfully resolved: ${failed_migration}"
            return 0
        else
            echo -e "   ${ARROW} ${RED}✗${NC}  Auto-resolution failed"
            verbose "$resolve_output"
            return 1
        fi
    fi

    return 1
}

# =============================================================================
# Main Migration Function
# =============================================================================

run_database_migrations() {
    if [[ "$DRY_RUN_MODE" == "true" ]]; then
        echo -e "   ${ARROW} Database migrations... ${YELLOW}[dry-run]${NC}"
        return 0
    fi

    echo -ne "   ${ARROW} Database migrations... "

    # ==========================================================================
    # Prerequisite checks - fail immediately with clear error messages
    # ==========================================================================

    if ! command -v nc &>/dev/null; then
        printf "\r   ${ARROW} Database migrations... ${RED}${CROSS}${NC}    \n"
        error "Missing required command: nc (netcat)"
        echo "  Install with: sudo apt install netcat-openbsd"
        exit 1
    fi

    if ! command -v npx &>/dev/null; then
        printf "\r   ${ARROW} Database migrations... ${RED}${CROSS}${NC}    \n"
        error "Missing required command: npx (Node.js)"
        echo "  Install Node.js and run: npm install"
        exit 1
    fi

    if [[ ! -d "$PROJECT_DIR/node_modules/prisma" ]]; then
        printf "\r   ${ARROW} Database migrations... ${RED}${CROSS}${NC}    \n"
        error "Prisma not installed. Run: cd $PROJECT_DIR && npm install"
        exit 1
    fi

    # ==========================================================================
    # Setup port-forward to PostgreSQL
    # ==========================================================================

    if ! setup_port_forward; then
        printf "\r   ${ARROW} Database migrations... ${RED}${CROSS}${NC}    \n"
        exit 1
    fi

    # ==========================================================================
    # Run Prisma migrations with auto-recovery
    # ==========================================================================

    MIGRATION_DB_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${PG_LOCAL_PORT}/${POSTGRES_DB}?schema=public"
    local migration_output=""
    local migration_exit_code=0
    local max_retries=5
    local retry_count=0

    if ! cd "$PROJECT_DIR" 2>/dev/null; then
        printf "\r   ${ARROW} Database migrations... ${RED}${CROSS}${NC}    \n"
        error "Cannot access project directory: $PROJECT_DIR"
        cleanup_port_forward
        exit 1
    fi

    local migration_log="/tmp/stella-migration-$$.log"
    local spinner_idx=0

    while [[ $retry_count -lt $max_retries ]]; do
        # Run migration in background with spinner
        (DATABASE_URL="$MIGRATION_DB_URL" npx prisma migrate deploy 2>&1) > "$migration_log" &
        local migration_pid=$!

        # Show spinner while migration runs
        while kill -0 $migration_pid 2>/dev/null; do
            local spinner="${SPINNER_CHARS[$spinner_idx]}"
            printf "\r   ${ARROW} Database migrations... ${CYAN}${spinner}${NC} "
            spinner_idx=$(( (spinner_idx + 1) % ${#SPINNER_CHARS[@]} ))
            sleep 0.1
        done

        wait $migration_pid
        migration_exit_code=$?
        migration_output=$(cat "$migration_log" 2>/dev/null)

        # Success - we're done
        if [[ $migration_exit_code -eq 0 ]]; then
            rm -f "$migration_log"
            cd - > /dev/null 2>&1 || true
            cleanup_port_forward
            printf "\r   ${ARROW} Database migrations... ${GREEN}${CHECK}${NC}    \n"

            # Show what was applied (protect grep from set -e)
            set +e
            local applied_count
            applied_count=$(echo "$migration_output" | grep -c "Applying migration" 2>/dev/null)
            applied_count="${applied_count:-0}"
            set -e

            if [[ "$VERBOSE_MODE" == "true" && "$applied_count" -gt 0 ]]; then
                verbose "Applied ${applied_count} migration(s)"
            fi

            return 0
        fi

        # =======================================================================
        # Migration failed - show output in verbose mode
        # =======================================================================
        if [[ "$VERBOSE_MODE" == "true" ]]; then
            echo ""
            echo "[DEBUG] Migration failed. Output:"
            echo "$migration_output" | tail -20
            echo ""
        fi

        # =======================================================================
        # Extract failed migration name (disable errexit for grep)
        # =======================================================================
        set +e
        local failed_migration
        failed_migration=$(echo "$migration_output" | grep -oP "Migration name: \K[0-9_a-zA-Z]+" 2>/dev/null | head -1)

        # =======================================================================
        # Auto-recovery attempt
        # =======================================================================

        if [[ -n "$failed_migration" ]]; then
            # Check if this is auto-recoverable
            if echo "$migration_output" | grep -qE "already exists|duplicate|42P07|42710|42P16" 2>/dev/null; then
                retry_count=$((retry_count + 1))
                printf "\r   ${ARROW} Database migrations... ${YELLOW}recovering${NC} ($retry_count/$max_retries)\n"

                if attempt_auto_fix "$MIGRATION_DB_URL" "$migration_output" "$failed_migration"; then
                    echo -ne "   ${ARROW} Database migrations... "
                    set -e
                    continue  # Retry migration
                fi
            fi

            # Check for "failed migration needs resolution" case (P3018)
            if echo "$migration_output" | grep -q "P3018" 2>/dev/null; then
                retry_count=$((retry_count + 1))
                printf "\r   ${ARROW} Database migrations... ${YELLOW}recovering${NC} ($retry_count/$max_retries)\n"

                # Try marking as applied if schema exists
                if attempt_auto_fix "$MIGRATION_DB_URL" "$migration_output" "$failed_migration"; then
                    echo -ne "   ${ARROW} Database migrations... "
                    set -e
                    continue
                fi
            fi
        fi
        set -e

        # =======================================================================
        # Could not auto-recover - break and show diagnostics
        # =======================================================================
        break
    done

    # ==========================================================================
    # Migration failed - show detailed diagnostics
    # ==========================================================================

    rm -f "$migration_log" 2>/dev/null
    cd - > /dev/null 2>&1 || true
    printf "\r   ${ARROW} Database migrations... ${RED}${CROSS}${NC}    \n"

    # Show the raw output first
    echo ""
    echo -e "${DIM}--- Raw Migration Output ---${NC}"
    echo "$migration_output" | tail -30
    echo -e "${DIM}----------------------------${NC}"

    # Run detailed diagnostics
    diagnose_migration_error "$migration_output" "$failed_migration"

    cleanup_port_forward
    exit 1
}

# =============================================================================
# Initial Admin Bootstrap
# =============================================================================

bootstrap_initial_admin() {
    local bootstrap_file="$PROJECT_DIR/.stella-initial-admin.${NODE_ENV}.json"
    local bootstrap_log="/tmp/stella-admin-bootstrap-$$.log"
    local bootstrap_db_url=""
    local synthesized_file=""
    local only_if_missing_flag=""
    local source_label="bootstrap file"

    # Two trigger paths:
    #   1) Operator-driven: a one-time bootstrap file exists (created by the
    #      wizard). Always create-or-update — operator intent is explicit.
    #   2) Recovery: file is gone (already consumed, or DB/PVC was wiped) but
    #      INITIAL_ADMIN_EMAIL/PASSWORD are present in the loaded env. Synthesize
    #      a temp bootstrap file and run in --only-if-missing mode so we never
    #      overwrite a password the operator may have changed via the UI.
    if [[ ! -f "$bootstrap_file" ]]; then
        if [[ -z "${INITIAL_ADMIN_EMAIL:-}" || -z "${INITIAL_ADMIN_PASSWORD:-}" ]]; then
            return 0
        fi
        synthesized_file="$(mktemp -t stella-initial-admin.XXXXXX.json)"
        chmod 600 "$synthesized_file" 2>/dev/null || true
        local email_b64 password_b64
        email_b64=$(printf '%s' "$INITIAL_ADMIN_EMAIL" | base64 | tr -d '\n')
        password_b64=$(printf '%s' "$INITIAL_ADMIN_PASSWORD" | base64 | tr -d '\n')
        printf '{"email_b64":"%s","password_b64":"%s"}\n' "$email_b64" "$password_b64" > "$synthesized_file"
        bootstrap_file="$synthesized_file"
        only_if_missing_flag="--only-if-missing"
        source_label="env recovery"
    fi

    echo -ne "   ${ARROW} Initial admin bootstrap (${source_label})... "

    if ! setup_port_forward; then
        printf "\r   ${ARROW} Initial admin bootstrap... ${RED}${CROSS}${NC}    \n"
        error "Failed to open PostgreSQL port-forward for admin bootstrap"
        if [[ -n "$synthesized_file" ]]; then
            rm -f "$synthesized_file"
        else
            echo "  Bootstrap file kept for retry: $bootstrap_file"
        fi
        return 1
    fi

    bootstrap_db_url="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${PG_LOCAL_PORT}/${POSTGRES_DB}?schema=public"

    if (cd "$PROJECT_DIR" && DATABASE_URL="$bootstrap_db_url" npx ts-node scripts/bootstrap-initial-admin.ts "$bootstrap_file" $only_if_missing_flag >"$bootstrap_log" 2>&1); then
        cleanup_port_forward
        if [[ -n "$synthesized_file" ]]; then
            rm -f "$synthesized_file"
        else
            rm -f "$bootstrap_file"
        fi
        rm -f "$bootstrap_log" 2>/dev/null || true
        printf "\r   ${ARROW} Initial admin bootstrap (${source_label})... ${GREEN}${CHECK}${NC}    \n"
        return 0
    fi

    cleanup_port_forward
    printf "\r   ${ARROW} Initial admin bootstrap (${source_label})... ${RED}${CROSS}${NC}    \n"
    error "Failed to create/update initial admin user"
    if [[ -f "$bootstrap_log" ]]; then
        echo "  Bootstrap error:"
        tail -n 5 "$bootstrap_log"
    fi
    if [[ -n "$synthesized_file" ]]; then
        rm -f "$synthesized_file"
    else
        echo "  Bootstrap file kept for retry: $bootstrap_file"
    fi
    return 1
}

# =============================================================================
# Main Deployment Function
# =============================================================================

deploy_services() {
    info "${EMOJI_DEPLOY} Deploying to Kubernetes..."

    # Generate manifests
    generate_configmap
    generate_session_server_manifest
    generate_gpu_manifests

    # Apply custom DNS to all manifests (for bypassing SSL inspection proxies)
    apply_dns_to_all_manifests

    if [[ "$DRY_RUN_MODE" == "true" ]]; then
        show_dry_run_deployment
        return 0
    fi

    # Helper function for spinner on kubectl commands
    apply_with_spinner() {
        local label="$1"
        shift
        local cmd=("$@")

        echo -ne "   ${ARROW} ${label}... "

        # Run command in background, capture output to temp file
        local cmd_log="${LOG_DIR:-/tmp}/apply-${label// /-}.log"
        "${cmd[@]}" >"$cmd_log" 2>&1 &
        local pid=$!

        # Spinner animation
        local spinner_idx=0
        while kill -0 $pid 2>/dev/null; do
            local spinner="${SPINNER_CHARS[$spinner_idx]}"
            printf "\r   ${ARROW} ${label}... ${CYAN}${spinner}${NC} "
            spinner_idx=$(( (spinner_idx + 1) % ${#SPINNER_CHARS[@]} ))
            sleep 0.1
        done

        # Disable errexit so we can capture the exit code and report errors
        set +e
        wait $pid
        local exit_code=$?
        set -e

        if [[ $exit_code -eq 0 ]]; then
            printf "\r   ${ARROW} ${label}... ${GREEN}${CHECK}${NC}    \n"
            rm -f "$cmd_log" 2>/dev/null
            return 0
        else
            printf "\r   ${ARROW} ${label}... ${RED}${CROSS}${NC}    \n"
            error "${label} failed (exit code: $exit_code)"
            if [[ -f "$cmd_log" && -s "$cmd_log" ]]; then
                echo -e "   ${DIM}Command output:${NC}"
                cat "$cmd_log" | while read -r line; do
                    echo "     $line"
                done
            fi
            rm -f "$cmd_log" 2>/dev/null
            return 1
        fi
    }

    # Apply model PVCs with targeted guardrails for storage resize restrictions.
    apply_model_storage_pvcs() {
        local namespace="$KUBERNETES_NAMESPACE"
        local stt_manifest="k8s/02-stt-models-pvc.yaml"
        local tts_manifest="k8s/02-tts-models-pvc.yaml"

        # Print actionable guidance specifically for storage expansion policy failures.
        print_pvc_resize_remediation() {
            echo ""
            warning "Detected PVC resize restriction from cluster storage policy."
            echo "  This usually happens when StorageClass does not support expansion"
            echo "  or the PVC is not dynamically provisioned."
            echo ""
            echo "  Check current PVC and StorageClass:"
            echo "    kubectl get pvc -n ${namespace} stt-models-pvc tts-models-pvc"
            echo "    kubectl get pvc -n ${namespace} tts-models-pvc -o jsonpath='{.spec.storageClassName}'; echo"
            echo "    kubectl get sc <storage-class> -o yaml | rg allowVolumeExpansion"
            echo ""
            echo "  If expansion is supported, patch PVC size and redeploy:"
            echo "    kubectl patch pvc tts-models-pvc -n ${namespace} -p '{\"spec\":{\"resources\":{\"requests\":{\"storage\":\"5Gi\"}}}}'"
            echo "    kubectl patch pvc stt-models-pvc -n ${namespace} -p '{\"spec\":{\"resources\":{\"requests\":{\"storage\":\"5Gi\"}}}}'"
            echo ""
            echo "  If expansion is NOT supported, recreate PVCs (data will be lost unless migrated), then redeploy:"
            echo "    kubectl delete pvc -n ${namespace} tts-models-pvc stt-models-pvc"
            echo "    ./scripts/deploy.sh"
            echo ""
        }

        # Heuristic matcher for common Kubernetes/storage-class resize-denied messages.
        # We intentionally keep this broad because providers format these errors differently.
        is_pvc_resize_forbidden_error() {
            local output="$1"
            local lower
            lower=$(echo "$output" | tr '[:upper:]' '[:lower:]')

            [[ "$lower" == *"only dynamically provisioned pvc can be resized"* ]] \
                || [[ "$lower" == *"allowvolumeexpansion"* ]] \
                || [[ "$lower" == *"forbidden"* && "$lower" == *"persistentvolumeclaim"* && "$lower" == *"storage"* ]]
        }

        echo -ne "   ${ARROW} Model Storage PVCs... "

        local combined_output=""
        local stt_output=""
        local tts_output=""
        local stt_exit=0
        local tts_exit=0

        # Apply PVCs sequentially so output and failure source are unambiguous.
        # We disable errexit temporarily to capture command output and exit codes.
        set +e
        stt_output=$(kubectl apply -f "$(prepare_manifest "$stt_manifest")" 2>&1)
        stt_exit=$?
        # Only apply TTS PVC if STT apply succeeded; this keeps logs easier to reason about.
        if [[ $stt_exit -eq 0 ]]; then
            tts_output=$(kubectl apply -f "$(prepare_manifest "$tts_manifest")" 2>&1)
            tts_exit=$?
        fi
        set -e

        combined_output="${stt_output}\n${tts_output}"

        if [[ $stt_exit -eq 0 && $tts_exit -eq 0 ]]; then
            printf "\r   ${ARROW} Model Storage PVCs... ${GREEN}${CHECK}${NC}    \n"
            return 0
        fi

        printf "\r   ${ARROW} Model Storage PVCs... ${RED}${CROSS}${NC}    \n"
        error "Model Storage PVCs failed"

        if [[ -n "$stt_output" ]]; then
            echo -e "   ${DIM}STT PVC output:${NC}"
            echo "$stt_output" | while read -r line; do
                echo "     $line"
            done
        fi
        if [[ -n "$tts_output" ]]; then
            echo -e "   ${DIM}TTS PVC output:${NC}"
            echo "$tts_output" | while read -r line; do
                echo "     $line"
            done
        fi

        # For resize-forbidden scenarios, print cluster-specific remediation steps.
        if is_pvc_resize_forbidden_error "$combined_output"; then
            print_pvc_resize_remediation
        fi

        # Fail fast: deployment should stop here because downstream services depend on model PVCs.
        return 1
    }

    # Phase 1: Namespace, RBAC, and Secrets
    apply_with_spinner "Namespace & RBAC" bash -c "kubectl apply -f $(prepare_manifest k8s/00-namespace.yaml) && kubectl apply -f $(prepare_manifest k8s/03-secrets.yaml) && kubectl apply -f $(prepare_manifest k8s/05-rbac.yaml)"

    # Secrets (inline, not backgroundable due to function)
    echo -ne "   ${ARROW} Secrets... "
    create_secrets >/dev/null 2>&1
    printf "\r   ${ARROW} Secrets... ${GREEN}${CHECK}${NC}    \n"

    apply_with_spinner "ConfigMap" kubectl apply -f "${TEMP_DIR}/04-configmap-updated.yaml"

    # Save ConfigMap checksum after successful apply
    if [[ -n "${CONFIGMAP_NEW_HASH:-}" && -n "${CONFIGMAP_CHECKSUM_FILE:-}" ]]; then
        echo "$CONFIGMAP_NEW_HASH" > "$CONFIGMAP_CHECKSUM_FILE"
    fi

    # Phase 1.5: Model Storage PVCs (for STT/TTS models)
    apply_model_storage_pvcs

    # Phase 2: PostgreSQL
    echo -ne "   ${ARROW} PostgreSQL... "
    kubectl apply -f "$(prepare_manifest k8s/01-postgres-config.yaml)" >/dev/null 2>&1 || true
    kubectl apply -f "$(prepare_manifest k8s/01-postgres.yaml)" >/dev/null 2>&1

    # Wait for PostgreSQL with spinner
    kubectl wait --for=condition=ready pod -l app=postgres -n "$KUBERNETES_NAMESPACE" --timeout=120s >/dev/null 2>&1 &
    local pg_pid=$!

    local spinner_idx=0
    while kill -0 $pg_pid 2>/dev/null; do
        local spinner="${SPINNER_CHARS[$spinner_idx]}"
        printf "\r   ${ARROW} PostgreSQL... ${CYAN}${spinner}${NC} "
        spinner_idx=$(( (spinner_idx + 1) % ${#SPINNER_CHARS[@]} ))
        sleep 0.1
    done

    wait $pg_pid
    if [[ $? -eq 0 ]]; then
        printf "\r   ${ARROW} PostgreSQL... ${GREEN}${CHECK}${NC}    \n"
    else
        printf "\r   ${ARROW} PostgreSQL... ${RED}${CROSS}${NC}    \n"
        error "PostgreSQL failed to start"
        return 1
    fi

    # Phase 2.5: Run database migrations
    run_database_migrations
    if [[ $? -ne 0 ]]; then
        error "Database migration failed - stopping deployment"
        return 1
    fi

    # Phase 2.6: Optional one-time initial admin bootstrap
    bootstrap_initial_admin
    if [[ $? -ne 0 ]]; then
        error "Initial admin bootstrap failed - stopping deployment"
        return 1
    fi

    # Phase 3: Application Services (apply manifests quietly)
    # All manifests use temp dir versions which may have custom DNS config applied
    echo -ne "   ${ARROW} Application services... "

    local apply_errors=""
    local apply_output=""
    set +e  # Disable errexit to capture errors

    local -a apply_manifests=(
        "session-management-server:${TEMP_DIR}/06-session-management-server-updated.yaml"
        "frontend-ui:${FRONTEND_MANIFEST:-$(prepare_manifest k8s/07-frontend-ui.yaml)}"
        "stt-service:$STT_MANIFEST"
        "tts-service:$TTS_MANIFEST"
        "message-recorder:${TEMP_DIR}/06-message-recorder-updated.yaml"
    )

    for entry in "${apply_manifests[@]}"; do
        local svc_name="${entry%%:*}"
        local manifest="${entry#*:}"
        local output
        output=$(kubectl apply -f "$manifest" 2>&1)
        if [[ $? -ne 0 ]]; then
            apply_errors="${apply_errors}${svc_name} "
            apply_output="${apply_output}\n--- ${svc_name} (${manifest}) ---\n${output}\n"
        fi
    done

    set -e  # Re-enable errexit

    if [[ -n "$apply_errors" ]]; then
        printf "\r   ${ARROW} Application services... ${RED}${CROSS}${NC}    \n"
        error "Failed to apply manifests: $apply_errors"
        echo -e "$apply_output"
        return 1
    fi
    printf "\r   ${ARROW} Application services... ${GREEN}${CHECK}${NC}    \n"

    # NodePort services for local development
    if [[ "$NODE_ENV" != "production" ]]; then
        for f in k8s/local/*.yaml; do
            [[ -f "$f" ]] && kubectl apply -f "$(prepare_manifest "$f")" >/dev/null 2>&1 || true
        done
    fi

    # GPU patches if enabled
    if [[ "$ENABLE_GPU" == "true" ]]; then
        apply_gpu_patches
    fi

    # Restart and wait for services (this shows progress)
    restart_services
    wait_for_services

    success "Deployment complete"
}

# =============================================================================
# GPU Patches
# =============================================================================

apply_gpu_patches() {
    verbose "Applying GPU patches..."

    local services=("stt-service" "tts-service")
    for svc in "${services[@]}"; do
        local has_nvidia
        has_nvidia=$(kubectl get deployment -n "$KUBERNETES_NAMESPACE" "$svc" \
            -o jsonpath='{.spec.template.spec.containers[0].env[*].name}' 2>/dev/null | grep -c "NVIDIA_VISIBLE_DEVICES" || true)

        if [[ "$has_nvidia" == "0" ]]; then
            kubectl patch deployment -n "$KUBERNETES_NAMESPACE" "$svc" --type='json' \
                -p='[{"op": "add", "path": "/spec/template/spec/containers/0/env/-", "value": {"name": "NVIDIA_VISIBLE_DEVICES", "value": "all"}}]' >/dev/null 2>&1
            verbose "$svc: GPU patch applied"
        fi
    done
}

# =============================================================================
# Service Restart (Consolidated)
# =============================================================================

restart_services() {
    # Always verify all services, but only restart those that were rebuilt
    SERVICES_TO_WAIT="$ALL_DEPLOYMENTS"

    # Determine which services need restart
    local services_to_restart=""

    if [[ "$REBUILD_MODE" == "true" || "$SKIP_BUILD_MODE" == "true" ]]; then
        # Restart all deployments
        services_to_restart="$ALL_DEPLOYMENTS"
        verbose "Restarting all services..."
    elif [[ "${CONFIGMAP_CHANGED:-false}" == "true" ]]; then
        # ConfigMap changed - restart all services to pick up new env values
        services_to_restart="$ALL_DEPLOYMENTS"
        verbose "ConfigMap changed - restarting all services..."
    elif [[ ${#REBUILT_SERVICES[@]} -gt 0 ]]; then
        # Restart only rebuilt services
        for service in $ALL_SERVICES; do
            if service_was_rebuilt "$service"; then
                local deploy_name
                deploy_name=$(get_deployment_name "$service")
                services_to_restart="$services_to_restart $deploy_name"
            fi
        done
        verbose "Restarting rebuilt services: $services_to_restart"
    else
        verbose "No services rebuilt - skipping restarts, will verify existing pods"
    fi

    # Restart services that need it
    for deploy in $services_to_restart; do
        kubectl rollout restart deployment "$deploy" -n "$KUBERNETES_NAMESPACE" >/dev/null 2>&1 || true
    done

    export SERVICES_TO_WAIT
}

# =============================================================================
# Wait for Services (Consolidated) with Spinner Animation
# =============================================================================

wait_for_services() {
    # Check if SERVICES_TO_WAIT is set and not empty
    [[ -z "${SERVICES_TO_WAIT:-}" ]] && return 0

    # Show what we're waiting for
    verbose "Waiting for services to be ready..."
    local failed_services=""

    for deploy in $SERVICES_TO_WAIT; do
        local timeout
        timeout=$(get_service_timeout "$deploy")
        local display_name="$deploy"

        # Pretty names
        case "$deploy" in
            "session-management-server") display_name="Backend" ;;
            "frontend-ui") display_name="Frontend" ;;
            "stt-service") display_name="STT Service" ;;
            "tts-service") display_name="TTS Service" ;;
            "message-recorder") display_name="Message Recorder" ;;
        esac

        # Start rollout status check in background
        echo -ne "   ${ARROW} ${display_name}... "

        kubectl rollout status "deployment/$deploy" -n "$KUBERNETES_NAMESPACE" --timeout="${timeout}s" >/dev/null 2>&1 &
        local pid=$!

        # Spinner animation while waiting
        local spinner_idx=0
        while kill -0 $pid 2>/dev/null; do
            local spinner="${SPINNER_CHARS[$spinner_idx]}"
            printf "\r   ${ARROW} ${display_name}... ${CYAN}${spinner}${NC} "
            spinner_idx=$(( (spinner_idx + 1) % ${#SPINNER_CHARS[@]} ))
            sleep 0.1
        done

        # Don't let set -e abort here; report all service statuses first.
        set +e
        wait $pid
        local exit_code=$?
        set -e

        if [[ $exit_code -eq 0 ]]; then
            printf "\r   ${ARROW} ${display_name}... ${GREEN}${CHECK}${NC}    \n"
        else
            printf "\r   ${ARROW} ${display_name}... ${RED}${CROSS}${NC}    \n"
            failed_services="${failed_services}${deploy} "
        fi
    done

    if [[ -n "$failed_services" ]]; then
        error "Some services failed readiness checks: $failed_services"
        return 1
    fi
}

# =============================================================================
# Dry-Run Display
# =============================================================================

show_dry_run_deployment() {
    echo -e "   ${ARROW} Would apply: k8s/00-namespace.yaml"
    echo -e "   ${ARROW} Would apply: k8s/03-secrets.yaml"
    echo -e "   ${ARROW} Would apply: k8s/05-rbac.yaml"
    echo -e "   ${ARROW} Would create: stella-ai-secrets"
    echo -e "   ${ARROW} Would apply: configmap"
    echo -e "   ${ARROW} Would apply: k8s/01-postgres.yaml"
    echo -e "   ${ARROW} Would apply: session-management-server"
    echo -e "   ${ARROW} Would apply: frontend-ui"
    echo -e "   ${ARROW} Would apply: stt-service"
    echo -e "   ${ARROW} Would apply: tts-service"
    echo -e "   ${ARROW} Would apply: message-recorder"
}

# =============================================================================
# Port Forwarding
# =============================================================================

start_port_forwards() {
    info "${EMOJI_NETWORK} Setting up port forwards..."

    if [[ "$DRY_RUN_MODE" == "true" ]]; then
        echo -e "   ${ARROW} Would start port-forward daemon... ${YELLOW}[dry-run]${NC}"
        return 0
    fi

    local port_forward_daemon="$SCRIPT_DIR/port-forward-daemon.sh"

    if [[ -x "$port_forward_daemon" ]]; then
        "$port_forward_daemon" start -d
        success "Port forwards active"
    else
        warning "port-forward-daemon.sh not found"

        # Fallback: manual port-forwards
        start_manual_port_forwards
    fi
}

start_manual_port_forwards() {
    verbose "Starting manual port-forwards..."

    # Kill existing port-forwards for this namespace
    pkill -f "kubectl port-forward.*${KUBERNETES_NAMESPACE}" 2>/dev/null || true

    # Start new port-forwards in background
    kubectl port-forward svc/frontend-ui ${FRONTEND_PORT}:8080 -n "$KUBERNETES_NAMESPACE" >/dev/null 2>&1 &
    kubectl port-forward svc/session-management-server ${BACKEND_PORT}:3000 -n "$KUBERNETES_NAMESPACE" >/dev/null 2>&1 &

    verbose "Manual port-forwards started"
}

# =============================================================================
# GPU/CPU Status Detection
# =============================================================================

# Check the runtime status of STT and TTS services (CUDA vs CPU)
check_service_runtime_status() {
    local service="$1"
    local pod_name
    local status="unknown"
    local provider="unknown"
    local details=""

    # Get the pod name
    pod_name=$(kubectl get pods -n "$KUBERNETES_NAMESPACE" -l "app=$service" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)

    if [[ -z "$pod_name" ]]; then
        echo "unknown|unknown|Pod not found"
        return
    fi

    # Get recent logs (last 100 lines should be enough for startup)
    local logs
    logs=$(kubectl logs "$pod_name" -n "$KUBERNETES_NAMESPACE" --tail=100 2>/dev/null || echo "")

    if [[ "$service" == "stt-service" ]]; then
        # Check for Whisper CUDA success
        if echo "$logs" | grep -q "device=cuda.*compute_type=float16"; then
            if echo "$logs" | grep -q "CUDA failed\|CUDA driver version is insufficient"; then
                status="CPU"
                provider="sherpa"
                details="Whisper CUDA failed, fell back to Sherpa CPU"
            else
                status="CUDA"
                provider="whisper"
                details="Whisper large-v3 (float16)"
            fi
        elif echo "$logs" | grep -iq "Primary.provider.*whisper\|PRIMARY PROVIDER.*whisper"; then
            status="CUDA"
            provider="whisper"
            details="Whisper GPU"
        elif echo "$logs" | grep -iq "Primary.provider.*sherpa\|PRIMARY PROVIDER.*sherpa"; then
            # Check if Sherpa is using GPU
            if echo "$logs" | grep -iq "provider=cuda\|CUDAExecutionProvider"; then
                if echo "$logs" | grep -iq "Fallback to cpu"; then
                    status="CPU"
                    provider="sherpa"
                    details="Sherpa ONNX (CPU fallback)"
                else
                    status="CUDA"
                    provider="sherpa"
                    details="Sherpa ONNX (CUDA)"
                fi
            else
                status="CPU"
                provider="sherpa"
                details="Sherpa ONNX (CPU)"
            fi
        elif echo "$logs" | grep -q "Fallback to cpu"; then
            status="CPU"
            provider="sherpa"
            details="GPU unavailable, using CPU"
        fi

    elif [[ "$service" == "tts-service" ]]; then
        # Parse the "Primary provider: <name>" log line first — it's the
        # authoritative signal from the TTS engine itself. Take the LAST
        # occurrence in case the pod restarted and re-logged.
        local primary
        primary=$(echo "$logs" | grep -i "Primary provider:" | tail -1 \
            | sed -E 's/.*[Pp]rimary [Pp]rovider:[[:space:]]*([A-Za-z0-9]+).*/\1/' \
            | tr '[:upper:]' '[:lower:]')

        case "$primary" in
            qwen3)
                status="CUDA"
                provider="qwen3"
                details="Qwen3-TTS via faster-qwen3-tts (CUDA)"
                ;;
            chatterbox)
                provider="chatterbox"
                if echo "$logs" | grep -iq "device=cuda\|Using device: cuda"; then
                    status="CUDA"
                    details="ChatterBox Multilingual TTS (CUDA)"
                else
                    status="CPU"
                    details="ChatterBox Multilingual TTS (local)"
                fi
                ;;
            kokoro)
                provider="kokoro"
                if echo "$logs" | grep -iq "CUDA failed\|CUDA driver version is insufficient"; then
                    status="CPU"
                    details="Kokoro CUDA failed, running on CPU"
                else
                    status="CUDA"
                    details="Kokoro ONNX (CUDA)"
                fi
                ;;
            piper)
                status="CPU"
                provider="piper"
                details="Piper TTS (local CPU)"
                ;;
            elevenlabs)
                status="Cloud"
                provider="elevenlabs"
                details="ElevenLabs (cloud API)"
                ;;
            *)
                # No "Primary provider:" line yet — fall back to inferring
                # from device/runtime traces so we still report something
                # useful while the pod is mid-startup.
                if echo "$logs" | grep -iq "CUDAExecutionProvider" \
                   && ! echo "$logs" | grep -iq "CUDA failed\|CUDA driver version is insufficient"; then
                    status="CUDA"
                    provider="kokoro"
                    details="Kokoro ONNX (CUDA)"
                fi
                ;;
        esac
    fi

    echo "$status|$provider|$details"
}

# Display GPU status for both services
show_gpu_status() {
    # STT Service
    local stt_result
    stt_result=$(check_service_runtime_status "stt-service")
    local stt_status stt_provider stt_details
    IFS='|' read -r stt_status stt_provider stt_details <<< "$stt_result"

    # TTS Service
    local tts_result
    tts_result=$(check_service_runtime_status "tts-service")
    local tts_status tts_provider tts_details
    IFS='|' read -r tts_status tts_provider tts_details <<< "$tts_result"

    echo ""
    info "🎮 Runtime Status"

    # STT display
    echo -n "   STT Service:   "
    if [[ "$stt_status" == "CUDA" ]]; then
        echo -e "${GREEN}${CHECK} CUDA${NC} (${stt_provider}) ${DIM}- ${stt_details}${NC}"
    elif [[ "$stt_status" == "CPU" ]]; then
        echo -e "${YELLOW}${CROSS} CPU${NC} (${stt_provider}) ${DIM}- ${stt_details}${NC}"
    else
        echo -e "${DIM}${stt_status}${NC}"
    fi

    # TTS display
    echo -n "   TTS Service:   "
    if [[ "$tts_status" == "CUDA" ]]; then
        echo -e "${GREEN}${CHECK} CUDA${NC} (${tts_provider}) ${DIM}- ${tts_details}${NC}"
    elif [[ "$tts_status" == "CPU" ]]; then
        echo -e "${YELLOW}${CROSS} CPU${NC} (${tts_provider}) ${DIM}- ${tts_details}${NC}"
    elif [[ "$tts_status" == "Cloud" ]]; then
        echo -e "${CYAN}☁ Cloud${NC} (${tts_provider}) ${DIM}- ${tts_details}${NC}"
    else
        echo -e "${DIM}${tts_status}${NC}"
    fi

    # Show warning if GPU was expected but not available
    if [[ "$ENABLE_GPU" == "true" ]]; then
        if [[ "$stt_status" == "CPU" || "$tts_status" == "CPU" ]]; then
            echo ""
            warning "GPU enabled but some services fell back to CPU"
            echo -e "   ${DIM}Check: kubectl logs -n $KUBERNETES_NAMESPACE -l app=stt-service --tail=50${NC}"
        fi
    fi

    # Surface a TTS provider mismatch loudly — operators set TTS_PROVIDER
    # in the env file expecting that exact provider, so silently falling
    # back to a different one (e.g. qwen3 weights missing → kokoro)
    # has bitten us before. Dump the failure log so the cause is obvious.
    local configured_tts="${TTS_PROVIDER:-piper}"
    configured_tts="$(echo "$configured_tts" | tr '[:upper:]' '[:lower:]')"
    if [[ "$configured_tts" != "auto" && -n "$tts_provider" && "$tts_provider" != "unknown" \
          && "$tts_provider" != "$configured_tts" ]]; then
        echo ""
        warning "TTS provider mismatch: configured=${configured_tts}, running=${tts_provider}"
        echo -e "   ${DIM}The requested provider failed to initialize and the engine fell back.${NC}"
        echo ""
        local tts_pod
        tts_pod=$(kubectl get pods -n "$KUBERNETES_NAMESPACE" -l app=tts-service \
            -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
        if [[ -n "$tts_pod" ]]; then
            local err_lines
            err_lines=$(kubectl logs "$tts_pod" -n "$KUBERNETES_NAMESPACE" --tail=200 2>/dev/null \
                | grep -iE "Initialization failed|initialization failed|not available|error|traceback|license" \
                | grep -viE "NGC-DL-CONTAINER-LICENSE|nvidia-deep-learning-container-license" \
                | tail -15)
            if [[ -n "$err_lines" ]]; then
                echo -e "   ${DIM}Relevant log lines from ${tts_pod}:${NC}"
                while IFS= read -r line; do
                    echo -e "   ${YELLOW}│${NC} ${line}"
                done <<< "$err_lines"
                echo ""
            fi
            echo -e "   ${DIM}Full logs: kubectl logs -n $KUBERNETES_NAMESPACE $tts_pod${NC}"
        fi
    fi
}

# =============================================================================
# Summary Display
# =============================================================================

show_summary() {
    if [[ "$DRY_RUN_MODE" == "true" ]]; then
        dry_run_summary
        return 0
    fi

    # Show GPU status before the summary box
    show_gpu_status

    summary_box \
        "http://localhost:${FRONTEND_PORT}" \
        "http://localhost:${BACKEND_PORT}" \
        "${PUBLIC_LIVEKIT_URL:-ws://localhost:7880}"
}
