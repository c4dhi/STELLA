#!/usr/bin/env bash
#
# --reset-db finishes instead of hanging (#734).
#
# The reset deleted the pods and then the PVCs, but the deployments recreated
# the pods at once, the new pods held the volumes, and `kubectl delete pvc`
# waited for ever. Runs the real cleanup_for_rebuild against a kubectl stub
# that behaves like that: deleting a PVC hangs while the deployments are
# scaled up. Touches no cluster and no Docker images (docker is stubbed too).
#
#   ./scripts/reset-db-test.sh
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'pkill -f "$WORK/bin/" 2>/dev/null; rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin"
cat > "$WORK/bin/kubectl" <<EOF
#!/usr/bin/env bash
echo "kubectl \$*" >> "$WORK/calls.log"
case "\$*" in
    *"scale deploy"*"--replicas=0"*) touch "$WORK/scaled-down" ;;
    *"delete pvc"*)
        # A PVC in use is never deleted: wait until its pods are gone.
        while [[ ! -f "$WORK/scaled-down" ]]; do sleep 1; done ;;
esac
exit 0
EOF
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/docker"
chmod +x "$WORK/bin/"*

env -i HOME="$HOME" PATH="$WORK/bin:$PATH" bash -c '
    source "$1/scripts/lib/colors.sh"; source "$1/scripts/lib/utils.sh"
    source "$1/scripts/lib/environment.sh"; source "$1/scripts/lib/build.sh"
    trap - EXIT ERR
    KUBERNETES_NAMESPACE=reset-test RESET_DB_MODE=true DRY_RUN_MODE=false VERBOSE_MODE=false
    IMAGE_TAG=reset-test OS_TYPE=macos CHECKSUM_DIR="$2/checksums"
    get_all_image_names() { echo ""; }
    set -e
    cleanup_for_rebuild
    touch "$2/returned-ok"
' _ "$REPO" "$WORK" >/dev/null 2>&1 &
pid=$!
for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done

FAILED=0
check() {
    if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; FAILED=1; fi
}
check "the reset finishes within 30 s"             '! kill -0 "$pid" 2>/dev/null'
check "deployments are scaled to 0 before the PVCs" \
    'grep -n "" "$WORK/calls.log" | awk "/scale deploy.*replicas=0/{s=NR} /delete pvc/{d=NR} END{exit !(s && d && s<d)}"'
check "the PVC delete has a timeout"                'grep -q "delete pvc.*--timeout" "$WORK/calls.log"'
# Without --verbose its last line, `[[ $VERBOSE_MODE == true ]] && echo ...`,
# returned 1, and under set -e every --rebuild and --reset-db died right after.
check "it returns success under set -e"            '[[ -f "$WORK/returned-ok" ]]'

if [[ $FAILED -ne 0 ]]; then echo "--- kubectl calls ---"; cat "$WORK/calls.log" 2>/dev/null; fi
kill "$pid" 2>/dev/null
exit "$FAILED"
