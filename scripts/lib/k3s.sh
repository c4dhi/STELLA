#!/bin/bash
# =============================================================================
# k3s.sh - K3s setup and management (unified for macOS and Linux)
# =============================================================================

# =============================================================================
# Prerequisites Check
# =============================================================================

check_setsid() {
    if ! command_exists setsid; then
        if [[ "$OS_TYPE" == "macos" ]]; then
            verbose "Installing setsid via util-linux..."
            if command_exists brew; then
                brew install util-linux >/dev/null 2>&1
                export PATH="/opt/homebrew/opt/util-linux/bin:$PATH"
            fi
        fi

        if ! command_exists setsid; then
            warning "setsid not found - build output may be affected"
        fi
    fi
}

# =============================================================================
# Storage Root Relocation (optional, Linux)
# =============================================================================
# When STELLA_DATA_ROOT is set, the disk-heavy stores are moved onto it:
#   - Docker data-root  (build cache + locally built images)
#   - K3s --data-dir     (containerd image store + local-path PVCs for Postgres
#                         and the STT/TTS/Qwen3 model caches)
# A blank STELLA_DATA_ROOT keeps the system defaults (/var/lib/docker,
# /var/lib/rancher/k3s, /tmp), which always work with no setup. Relocation only
# takes effect on a FRESH Docker/K3s install — an already-installed K3s keeps
# its current data-dir (moving it would wipe the cluster), so we warn instead.

# Ensure STELLA_DATA_ROOT exists and is writable. Returns non-zero (with a
# warning) when it can't be prepared, so callers fall back to system defaults
# rather than aborting the deploy.
prepare_storage_root() {
    local root="${STELLA_DATA_ROOT:-}"
    [[ -z "$root" ]] && return 1

    if [[ "$OS_TYPE" != "linux" ]]; then
        verbose "STELLA_DATA_ROOT set, but on $OS_TYPE configure the disk via Docker Desktop/OrbStack settings instead."
        return 1
    fi

    [[ -d "$root" && -w "$root" ]] && return 0

    if [[ "$DRY_RUN_MODE" == "true" ]]; then
        echo -e "   ${ARROW} Would create data root $root ${YELLOW}[dry-run]${NC}"
        return 0
    fi

    if sudo mkdir -p "$root" 2>/dev/null && sudo chown "$(id -u):$(id -g)" "$root" 2>/dev/null; then
        verbose "Prepared data root: $root"
        return 0
    fi

    warning "Could not create data root '$root' — keeping default storage locations."
    return 1
}

# Report the data-dir the installed K3s is actually using (default when the
# service file has no --data-dir flag).
k3s_current_data_dir() {
    local d
    d=$(grep -hoErs -- "--data-dir[= ][^ '\"]+" /etc/systemd/system/k3s.service 2>/dev/null \
        | head -1 | sed -E "s/--data-dir[= ]//")
    echo "${d:-/var/lib/rancher/k3s}"
}

