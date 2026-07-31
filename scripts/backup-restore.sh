#!/usr/bin/env bash
#
# Full-system backup restore (#378) — wizard/deploy layer.
#
# OVERWRITES this deployment with a bundle produced by backup-export.sh:
#   1. decrypt (if needed) and extract the embedded .env config,
#   2. recreate the stella-ai-secrets secret + restart the backend so the
#      restored ENV_VAR_ENCRYPTION_KEY / API keys take effect,
#   3. import the database + agent packages in-pod (overwriting all data).
#
# Intended for a fresh target stood up with ./scripts/start-k8s.sh. The current
# .env is backed up before being replaced.
#
#   ./scripts/backup-restore.sh --in BUNDLE [--production|--local]
#                               [--allow-key-mismatch] [--yes]
#
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"
# shellcheck source=/dev/null
source "$LIB_DIR/colors.sh"
# shellcheck source=/dev/null
source "$LIB_DIR/utils.sh"       # environment.sh depends on ensure_dir() from here
# shellcheck source=/dev/null
source "$LIB_DIR/environment.sh"
# shellcheck source=/dev/null
source "$LIB_DIR/deploy.sh"

# This script runs on the deploy host and needs the same toolchain the STELLA
# wizard/deploy already requires. Fail fast with clear, actionable next steps.
require_host_tools() {
    local need_node="" need_kubectl=""
    { command -v node && command -v npx; } >/dev/null 2>&1 || need_node="1"
    command -v kubectl >/dev/null 2>&1 || need_kubectl="1"
    [[ -z "$need_node$need_kubectl" ]] && return 0

    error "Can't run the restore — required tools are missing on this machine."
    echo
    local mac=""; [[ "$(uname -s)" == "Darwin" ]] && mac="1"
    if [[ -n "$need_node" ]]; then
        echo -e "  ${RED:-}✗${NC:-} Node.js (provides 'node' and 'npx') — runs the restore helper that"
        echo -e "    unpacks the bundle and handles decryption."
        if [[ -n "$mac" ]]; then
            echo -e "      → Install:  ${BOLD:-}brew install node${NC:-}"
        else
            echo -e "      → Install:  ${BOLD:-}curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs${NC:-}"
        fi
    fi
    if [[ -n "$need_kubectl" ]]; then
        echo -e "  ${RED:-}✗${NC:-} kubectl — talks to the cluster the deployment runs on."
        if [[ -n "$mac" ]]; then
            echo -e "      → Install:  ${BOLD:-}brew install kubectl${NC:-}"
        else
            echo -e "      → Install:  ${BOLD:-}https://kubernetes.io/docs/tasks/tools/${NC:-}"
        fi
    fi
    echo
    echo -e "  These are the same tools STELLA needs to deploy, so installing them also"
    echo -e "  unblocks normal setup. Install the above, then re-run this command."
    exit 1
}

# Actionable failure for a host toolchain that can't run the backup helper.
backup_helper_unavailable() {
    local root="$1" reason="$2" detail="${3:-}"
    error "Can't run the backup helper on this machine — ${reason}."
    echo
    echo -e "  The export/restore helper (scripts/backup-bundle.ts) runs via ts-node and"
    echo -e "  needs this checkout's npm packages (ts-node, typescript, archiver, yauzl)."
    echo -e "  Your node_modules is missing or out of date."
    echo
    echo -e "      → Run:  ${BOLD:-}npm install${NC:-}   in ${root}"
    echo
    echo -e "  Then re-run this command."
    if [[ -n "$detail" ]]; then
        echo
        echo -e "  ${DIM:-}Underlying error:${NC:-}"
        local useful
        useful="$(printf '%s\n' "$detail" | grep -iE "cannot find module|error TS[0-9]|MODULE_NOT_FOUND|^Error:" | head -4)"
        [[ -z "$useful" ]] && useful="$(printf '%s\n' "$detail" | head -4)"
        printf '%s\n' "$useful" | sed 's/^/    /'
    fi
    exit 1
}

# Preflight the host-side bundle helper by actually loading it through ts-node
# BEFORE anything is changed. Compiling backup-bundle.ts exercises its whole
# toolchain — ts-node, typescript, and every import (archiver, yauzl, crypto) —
# so this catches the entire class of "host can't run the helper" problems
# (stale/missing node_modules, a production --omit=dev install without ts-node, a
# future added dependency) up front, with one real check instead of a hardcoded
# package list.
preflight_backup_helper() {
    local root; root="$(cd "$SCRIPT_DIR/.." && pwd)"
    ( cd "$root" && node -e "require.resolve('ts-node'); require.resolve('typescript')" ) >/dev/null 2>&1 \
        || backup_helper_unavailable "$root" "ts-node / typescript are not installed"
    local out
    out="$( cd "$root" && npx --no-install ts-node "$SCRIPT_DIR/backup-bundle.ts" check 2>&1 )" \
        || backup_helper_unavailable "$root" "the backup helper failed to load" "$out"
}
require_host_tools
preflight_backup_helper

BUNDLE=""
ALLOW_KEY_MISMATCH=""
ASSUME_YES=""
export ENV_FLAG=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --in) BUNDLE="$2"; shift 2 ;;
        --allow-key-mismatch) ALLOW_KEY_MISMATCH="--allow-key-mismatch"; shift ;;
        --yes|-y) ASSUME_YES="true"; shift ;;
        --production) ENV_FLAG="production"; shift ;;
        --local) ENV_FLAG="local"; shift ;;
        -h|--help)
            echo "Usage: $0 --in BUNDLE [--production|--local] [--allow-key-mismatch] [--yes]"
            exit 0 ;;
        *) error "Unknown argument: $1"; exit 1 ;;
    esac
