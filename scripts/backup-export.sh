#!/usr/bin/env bash
#
# Full-system backup export (#378) — wizard/deploy layer.
#
# Triggers the in-pod data export (database + agent packages), folds in this
# deployment's .env config, encrypts the whole bundle, and writes a single
# artifact you can carry to new hardware.
#
# The bundle embeds the deployment config, so it holds EVERY secret. Encryption
# is therefore ON BY DEFAULT; producing a plaintext bundle takes a deliberate
# --no-encrypt --allow-plaintext-config. Set BACKUP_PASSPHRASE to run unattended
# instead of being prompted.
#
#   ./scripts/backup-export.sh [--out FILE] [--include-metrics]
#                              [--production|--local]
#                              [--no-encrypt --allow-plaintext-config]
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

# This script runs on the deploy host and needs the same toolchain the STELLA
# wizard/deploy already requires. Fail fast with clear, actionable next steps.
require_host_tools() {
    local need_node="" need_kubectl=""
    { command -v node && command -v npx; } >/dev/null 2>&1 || need_node="1"
    command -v kubectl >/dev/null 2>&1 || need_kubectl="1"
    [[ -z "$need_node$need_kubectl" ]] && return 0

    error "Can't run the backup — required tools are missing on this machine."
    echo
    local mac=""; [[ "$(uname -s)" == "Darwin" ]] && mac="1"
    if [[ -n "$need_node" ]]; then
        echo -e "  ${RED:-}✗${NC:-} Node.js (provides 'node' and 'npx') — runs the backup helper that"
        echo -e "    packages the bundle and handles encryption."
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
# BEFORE the (slow) in-pod export runs. Compiling backup-bundle.ts exercises its
# whole toolchain — ts-node, typescript, and every import (archiver, yauzl,
# crypto) — so this catches the entire class of "host can't run the helper"
# problems (stale/missing node_modules, a production --omit=dev install without
# ts-node, a future added dependency) up front, with one real check instead of a
# hardcoded package list.
preflight_backup_helper() {
    local root; root="$(cd "$SCRIPT_DIR/.." && pwd)"
    # Verify ts-node/typescript resolve first so npx never tries to fetch them.
    ( cd "$root" && node -e "require.resolve('ts-node'); require.resolve('typescript')" ) >/dev/null 2>&1 \
        || backup_helper_unavailable "$root" "ts-node / typescript are not installed"
    # Load the real helper (the 'check' command does no work, just returns ok).
    local out
    out="$( cd "$root" && npx --no-install ts-node "$SCRIPT_DIR/backup-bundle.ts" check 2>&1 )" \
        || backup_helper_unavailable "$root" "the backup helper failed to load" "$out"
}
require_host_tools
preflight_backup_helper

# Ready replica count for a deployment (0 if absent/not ready).
deployment_ready() {
    local n
    n="$(kubectl get deploy "$1" -n "$KUBERNETES_NAMESPACE" \
            -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)"
    echo "${n:-0}"
}

OUT=""
INCLUDE_METRICS=""
ENCRYPT="true"          # the bundle carries every secret — encrypt unless told otherwise
ALLOW_PLAINTEXT=""
export ENV_FLAG=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --out) OUT="$2"; shift 2 ;;
        --include-metrics) INCLUDE_METRICS="--include-metrics"; shift ;;
        --encrypt) ENCRYPT="true"; shift ;;   # now the default; kept so old commands still work
        --no-encrypt) ENCRYPT=""; shift ;;
        --allow-plaintext-config) ALLOW_PLAINTEXT="true"; shift ;;
        --production) ENV_FLAG="production"; shift ;;
        --local) ENV_FLAG="local"; shift ;;
        -h|--help)
            echo "Usage: $0 [--out FILE] [--include-metrics] [--production|--local]"
            echo "          [--no-encrypt --allow-plaintext-config]"
            echo
            echo "The bundle embeds this deployment's .env, so it contains every secret."
            echo "Encryption is on by default; set BACKUP_PASSPHRASE to avoid the prompt."
            exit 0 ;;
        *) error "Unknown argument: $1"; exit 1 ;;
    esac
done

# Writing the config unencrypted takes two explicit flags, not one — so a single
# mistyped or copy-pasted flag can never silently produce a plaintext credential.
if [[ "$ENCRYPT" != "true" && "$ALLOW_PLAINTEXT" != "true" ]]; then
    error "Refusing to write an unencrypted backup."
    echo
    echo -e "  The bundle embeds this deployment's .env — ENV_VAR_ENCRYPTION_KEY, JWT_SECRET,"
    echo -e "  the database password and every API key. Unencrypted, it is a plaintext"
    echo -e "  credential for the whole system: anyone who reads the file owns the deployment."
    echo
    echo -e "  → Just drop --no-encrypt to get an encrypted bundle (recommended)."
    echo -e "  → If you truly need plaintext, add ${BOLD:-}--allow-plaintext-config${NC:-} as well,"
    echo -e "    and treat the resulting file exactly as you would the raw .env."
    exit 1
fi

setup_directories
set_defaults
load_environment

ENV_FILE="$PROJECT_DIR/.env.$([[ "$NODE_ENV" == "production" ]] && echo production || echo local)"
if [[ ! -f "$ENV_FILE" ]]; then
    error "Config file not found: $ENV_FILE (run the setup wizard first)"
    exit 1
fi

