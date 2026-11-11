#!/usr/bin/env bash
#
# The deploy waits for tts-service as long as its own startupProbe allows (#151),
# and still fails for one that never becomes ready.
#
# wait_for_services gave tts-service 300 s, while its startupProbe in
# k8s/09-tts-service.yaml lets a cold Qwen3 load take up to 10 min. A cold
# production load took 366 s: the pod came Ready with no restarts, but the
# deploy had already gone red. The wait now comes from the manifest, so the two
# cannot drift apart again. This runs the real function with kubectl replaced
# by a stub that reads the --timeout it was given. Touches no cluster.
#
#   ./scripts/tts-wait-test.sh
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin"
# kubectl rollout status: ready when the service's start-up time fits the wait.
cat > "$WORK/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
timeout=""
for arg in "$@"; do
    case "$arg" in --timeout=*) timeout="${arg#--timeout=}"; timeout="${timeout%s}" ;; esac
done
echo "$timeout" > "$TIMEOUT_SEEN"
[[ "$SERVICE_NEEDS" == never ]] && exit 1
(( timeout >= SERVICE_NEEDS )) || exit 1
EOF
chmod +x "$WORK/bin/"*

run_wait() {
    env -i HOME="$HOME" PATH="$WORK/bin:$PATH" SERVICE_NEEDS="$2" TIMEOUT_SEEN="$WORK/timeout" bash -c '
        set -e
        cd /
        source "$1/scripts/lib/colors.sh"; source "$1/scripts/lib/utils.sh"; source "$1/scripts/lib/deploy.sh"
        trap - EXIT ERR
        KUBERNETES_NAMESPACE=test-ns VERBOSE_MODE=false
        SERVICES_TO_WAIT="$2"
        wait_for_services
    ' _ "$REPO" "$1" 2>&1
}

probe_budget() {
    # periodSeconds x failureThreshold of the startupProbe in a manifest, read independently of deploy.sh.
    local f="$REPO/k8s/$1"
    local p t
    local block
    block=$(sed -n '/startupProbe:/,/readinessProbe:/p' "$f")
    p=$(grep -m1 'periodSeconds:' <<<"$block" | awk '{print $2}')
    t=$(grep -m1 'failureThreshold:' <<<"$block" | awk '{print $2}')
    (( p > 0 && t > 0 )) || { echo 999999; return; }
    echo $(( p * t ))
}

FAILED=0
check() {
    if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; FAILED=1; fi
}

out="$(run_wait tts-service 366)"; rc=$?
seen=$(cat "$WORK/timeout")
check "a cold TTS load of 366 s ends green"               '[[ $rc -eq 0 ]]'
check "the TTS wait covers its startupProbe budget"       '(( seen >= $(probe_budget 09-tts-service.yaml) ))'
check "the log says how long TTS took"                    'sed "s/\x1b\[[0-9;]*[mK]//g" <<<"$out" | grep -qE "TTS Service.*[0-9]+ s"'

out2="$(run_wait tts-service never)"; rc2=$?
check "a TTS that never starts still fails"               '[[ $rc2 -ne 0 ]] && grep -q "failed readiness checks: tts-service" <<<"$out2"'

run_wait stt-service never >/dev/null; seen=$(cat "$WORK/timeout")
check "the STT wait covers its startupProbe budget"       '(( seen >= $(probe_budget 08-stt-service.yaml) ))'

run_wait session-management-server never >/dev/null; seen=$(cat "$WORK/timeout")
check "the backend keeps its longer migration wait"       '(( seen == 600 ))'

if [[ $FAILED -ne 0 ]]; then
    echo "--- output ---"
    sed 's/\x1b\[[0-9;]*[mK]//g' <<<"$out" | tail -5
    echo "--- never-ready run ---"
    sed 's/\x1b\[[0-9;]*[mK]//g' <<<"$out2" | tail -5
fi
exit "$FAILED"
