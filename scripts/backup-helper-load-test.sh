#!/usr/bin/env bash
#
# The backup scripts can load their host-side helper on a fresh install (#730).
#
# backup-export.sh and backup-restore.sh run scripts/backup-bundle.ts on the
# host. Since the backend moved to ESM, plain `npx ts-node` cannot load it
# ("Cannot find module src/backup/bundle-crypto.js" on Node 22+, "Unknown file
# extension .ts" on Node 20), so `start-k8s.sh --backup` stopped before doing
# anything. This runs both scripts against a temp copy of the project, pointed
# at a namespace that does not exist, and checks they get past the helper
# preflight to their first cluster check:
#
#   - export stops at "the deployment is not running",
#   - restore loads the bundle helper, asks to confirm, and aborts on "no".
#
# Reads the cluster (kubectl get) and writes nothing to it. Needs kubectl, node
# and this checkout's node_modules (`npm ci`).
#
#   ./scripts/backup-helper-load-test.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

NS="stella-backup-helper-test-$$"
P="$WORK/project"
mkdir -p "$P/src"
cp -R "$REPO/scripts" "$P/scripts"
cp -R "$REPO/src/backup" "$P/src/backup"
cp "$REPO/package.json" "$REPO/tsconfig.json" "$P/"
ln -s "$REPO/node_modules" "$P/node_modules"
printf 'KUBERNETES_NAMESPACE=%s\nSTELLA_AI_TEMP_DIR=%s/tmp\n' "$NS" "$WORK" > "$P/.env.local"
: > "$WORK/empty-bundle.zip.enc"

FAILED=0
check() {
    local name="$1" want="$2" out="$3"
    if grep -q "failed to load\|not installed" <<<"$out"; then
        echo "FAIL $name: helper did not load"
        sed 's/^/     /' <<<"$out" | grep -v '^ *$' | tail -6
        FAILED=1
    elif grep -q "$want" <<<"$out"; then
        echo "ok   $name"
    else
        echo "FAIL $name: no '$want' in output"
        sed 's/^/     /' <<<"$out" | grep -v '^ *$' | tail -6
        FAILED=1
    fi
}

out="$("$P/scripts/backup-export.sh" --local 2>&1 || true)"
check "export loads the helper" "not running" "$out"

out="$(echo no | "$P/scripts/backup-restore.sh" --local --in "$WORK/empty-bundle.zip.enc" 2>&1 || true)"
check "restore loads the helper" "Aborted" "$out"

exit "$FAILED"
