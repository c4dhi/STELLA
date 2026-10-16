#!/usr/bin/env bash
#
# --namespace and --port-offset win over the env file (#729).
#
# start-k8s.sh parses its flags and then sources .env.local / .env.production,
# and the config wizard writes KUBERNETES_NAMESPACE into that file. Before the
# fix the file silently replaced the flag, so `--namespace X` deployed, stopped
# and restored into `ai-agents`. The backup scripts run load_environment again
# in their own process, so the flag has to survive that too.
#
# Runs the real scripts/lib against a throwaway project dir with its own env
# file. Touches no cluster and nothing outside its temp dir.
#
#   ./scripts/namespace-flag-test.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/project/scripts"
cp -R "$REPO/scripts/lib" "$WORK/project/scripts/lib"
cp "$REPO/scripts/start-k8s.sh" "$WORK/project/scripts/start-k8s.sh"
printf 'KUBERNETES_NAMESPACE=ai-agents\nSTELLA_AI_TEMP_DIR=%s/tmp\n' "$WORK" > "$WORK/project/.env.local"

FAILED=0

# Load the environment the way start-k8s.sh and the backup scripts do, then
# print the namespace and frontend port it ended up with. Arguments are
# start-k8s.sh flags, parsed by start-k8s.sh's own parse_args.
resolve() {
    env -i HOME="$HOME" PATH="$PATH" CHILD="${CHILD:-}" bash -c '
        lib="$1"; shift
        source "$lib/../start-k8s.sh"
        trap - EXIT ERR
        parse_args --local "$@"
        detect_environment
        load_environment >/dev/null
        if [[ "${CHILD:-}" == "1" ]]; then
            # backup-export.sh / backup-restore.sh: a new process that loads
            # the environment again, in the order those scripts do.
            bash -c "source \"$lib/colors.sh\"; source \"$lib/utils.sh\"; source \"$lib/environment.sh\"; setup_directories; set_defaults >/dev/null; load_environment >/dev/null; echo \"\$KUBERNETES_NAMESPACE \$FRONTEND_PORT\""
        else
            echo "$KUBERNETES_NAMESPACE $FRONTEND_PORT"
        fi
    ' _ "$WORK/project/scripts/lib" "$@" 2>&1 | tail -1
}

check() {
    local name="$1" want="$2" got="$3"
    if [[ "$got" == "$want" ]]; then
        echo "ok   $name"
    else
        echo "FAIL $name: want '$want', got '$got'"
        FAILED=1
    fi
}

check "no flag: env file namespace"         "ai-agents 8080"        "$(resolve)"
check "--namespace beats the env file"      "ai-agents-check 8180"  "$(resolve --namespace ai-agents-check)"
check "--port-offset beats the default"     "ai-agents-check 8380"  "$(resolve --namespace ai-agents-check --port-offset 300)"
check "flag survives a backup subprocess"   "ai-agents-check 8180"  "$(CHILD=1 resolve --namespace ai-agents-check)"

exit "$FAILED"
