#!/usr/bin/env bash
#
# Stopping the instance also ends its port-forward loops (#737).
#
# `start-k8s.sh -d` starts one detached loop per service that restarts
# `kubectl port-forward` whenever it dies. `--stop` looked for a pid file that
# nothing writes, and `port-forward-daemon.sh stop` gave up after the first
# loop, so the loops lived on and kept 8080/3000/5432 busy. They also ignored
# SIGTERM until their current kubectl or sleep returned.
#
# Runs the real daemon and the real stop_services with kubectl replaced by a
# stub that stays up like a port-forward. Touches no cluster.
#
#   ./scripts/port-forward-stop-test.sh
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
NS="pf-stop-test-$$"
cleanup() {
    for port in 18080 13000 15432; do pkill -9 -f "_forward-loop [a-z-]* $port " 2>/dev/null; done
    pkill -f "$WORK/bin/kubectl" 2>/dev/null
    rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/bin" "$WORK/tmp"
# kubectl: a port-forward stays up until killed; anything else succeeds.
cat > "$WORK/bin/kubectl" <<EOF
#!/usr/bin/env bash
[[ "\$*" == *port-forward* ]] && while :; do sleep 1; done
exit 0
EOF
# setsid is not on every Mac's PATH; stand in for it where it is missing.
if ! command -v setsid >/dev/null 2>&1; then
    printf '#!/usr/bin/env bash\nexec "$@"\n' > "$WORK/bin/setsid"
fi
chmod +x "$WORK/bin/"*

FAILED=0
check() {
    if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; FAILED=1; fi
}
# A forward is the kubectl stub running; a loop is a daemon loop on our ports.
running()  { pgrep -f "$WORK/bin/kubectl" >/dev/null; }

# Each case: start the daemon detached in its own namespace, then stop it.
start_daemon() {
    env -i HOME="$HOME" PATH="$WORK/bin:$PATH" KUBERNETES_NAMESPACE="$NS" STELLA_AI_TEMP_DIR="$WORK/tmp" \
        FRONTEND_PORT=18080 BACKEND_PORT=13000 POSTGRES_PORT=15432 \
        "$REPO/scripts/port-forward-daemon.sh" start -d >/dev/null 2>&1
    for _ in $(seq 1 20); do [[ $(pgrep -f "$WORK/bin/kubectl" | wc -l) -ge 3 ]] && break; sleep 0.2; done
}
daemon_loops() { for port in 18080 13000 15432; do pgrep -f "_forward-loop [a-z-]* $port "; done; }

start_daemon
check "daemon start -d brings up three forwards" '[[ $(pgrep -f "$WORK/bin/kubectl" | wc -l) -ge 3 ]]'
env -i HOME="$HOME" PATH="$WORK/bin:$PATH" KUBERNETES_NAMESPACE="$NS" STELLA_AI_TEMP_DIR="$WORK/tmp" \
    "$REPO/scripts/port-forward-daemon.sh" stop >/dev/null 2>&1
sleep 3
check "daemon stop ends every loop"           '[[ -z "$(daemon_loops)" ]]'
check "daemon stop ends every forward"        '! running'

start_daemon
env -i HOME="$HOME" PATH="$WORK/bin:$PATH" bash -c '
    source "$1/scripts/lib/colors.sh"; source "$1/scripts/lib/utils.sh"
    source "$1/scripts/lib/environment.sh"; source "$1/scripts/lib/k3s.sh"
    trap - EXIT ERR
    export KUBERNETES_NAMESPACE="$2" STELLA_AI_TEMP_DIR="$3"
    configure_temp_dirs "$3"
    SCRIPT_DIR="$1/scripts"
    stop_services
' _ "$REPO" "$NS" "$WORK/tmp" >/dev/null 2>&1
sleep 3
check "start-k8s --stop ends every loop"      '[[ -z "$(daemon_loops)" ]]'
check "start-k8s --stop ends every forward"   '! running'

# A plain SIGTERM to a loop ends it and its forward, without waiting for the
# forward to die first.
pkill -9 -f "$WORK/bin/kubectl" 2>/dev/null; for port in 18080 13000 15432; do pkill -9 -f "_forward-loop [a-z-]* $port " 2>/dev/null; done
start_daemon
kill -TERM $(daemon_loops) 2>/dev/null
sleep 2
check "SIGTERM ends a loop within 2 s"         '[[ -z "$(daemon_loops)" ]]'
check "SIGTERM ends its forward too"           '! running'

# Loops started before this fix kept their pid file under
# ${STELLA_AI_TEMP_DIR:-/tmp}, while start-k8s now hands the daemon its own
# PID_DIR (under STELLA_DATA_ROOT on a server). The first stop after the update
# must still find them, or they fight the new loops for the ports.
pkill -9 -f "$WORK/bin/kubectl" 2>/dev/null; for port in 18080 13000 15432; do pkill -9 -f "_forward-loop [a-z-]* $port " 2>/dev/null; done
start_daemon   # no PID_DIR: the pid file lands in the legacy place
mkdir -p "$WORK/data-root-pids"
env -i HOME="$HOME" PATH="$WORK/bin:$PATH" KUBERNETES_NAMESPACE="$NS" STELLA_AI_TEMP_DIR="$WORK/tmp" \
    PID_DIR="$WORK/data-root-pids" "$REPO/scripts/port-forward-daemon.sh" stop >/dev/null 2>&1
sleep 3
check "stop also ends loops from the old pid dir" '[[ -z "$(daemon_loops)" ]]'
check "stop also ends their forwards"             '! running'

exit "$FAILED"
