#!/usr/bin/env bash
#
# --stop and the stop half of --restart act on the namespace the env file
# names (#736).
#
# They used to run before the env file was read, so without --namespace they
# always scaled down ai-agents. Runs start-k8s.sh's real main against a
# throwaway project whose .env.local names another namespace, with kubectl
# replaced by a stub that only records its arguments. Touches no cluster.
#
#   ./scripts/stop-namespace-test.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

P="$WORK/project"
mkdir -p "$P/scripts" "$WORK/bin"
cp -R "$REPO/scripts/lib" "$P/scripts/lib"
cp "$REPO/scripts/start-k8s.sh" "$P/scripts/start-k8s.sh"
printf 'KUBERNETES_NAMESPACE=ai-agents-check\nSTELLA_AI_TEMP_DIR=%s/tmp\n' "$WORK" > "$P/.env.local"
printf '#!/usr/bin/env bash\necho "kubectl $*" >> "%s/kubectl.log"\n' "$WORK" > "$WORK/bin/kubectl"
chmod +x "$WORK/bin/kubectl"

FAILED=0
check() {
    local name="$1" want="$2" got="$3"
    if [[ "$got" == "$want" ]]; then
        echo "ok   $name"
    else
        echo "FAIL $name: want '$want', got '$got'"
        FAILED=1
    fi
}

# Namespaces the stub kubectl was asked to scale, de-duplicated.
scaled_namespaces() {
    grep -o 'scale deployment [^ ]* -n [^ ]*' "$WORK/kubectl.log" 2>/dev/null | awk '{print $5}' | sort -u | tr '\n' ' ' | sed 's/ $//'
}

run_stop() {
    rm -f "$WORK/kubectl.log"
    env -i HOME="$HOME" PATH="$WORK/bin:$PATH" bash "$P/scripts/start-k8s.sh" --local "$@" >/dev/null 2>&1 || true
    scaled_namespaces
}

# --restart goes on to deploy after stopping, so stop_services is swapped for
# one that records the namespace and exits.
restart_namespace() {
    env -i HOME="$HOME" PATH="$WORK/bin:$PATH" bash -c '
        source "$1/scripts/start-k8s.sh"; shift
        trap - EXIT ERR
        stop_services() { echo "${KUBERNETES_NAMESPACE:-ai-agents}"; exit 0; }
        main "$@"
    ' _ "$P" --local "$@" 2>/dev/null | tail -1
}

check "--stop uses the env file's namespace"    "ai-agents-check" "$(run_stop --stop)"
check "--stop --namespace still wins"           "ai-agents-other" "$(run_stop --stop --namespace ai-agents-other)"
check "--restart stops the env file's namespace" "ai-agents-check" "$(restart_namespace --restart)"

exit "$FAILED"