# Preflight: a backup is a LOGICAL export, so it needs a LIVE system — Postgres
# must be serving the database, and the export engine runs inside the backend
# pod. A wound-down deployment cannot be exported; warn clearly instead of
# failing with an obscure kubectl error.
PG_READY="$(deployment_ready postgres)"
BACKEND_READY="$(deployment_ready session-management-server)"
if [[ "${PG_READY:-0}" -lt 1 || "${BACKEND_READY:-0}" -lt 1 ]]; then
    error "The deployment is not running — export needs a live system."
    echo
    echo -e "  A backup is a logical export: the database must be served by a running"
    echo -e "  Postgres, and the export engine runs in the backend pod. (The agent"
    echo -e "  packages and config are just files, but the database is not.)"
    echo
    echo -e "  Status in namespace '$KUBERNETES_NAMESPACE':"
    echo -e "    Postgres (database) : $([[ "${PG_READY:-0}" -ge 1 ]] && echo running || echo 'NOT running')"
    echo -e "    Backend (engine)    : $([[ "${BACKEND_READY:-0}" -ge 1 ]] && echo running || echo 'NOT running')"
    echo
    echo -e "  Bring the system up first (e.g. ./scripts/start-k8s.sh${ENV_FLAG:+ --$ENV_FLAG}),"
    echo -e "  or scale these deployments up, then re-run the export. A fully"
    echo -e "  wound-down deployment cannot be exported."
    exit 1
fi

# Resolve the running backend pod (only the pod can see both DB and packages).
POD="$(kubectl get pod -n "$KUBERNETES_NAMESPACE" -l app=session-management-server \
        --field-selector=status.phase=Running \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
if [[ -z "$POD" ]]; then
    error "No running backend pod found in namespace '$KUBERNETES_NAMESPACE'. Deploy first."
    exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
[[ -z "$OUT" ]] && OUT="$PROJECT_DIR/stella-backup-${STAMP}.zip"

# The passphrase is the bundle's entire key strength: scrypt slows a guess down,
# but a short passphrase is still brute-forceable offline by anyone holding the
# file. Enforced on export only — restoring an older bundle must never be blocked
# by a rule introduced after it was written.
MIN_PASSPHRASE_LEN=12

PASSPHRASE=""
if [[ "$ENCRYPT" == "true" ]]; then
    if [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
        # Unattended path (CI/automation): take the passphrase from the
        # environment rather than blocking on a prompt nobody is there to answer.
        PASSPHRASE="$BACKUP_PASSPHRASE"
    elif [[ ! -t 0 ]]; then
        # No terminal to prompt on. Without this, `read` hits EOF and set -e
        # aborts the script with no explanation at all.
        error "No terminal available to prompt for a passphrase."
        echo
        echo -e "  This looks like a non-interactive run (CI, cron, a pipe)."
        echo -e "  → Set ${BOLD:-}BACKUP_PASSPHRASE${NC:-} in the environment and re-run."
        exit 1
    else
        read -r -s -p "Encryption passphrase: " PASSPHRASE; echo
        read -r -s -p "Confirm passphrase: " PASSPHRASE2; echo
        [[ "$PASSPHRASE" != "$PASSPHRASE2" ]] && { error "Passphrases do not match"; exit 1; }
    fi
    [[ -z "$PASSPHRASE" ]] && { error "Empty passphrase"; exit 1; }
    if [[ "${#PASSPHRASE}" -lt "$MIN_PASSPHRASE_LEN" ]]; then
        error "Passphrase too short (${#PASSPHRASE} characters, minimum $MIN_PASSPHRASE_LEN)."
        echo
        echo -e "  The passphrase is the only thing protecting a file that contains every"
        echo -e "  secret in the deployment. A short one is cracked offline in minutes."
        echo -e "  → Use a long passphrase — several random words beats a short complex string."
        exit 1
    fi
    [[ "$OUT" != *.enc ]] && OUT="${OUT}.enc"
fi

POD_DATA="/tmp/stella-backup-data-${STAMP}.zip"
LOCAL_DATA="$(mktemp -d)/data.zip"

info "${EMOJI_GEAR:-} Exporting data from pod $POD ..."
kubectl exec -n "$KUBERNETES_NAMESPACE" "$POD" -- \
    node dist/src/backup/backup.cli.js export --out "$POD_DATA" $INCLUDE_METRICS

kubectl cp "$KUBERNETES_NAMESPACE/$POD:$POD_DATA" "$LOCAL_DATA"
kubectl exec -n "$KUBERNETES_NAMESPACE" "$POD" -- rm -f "$POD_DATA" 2>/dev/null || true

info "Embedding deployment config${PASSPHRASE:+ and encrypting} ..."
BACKUP_PASSPHRASE="$PASSPHRASE" \
STELLA_ALLOW_PLAINTEXT_CONFIG="${ALLOW_PLAINTEXT:+1}" \
    npx ts-node "$SCRIPT_DIR/backup-bundle.ts" finalize "$LOCAL_DATA" "$ENV_FILE" "$OUT"

rm -f "$LOCAL_DATA" 2>/dev/null || true
success "Backup written: $OUT"
if [[ -n "$PASSPHRASE" ]]; then
    echo -e "  ${DIM:-}Encrypted. Keep the passphrase somewhere other than the bundle —${NC:-}"
    echo -e "  ${DIM:-}without it the backup cannot be restored.${NC:-}"
else
    warning "This bundle is UNENCRYPTED and contains every secret in plaintext."
    echo -e "  ${DIM:-}Treat it exactly as you would the raw .env: never email/upload it,${NC:-}"
    echo -e "  ${DIM:-}and delete it as soon as the restore is done.${NC:-}"
fi
