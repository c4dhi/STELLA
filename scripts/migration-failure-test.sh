#!/usr/bin/env bash
#
# A failed database migration says why and cleans up after itself (#735).
#
# run_database_migrations ran `wait $migration_pid` under `set -e`, so a failed
# `prisma migrate deploy` ended the deploy on the spot: no Prisma output, no
# diagnostics, and the port-forward to Postgres left running, so the next
# deploy failed with "Port ... already in use". This runs the real function
# with npx, kubectl and nc replaced by stubs: npx fails like Prisma does,
# kubectl stands in for the port-forward. Touches no cluster.
#
#   ./scripts/migration-failure-test.sh
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'pkill -f "$WORK/bin/kubectl" 2>/dev/null; rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin" "$WORK/project/node_modules/prisma"
# Prisma: fail the way an unreachable or broken database does.
cat > "$WORK/bin/npx" <<EOF
#!/usr/bin/env bash
echo "Error: P1001: Can't reach database server at \\\`localhost:5533\\\`"
exit 1
EOF
# kubectl port-forward: stay alive until killed, and record that it started.
cat > "$WORK/bin/kubectl" <<EOF
#!/usr/bin/env bash
touch "$WORK/forward-started"
while :; do sleep 1; done
EOF
# nc -z: the port is open while a port-forward stub is running.
cat > "$WORK/bin/nc" <<EOF
#!/usr/bin/env bash
pgrep -f "$WORK/bin/kubectl" >/dev/null
EOF
chmod +x "$WORK/bin/"*

out="$(env -i HOME="$HOME" PATH="$WORK/bin:$PATH" bash -c '
    set -e
    source "$1/scripts/lib/colors.sh"; source "$1/scripts/lib/utils.sh"; source "$1/scripts/lib/deploy.sh"
    trap - EXIT ERR
    PROJECT_DIR="$2"; KUBERNETES_NAMESPACE=test-ns; PG_LOCAL_PORT=5533
    POSTGRES_USER=u POSTGRES_PASSWORD=p POSTGRES_DB=d DRY_RUN_MODE=false VERBOSE_MODE=false
    MIGRATION_RETRY_DELAY=0
    run_database_migrations
' _ "$REPO" "$WORK/project" 2>&1)"
rc=$?

FAILED=0
check() {
    if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; FAILED=1; fi
}
check "the deploy stops with an error"            '[[ $rc -ne 0 ]]'
check "Prisma's error is printed"                 'grep -q "P1001" <<<"$out"'
check "the diagnostic report is printed"          'grep -q "MIGRATION DIAGNOSTIC REPORT" <<<"$out"'
check "the port-forward is gone afterwards"       '! pgrep -f "$WORK/bin/kubectl" >/dev/null'

# A database that refuses connections once, then accepts: the deploy goes on.
rm -f "$WORK/forward-started"
cat > "$WORK/bin/npx" <<EOF
#!/usr/bin/env bash
if [[ ! -f "$WORK/refused-once" ]]; then
    touch "$WORK/refused-once"
    echo "Error: P1001: Can't reach database server"
    exit 1
fi
echo "Applying migration 20260101000000_x"
EOF
out2="$(env -i HOME="$HOME" PATH="$WORK/bin:$PATH" bash -c '
    set -e
    source "$1/scripts/lib/colors.sh"; source "$1/scripts/lib/utils.sh"; source "$1/scripts/lib/deploy.sh"
    trap - EXIT ERR
    PROJECT_DIR="$2"; KUBERNETES_NAMESPACE=test-ns; PG_LOCAL_PORT=5533
    POSTGRES_USER=u POSTGRES_PASSWORD=p POSTGRES_DB=d DRY_RUN_MODE=false VERBOSE_MODE=false
    MIGRATION_RETRY_DELAY=0
    run_database_migrations
' _ "$REPO" "$WORK/project" 2>&1)"
rc2=$?
check "a database not ready yet is retried"      '[[ $rc2 -eq 0 ]] && grep -q "waiting for the database" <<<"$out2"'
check "the port-forward is gone after success"   '! pgrep -f "$WORK/bin/kubectl" >/dev/null'

if [[ $FAILED -ne 0 ]]; then
    echo "--- output ---"
    sed 's/\x1b\[[0-9;]*[mK]//g' <<<"$out" | tail -15
    echo "--- retry run ---"
    sed 's/\x1b\[[0-9;]*[mK]//g' <<<"${out2:-}" | tail -10
fi
exit "$FAILED"