# Point Docker's data-root at the external disk. Detects the current root, only
# acts on a change, backs up daemon.json, and restarts Docker. Never aborts the
# deploy — degrades to a warning if anything is unsafe.
ensure_docker_data_root() {
    [[ "$OS_TYPE" == "linux" ]] || return 0
    [[ -n "${STELLA_DATA_ROOT:-}" ]] || return 0
    command_exists docker || return 0

    local target="${STELLA_DATA_ROOT}/docker"
    local current
    current=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo "")
    if [[ "$current" == "$target" ]]; then
        verbose "Docker data-root already at $target"
        return 0
    fi

    if [[ "$DRY_RUN_MODE" == "true" ]]; then
        echo -e "   ${ARROW} Would set Docker data-root: ${current:-default} -> $target ${YELLOW}[dry-run]${NC}"
        return 0
    fi

    local daemon=/etc/docker/daemon.json
    # Avoid clobbering an existing multi-key daemon.json when jq isn't available.
    if [[ -s "$daemon" ]] && ! command_exists jq; then
        warning "Docker already has $daemon and 'jq' is unavailable — not modifying it."
        echo -e "  ${DIM}Add \"data-root\": \"$target\" to $daemon and restart Docker manually.${NC}"
        return 0
    fi

    info "Relocating Docker data-root -> $target (rebuilds image cache there)"
    sudo mkdir -p "$target" 2>/dev/null || { warning "Cannot create $target — skipping Docker relocation."; return 0; }
    if [[ -s "$daemon" ]]; then
        sudo cp "$daemon" "${daemon}.bak.$(date +%Y%m%d_%H%M%S)" 2>/dev/null || true
        sudo sh -c "jq --arg dr '$target' '. + {\"data-root\": \$dr}' '$daemon' > '${daemon}.tmp' && mv '${daemon}.tmp' '$daemon'" \
            || { warning "Failed to update $daemon — skipping Docker relocation."; return 0; }
    else
        sudo mkdir -p /etc/docker 2>/dev/null || true
        echo "{\"data-root\": \"$target\"}" | sudo tee "$daemon" >/dev/null
    fi

    if sudo systemctl restart docker 2>/dev/null; then
        sleep 3
        verbose "Docker restarted with data-root $target"
    else
        warning "Docker data-root written but restart failed — it applies on the next Docker restart."
    fi
}

# Ensure the NVIDIA Container Toolkit is installed and configured for K3s so a
# fresh GPU server is self-sufficient. Linux-only, idempotent, honors --dry-run,
# and degrades to a warning rather than failing — matching ensure_docker_data_root
# and prepare_storage_root. Three steps, each fixing a problem hit in practice:
#   1. apt-install nvidia-container-toolkit (NVIDIA's repo) when the
#      nvidia-container-runtime binary is missing — fixes pods failing with
#      'no runtime for "nvidia" is configured'.
#   2. Force the toolkit config to mode = "legacy" — toolkit >=1.19 defaults to
#      jit-cdi, which fails under K3s with exit status 2.
#   3. Restart K3s once, and only after a change — K3s registers the nvidia
#      runtime in its containerd config at startup, so it needs one restart to
#      pick up the newly-installed binary. Guarded so it never restarts on a
#      no-op deploy.
ensure_nvidia_container_toolkit() {
    [[ "$OS_TYPE" == "linux" ]] || return 0

    local did_change=false

    # Step 1: install the toolkit if the runtime binary is absent.
    if ! command_exists nvidia-container-runtime; then
        if [[ "$DRY_RUN_MODE" == "true" ]]; then
            echo -e "   ${ARROW} Would install nvidia-container-toolkit ${YELLOW}[dry-run]${NC}"
            return 0
        fi

        info "Installing NVIDIA Container Toolkit..."
        local keyring=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
        local listfile=/etc/apt/sources.list.d/nvidia-container-toolkit.list
        if curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey 2>/dev/null \
                | sudo gpg --dearmor -o "$keyring" 2>/dev/null \
           && curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list 2>/dev/null \
                | sed "s#deb https://#deb [signed-by=${keyring}] https://#g" \
                | sudo tee "$listfile" >/dev/null \
           && sudo apt-get update >/dev/null 2>&1 \
           && sudo apt-get install -y nvidia-container-toolkit >/dev/null 2>&1; then
            did_change=true
            verbose "nvidia-container-toolkit installed"
        else
            warning "Could not install nvidia-container-toolkit automatically."
            echo -e "  ${DIM}Install it manually: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html${NC}"
            return 0
        fi
    fi

    # Step 2: force legacy mode — the jit-cdi default (toolkit >=1.19) breaks
    # under K3s with exit status 2.
    local cfg=/etc/nvidia-container-runtime/config.toml
    if [[ -f "$cfg" ]] && ! grep -qE '^[[:space:]]*mode[[:space:]]*=[[:space:]]*"legacy"' "$cfg" 2>/dev/null; then
        if [[ "$DRY_RUN_MODE" == "true" ]]; then
            echo -e "   ${ARROW} Would set nvidia-container-runtime mode = \"legacy\" ${YELLOW}[dry-run]${NC}"
        else
            verbose "Setting nvidia-container-runtime mode = \"legacy\""
            if grep -qE '^[[:space:]]*mode[[:space:]]*=' "$cfg" 2>/dev/null; then
                sudo sed -i -E 's|^[[:space:]]*mode[[:space:]]*=.*|mode = "legacy"|' "$cfg" 2>/dev/null \
                    && did_change=true || warning "Could not set legacy mode in $cfg."
            else
                # No mode key present: add one under the [nvidia-container-runtime] table.
                sudo sed -i -E 's|^[[:space:]]*\[nvidia-container-runtime\][[:space:]]*$|[nvidia-container-runtime]\nmode = "legacy"|' "$cfg" 2>/dev/null \
                    && did_change=true || warning "Could not set legacy mode in $cfg."
            fi
        fi
    fi

    # Step 3: restart K3s once so it registers the nvidia runtime in its
    # containerd config — only when something actually changed.
    if [[ "$did_change" == "true" && "$DRY_RUN_MODE" != "true" ]]; then
        if sudo systemctl is-active --quiet k3s 2>/dev/null; then
            verbose "Restarting K3s to register the NVIDIA runtime..."
            sudo systemctl restart k3s 2>/dev/null \
                || warning "K3s restart failed — restart it manually to register the NVIDIA runtime."
            sleep 5
        fi
    fi
}

