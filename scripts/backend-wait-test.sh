#!/usr/bin/env bash
#
# The deploy waits long enough for a slow but healthy backend (#105), and still
# fails for one that never becomes ready.
#
# wait_for_services gave session-management-server 180 s. On a full deploy the
# backend runs its migrations and then has to pass its probes, which sometimes
# took longer: the deploy ended red although the backend came up shortly after.
# This runs the real function with kubectl replaced by a stub that reads the
# --timeout it was given: a backend that needs 240 s is ready only if the wait
# is at least that long, and a broken one never is. Touches no cluster.
#
#   ./scripts/backend-wait-test.sh
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin"
# kubectl rollout status: ready when the backend's start-up time fits the wait.
cat > "$WORK/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
timeout=""
for arg in "$@"; do
    case "$arg" in --timeout=*) timeout="${arg#--timeout=}"; timeout="${timeout%s}" ;; esac
done
[[ "$BACKEND_NEEDS" == never ]] && exit 1
(( timeout >= BACKEND_NEEDS )) || exit 1
EOF
chmod +x "$WORK/bin/"*

run_wait() {
    env -i HOME="$HOME" PATH="$WORK/bin:$PATH" BACKEND_NEEDS="$1" bash -c '
        set -e
        source "$1/scripts/lib/colors.sh"; source "$1/scripts/lib/utils.sh"; source "$1/scripts/lib/deploy.sh"
        trap - EXIT ERR
        KUBERNETES_NAMESPACE=test-ns VERBOSE_MODE=false
        SERVICES_TO_WAIT="session-management-server"
        wait_for_services
    ' _ "$REPO" 2>&1
}

FAILED=0
check() {
    if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; FAILED=1; fi
}

out="$(run_wait 240)"; rc=$?
check "a backend ready after 240 s ends green"     '[[ $rc -eq 0 ]]'

out2="$(run_wait never)"; rc2=$?
check "a backend that never starts still fails"    '[[ $rc2 -ne 0 ]] && grep -q "failed readiness checks: session-management-server" <<<"$out2"'

if [[ $FAILED -ne 0 ]]; then
    echo "--- output ---"
    sed 's/\x1b\[[0-9;]*[mK]//g' <<<"$out" | tail -5
    echo "--- never-ready run ---"
    sed 's/\x1b\[[0-9;]*[mK]//g' <<<"$out2" | tail -5
fi
exit "$FAILED"