done

[[ -z "$BUNDLE" ]] && { error "Missing --in BUNDLE"; exit 1; }
[[ ! -f "$BUNDLE" ]] && { error "Bundle not found: $BUNDLE"; exit 1; }

setup_directories
set_defaults
load_environment

ENV_FILE="$PROJECT_DIR/.env.$([[ "$NODE_ENV" == "production" ]] && echo production || echo local)"

if [[ "$ASSUME_YES" != "true" ]]; then
    echo -e "${YELLOW:-}WARNING:${NC:-} this OVERWRITES all data and config in namespace '$KUBERNETES_NAMESPACE'."
    read -r -p "Type 'overwrite' to continue: " CONFIRM
    [[ "$CONFIRM" != "overwrite" ]] && { info "Aborted."; exit 1; }
fi

PASSPHRASE=""
# Peek the first bytes to see if the bundle is encrypted (matches bundle-crypto's MAGIC).
if [[ "$(head -c 9 "$BUNDLE" 2>/dev/null)" == "STELLABK2" ]]; then
    if [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
        PASSPHRASE="$BACKUP_PASSPHRASE"   # unattended path, mirrors backup-export.sh
    elif [[ ! -t 0 ]]; then
        error "No terminal available to prompt for the decryption passphrase."
        echo -e "  → Set ${BOLD:-}BACKUP_PASSPHRASE${NC:-} in the environment and re-run."
        exit 1
    else
        read -r -s -p "Decryption passphrase: " PASSPHRASE; echo
    fi
    # No minimum length here: a bundle encrypted before that rule existed must
    # still be restorable.
    [[ -z "$PASSPHRASE" ]] && { error "Bundle is encrypted; passphrase required"; exit 1; }
fi

WORK="$(mktemp -d)"
DATA_BUNDLE="$WORK/data.zip"
RESTORED_ENV="$WORK/restored.env"

info "${EMOJI_GEAR:-} Unpacking bundle ..."
BACKUP_PASSPHRASE="$PASSPHRASE" \
    npx ts-node "$SCRIPT_DIR/backup-bundle.ts" prepare-restore "$BUNDLE" "$DATA_BUNDLE" "$RESTORED_ENV"

# 1. Restore config: back up the current env file, install the restored one,
#    reload it, and recreate the secret with the restored values.
if [[ -f "$ENV_FILE" ]]; then
    # This snapshot is a full plaintext credential. Create it owner-only BEFORE
    # copying anything into it, so the secrets are never briefly world-readable.
    PRE_RESTORE="${ENV_FILE}.pre-restore.$(date +%s)"
    ( umask 077 && cp "$ENV_FILE" "$PRE_RESTORE" )
    chmod 600 "$PRE_RESTORE" 2>/dev/null || true
    info "Previous config saved to $(basename "$PRE_RESTORE") — delete it once the restore is verified."
fi
( umask 077 && cp "$RESTORED_ENV" "$ENV_FILE" )
chmod 600 "$ENV_FILE" 2>/dev/null || true
load_env_file "$ENV_FILE" "$NODE_ENV"

info "Recreating stella-ai-secrets from restored config ..."
create_secrets

info "Restarting backend to pick up restored secrets ..."
kubectl rollout restart deployment session-management-server -n "$KUBERNETES_NAMESPACE" >/dev/null 2>&1 || true
kubectl rollout status deployment session-management-server -n "$KUBERNETES_NAMESPACE" --timeout=300s

# 2. Restore data: copy the bundle into a fresh backend pod and import it.
#
# `rollout status` can return for the PRE-restart generation (the
# observedGeneration race: the controller may not have observed the restart's
# new generation yet), so at this instant there may be no stable pod. Wait for
# an actually-Ready pod, then select a Running one via a retry loop with a
# phase filter — never a Terminating/Pending pod, which kubectl cp/exec would
# fail against.
kubectl wait --for=condition=ready pod -l app=session-management-server \
    -n "$KUBERNETES_NAMESPACE" --timeout=300s >/dev/null 2>&1 || true

POD=""
for _ in $(seq 1 30); do
    POD="$(kubectl get pod -n "$KUBERNETES_NAMESPACE" -l app=session-management-server \
            --field-selector=status.phase=Running \
            -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
    [[ -n "$POD" ]] && break
    sleep 2
done
[[ -z "$POD" ]] && { error "No running backend pod after restart"; exit 1; }

POD_IN="/tmp/stella-restore-$(date +%s).zip"
kubectl cp "$DATA_BUNDLE" "$KUBERNETES_NAMESPACE/$POD:$POD_IN"

info "Importing data (overwriting) in pod $POD ..."
# Render the CLI's JSON report as a readable table (formatter runs host-side, so
# it works with any pod image). pipefail preserves the import's exit code.
kubectl exec -n "$KUBERNETES_NAMESPACE" "$POD" -- \
    node dist/src/backup/backup.cli.js import --in "$POD_IN" --confirm $ALLOW_KEY_MISMATCH \
    | node "$LIB_DIR/backup_report.js"
kubectl exec -n "$KUBERNETES_NAMESPACE" "$POD" -- rm -f "$POD_IN" 2>/dev/null || true

rm -rf "$WORK" 2>/dev/null || true
success "Restore complete. Verify login, projects, sessions, and agent packages."