# =============================================================================
# K3s Setup (Main Function)
# =============================================================================

setup_k3s() {
    info "${EMOJI_GEAR} Setting up K3s..."

    # Check setsid first
    check_setsid

    if [[ "$OS_TYPE" == "macos" ]]; then
        setup_k3s_macos
    else
        setup_k3s_linux
    fi

    # Install metrics-server if needed
    install_metrics_server

    success "K3s ready (context: $(kubectl config current-context 2>/dev/null || echo 'default'))"
}

# =============================================================================
# macOS K3s Setup (via OrbStack/Rancher Desktop/Colima)
# =============================================================================

setup_k3s_macos() {
    verbose "Checking for K3s runtime on macOS..."

    # Check if kubectl can connect to a cluster
    if ! kubectl cluster-info &>/dev/null; then
        error "No K3s runtime detected"
        echo ""
        echo -e "   ${BOLD}Install a K3s runtime:${NC}"
        echo ""
        echo -e "   ${CYAN}OrbStack (Recommended):${NC}"
        echo -e "   ${DIM}brew install --cask orbstack${NC}"
        echo -e "   ${DIM}Then: OrbStack → Settings → Kubernetes → Enable${NC}"
        echo ""
        echo -e "   ${CYAN}Rancher Desktop:${NC}"
        echo -e "   ${DIM}brew install --cask rancher${NC}"
        echo ""
        exit 1
    fi

    # Validate context
    local current_context
    current_context=$(kubectl config current-context 2>/dev/null)

    case "$current_context" in
        orbstack|rancher-desktop|*colima*)
            verbose "K3s runtime: $current_context"
            ;;
        *)
            warning "Unexpected context: $current_context"
            echo -e "   ${DIM}Expected: orbstack, rancher-desktop, or colima${NC}"
            ;;
    esac

    # Verify node is ready
    wait_for_node
}

# =============================================================================
# Linux K3s Setup (Native Installation)
# =============================================================================

setup_k3s_linux() {
    # Optional: relocate disk-heavy storage onto STELLA_DATA_ROOT. Blank keeps
    # the system defaults. prepare_storage_root succeeds only when the path is
    # usable, so a bad value degrades to defaults rather than failing.
    local relocate=false
    if [[ -n "${STELLA_DATA_ROOT:-}" ]] && prepare_storage_root; then
        relocate=true
        ensure_docker_data_root
    fi

    # Install K3s if not present
    if ! command_exists k3s; then
        verbose "Installing K3s..."

        if [[ "$DRY_RUN_MODE" == "true" ]]; then
            local _dd="default"
            [[ "$relocate" == "true" ]] && _dd="${STELLA_DATA_ROOT}/k3s"
            echo -e "   ${ARROW} Would install K3s (data-dir: ${_dd})... ${YELLOW}[dry-run]${NC}"
            return 0
        fi

        # Install K3s with containerd, disable traefik. When relocating, store
        # all K3s data (containerd images + local-path PVCs) on the data disk.
        local k3s_exec="--disable traefik"
        if [[ "$relocate" == "true" ]]; then
            k3s_exec="$k3s_exec --data-dir ${STELLA_DATA_ROOT}/k3s"
            verbose "K3s data-dir -> ${STELLA_DATA_ROOT}/k3s"
            info "Persistent volumes (Postgres + models) will live under ${STELLA_DATA_ROOT}/k3s/storage"
        fi
        curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="$k3s_exec" sh - >/dev/null 2>&1

        sleep 5
        verbose "K3s installed"
    elif [[ "$relocate" == "true" ]]; then
        # Already installed: relocating the data-dir would wipe the cluster, so
        # never do it automatically — just flag the mismatch.
        local cur_dd
        cur_dd=$(k3s_current_data_dir)
        if [[ "$cur_dd" != "${STELLA_DATA_ROOT}/k3s" ]]; then
            warning "K3s is already installed using data-dir '$cur_dd'."
            echo -e "  ${DIM}Its images and volumes stay there; STELLA_DATA_ROOT only relocates${NC}"
            echo -e "  ${DIM}Docker. To move K3s too, reinstall it with --data-dir${NC}"
            echo -e "  ${DIM}${STELLA_DATA_ROOT}/k3s (this resets the cluster — not done${NC}"
            echo -e "  ${DIM}automatically to avoid data loss).${NC}"
        fi
    fi

    # Start K3s if not running
    if ! sudo systemctl is-active --quiet k3s 2>/dev/null; then
        verbose "Starting K3s service..."

        if [[ "$DRY_RUN_MODE" == "true" ]]; then
            echo -e "   ${ARROW} Would start K3s... ${YELLOW}[dry-run]${NC}"
            return 0
        fi

        sudo systemctl start k3s
        sleep 5
    fi

    # Setup kubeconfig
    setup_kubeconfig_linux

    # Verify K3s is running
    if ! kubectl get nodes &>/dev/null; then
        error "K3s is not responding"
        echo -e "   ${DIM}Try: sudo systemctl status k3s${NC}"
        exit 1
    fi

    # Install socat if needed (for port forwarding)
    if ! command_exists socat; then
        verbose "Installing socat..."
        sudo apt-get update >/dev/null 2>&1
        sudo apt-get install -y socat >/dev/null 2>&1
    fi

    # Wait for node to be ready
    wait_for_node

    # Confirm where dynamically-provisioned PVCs actually land on disk.
    verify_storage_location
}

# =============================================================================
# Storage Location Verification
# =============================================================================
# After the cluster is up, report the real on-disk path the local-path
# provisioner uses for PVCs (Postgres data + STT/TTS models). This is the
# ground truth that STELLA_DATA_ROOT took effect — read-only, never fails the
# run. K3s derives this path from --data-dir, so it follows STELLA_DATA_ROOT
# only on a fresh install.
verify_storage_location() {
    [[ "$DRY_RUN_MODE" == "true" ]] && return 0

    local cfg path
    cfg=$(kubectl -n kube-system get configmap local-path-config \
        -o jsonpath='{.data.config\.json}' 2>/dev/null) || return 0
    [[ -n "$cfg" ]] || return 0

    # Extract the first ".../storage" path from nodePathMap[].paths[] (no jq).
    path=$(echo "$cfg" | grep -oE '"/[^"]+/storage"' | head -1 | tr -d '"')
    [[ -n "$path" ]] || path="/var/lib/rancher/k3s/storage"

    if [[ -n "${STELLA_DATA_ROOT:-}" ]]; then
        if [[ "$path" == "${STELLA_DATA_ROOT}"* ]]; then
            success "Persistent volumes (Postgres + models) -> ${path}"
        else
            warning "PVCs are stored at '${path}', NOT under STELLA_DATA_ROOT (${STELLA_DATA_ROOT})."
            echo -e "  ${DIM}K3s was already installed with a different data-dir, so its storage${NC}"
            echo -e "  ${DIM}did not move. To relocate, reinstall K3s with${NC}"
            echo -e "  ${DIM}--data-dir ${STELLA_DATA_ROOT}/k3s (this wipes the cluster).${NC}"
        fi
    else
        verbose "Persistent volumes (Postgres + models) -> ${path}"
    fi
}

# =============================================================================
# Kubeconfig Setup (Linux)
# =============================================================================

setup_kubeconfig_linux() {
    mkdir -p ~/.kube

    if [[ "$DRY_RUN_MODE" == "true" ]]; then
        verbose "Would copy kubeconfig [dry-run]"
        return 0
    fi

    sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
    sudo chown "$(id -u):$(id -g)" ~/.kube/config
    chmod 600 ~/.kube/config
    export KUBECONFIG=~/.kube/config
}

# =============================================================================
# Node Readiness
# =============================================================================

wait_for_node() {
    if [[ "$DRY_RUN_MODE" == "true" ]]; then
        verbose "Would wait for node [dry-run]"
        return 0
    fi

    local node_status
    node_status=$(kubectl get nodes -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)

    if [[ "$node_status" != "True" ]]; then
        verbose "Waiting for node to be ready..."
        kubectl wait --for=condition=Ready node --all --timeout=60s >/dev/null 2>&1
    fi

    local node_name
    node_name=$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
    verbose "Node ready: $node_name"
}

# =============================================================================
# Metrics Server
# =============================================================================

install_metrics_server() {
    if kubectl get deployment metrics-server -n kube-system &>/dev/null; then
        verbose "Metrics server: already installed"
        return 0
    fi

    if [[ "$DRY_RUN_MODE" == "true" ]]; then
        verbose "Would install metrics-server [dry-run]"
        return 0
    fi

    verbose "Installing metrics-server..."
    kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml >/dev/null 2>&1

    # Patch for K3s compatibility
    kubectl patch deployment metrics-server -n kube-system --type='json' \
        -p='[{"op": "add", "path": "/spec/template/spec/containers/0/args/-", "value": "--kubelet-insecure-tls"}]' >/dev/null 2>&1

    verbose "Metrics server: installed"
}

# =============================================================================
# GPU Support (Linux only)
# =============================================================================

setup_gpu_support() {
    info "${EMOJI_GEAR} Checking GPU support..."

    # macOS doesn't support NVIDIA GPUs in containers
    if [[ "$OS_TYPE" == "macos" ]]; then
        echo -e "   ${ARROW} GPU: ${DIM}not available (macOS)${NC}"
        export ENABLE_GPU="false"
        return 0
    fi

    # Check if GPU is enabled in config
    if [[ "$ENABLE_GPU" != "true" ]]; then
        echo -e "   ${ARROW} GPU: ${DIM}disabled (ENABLE_GPU=false)${NC}"
        return 0
    fi

    # Check for NVIDIA GPU driver
    if ! command_exists nvidia-smi; then
        echo -e "   ${ARROW} GPU: ${YELLOW}not detected${NC} (nvidia-smi not found)"
        export ENABLE_GPU="false"
        return 0
    fi

    # Test if nvidia-smi actually works (can fail with various exit codes if GPU is busy/unavailable)
    local smi_exit=0
    nvidia-smi &>/dev/null || smi_exit=$?
    if [[ $smi_exit -ne 0 ]]; then
        echo -e "   ${ARROW} GPU: ${YELLOW}driver issue${NC} (nvidia-smi exit code $smi_exit)"
        echo -e "   ${DIM}GPU driver may need restart: sudo systemctl restart nvidia-persistenced${NC}"
        export ENABLE_GPU="false"
        return 0
    fi

    # Get GPU information (disable pipefail temporarily for robustness)
    local gpu_name
    local gpu_memory
    local driver_version
    set +o pipefail
    gpu_name=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 | xargs 2>/dev/null) || gpu_name="Unknown GPU"
    gpu_memory=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>/dev/null | head -1 | xargs 2>/dev/null) || gpu_memory="Unknown"
    driver_version=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 | xargs 2>/dev/null) || driver_version="Unknown"
    set -o pipefail

    # The driver is present (checked above) but the container toolkit may not
    # be. Install/configure it before relying on the runtime. || true so a
    # hiccup never aborts the deploy.
    ensure_nvidia_container_toolkit || true

    # Check for nvidia-container-runtime (either in Docker or K3s containerd)
    local nvidia_runtime_found=false

    # Check Docker for nvidia runtime (use subshell to prevent pipefail from propagating)
    if (docker info 2>/dev/null | grep -qi "nvidia") 2>/dev/null; then
        nvidia_runtime_found=true
    fi

    # Check K3s containerd for nvidia runtime
    if [[ -f /var/lib/rancher/k3s/agent/etc/containerd/config.toml ]]; then
        if grep -qi "nvidia" /var/lib/rancher/k3s/agent/etc/containerd/config.toml 2>/dev/null; then
            nvidia_runtime_found=true
        fi
    fi

    # Authoritative signal on Linux: the runtime binary is actually installed.
    # (Do NOT trust the nvidia RuntimeClass — K3s ships it by default, so it is
    # present even when no runtime binary exists, which produced false positives
    # and pods failing with: no runtime for "nvidia" is configured.)
    if command_exists nvidia-container-runtime; then
        nvidia_runtime_found=true
    fi

    if [[ "$nvidia_runtime_found" != "true" ]]; then
        echo -e "   ${ARROW} GPU: ${YELLOW}${gpu_name}${NC} (container runtime not configured)"
        echo -e "   ${DIM}Install: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html${NC}"
        export ENABLE_GPU="false"
        return 0
    fi

    # Check for K3s NVIDIA runtime class
    if ! kubectl get runtimeclass nvidia &>/dev/null; then
        verbose "Creating NVIDIA RuntimeClass..."
        kubectl apply -f - >/dev/null 2>&1 <<EOF
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: nvidia
handler: nvidia
EOF
    fi

    # Install NVIDIA device plugin if not present
    if ! kubectl get daemonset nvidia-device-plugin-daemonset -n kube-system &>/dev/null; then
        verbose "Installing NVIDIA device plugin..."

        # Determine kubelet device plugins path
        local kubelet_path="/var/lib/kubelet/device-plugins"
        if [[ -d "/var/lib/rancher/k3s/agent/kubelet/device-plugins" ]]; then
            kubelet_path="/var/lib/rancher/k3s/agent/kubelet/device-plugins"
        fi

        # Apply device plugin with correct path
        curl -s https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.14.1/nvidia-device-plugin.yml | \
            sed "s|/var/lib/kubelet/device-plugins|${kubelet_path}|g" | \
            kubectl apply -f - >/dev/null 2>&1
    fi

    # Show GPU details
    echo -e "   ${ARROW} GPU: ${GREEN}${gpu_name}${NC} (${gpu_memory}, driver ${driver_version})"
    success "GPU support enabled"
}

# =============================================================================
# Stop Services
# =============================================================================

stop_services() {
    info "${EMOJI_STOP} Stopping STELLA services in namespace '${KUBERNETES_NAMESPACE:-ai-agents}'..."

    # End this namespace's port-forward loops. The daemon keeps their pids in
    # ${PID_DIR}/daemon-pids.txt; nothing ever wrote the port-forward.pid this
    # used to look for, so the loops outlived every --stop (#737).
    if [[ -x "${SCRIPT_DIR}/port-forward-daemon.sh" ]]; then
        KUBERNETES_NAMESPACE="${KUBERNETES_NAMESPACE:-ai-agents}" PID_DIR="${PID_DIR:-}" \
            "${SCRIPT_DIR}/port-forward-daemon.sh" stop >/dev/null 2>&1 || true
        verbose "Stopped port-forward daemon"
    fi

    # Scale down deployments
    local deployments=("session-management-server" "frontend-ui" "stt-service" "tts-service" "message-recorder")
    for deploy in "${deployments[@]}"; do
        kubectl scale deployment "$deploy" -n "${KUBERNETES_NAMESPACE:-ai-agents}" --replicas=0 2>/dev/null || true
    done

    success "Services stopped"
}
