#!/usr/bin/env bash
#
# The deploy's internal key (#145) stays the same across redeploys.
#
# The message recorder sends INTERNAL_API_KEY to the backend's internal
# monitoring endpoints, and both pods read it from the stella-ai-secrets secret.
# If a redeploy made a new key, pods that weren't restarted would hold the old
# one and the recorder's logs would be refused. create_secrets takes the key
# from .env, else keeps the one already in the cluster, else generates one.
# This runs the real function with kubectl replaced by a stub. Touches no cluster.
#
#   ./scripts/internal-key-secret-test.sh
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin"
# kubectl get secret: prints the cluster's internal-api-key (base64) if EXISTING is set.
# kubectl create secret ... --dry-run: records its arguments.
# kubectl apply: swallows the yaml.
cat > "$WORK/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
    "get secret")
        [[ -n "${EXISTING:-}" ]] || exit 1
        printf '%s' "$EXISTING" | base64 ;;
    "create secret") printf '%s\n' "$@" > "$CREATED" ;;
    *) cat >/dev/null ;;
esac
EOF
chmod +x "$WORK/bin/"*

# Prints the internal-api-key the deploy put in the secret.
run_create() {
    env -i HOME="$HOME" PATH="$WORK/bin:$PATH" CREATED="$WORK/created" EXISTING="$2" INTERNAL_API_KEY="$1" bash -c '
        set -e
        source "$1/scripts/lib/colors.sh"; source "$1/scripts/lib/utils.sh"; source "$1/scripts/lib/deploy.sh"
        trap - EXIT ERR
        KUBERNETES_NAMESPACE=test-ns VERBOSE_MODE=false DRY_RUN_MODE=false
        POSTGRES_USER=u POSTGRES_PASSWORD=p POSTGRES_DB=d OPENAI_API_KEY=x LIVEKIT_API_KEY=k LIVEKIT_API_SECRET=s
        create_secrets
    ' _ "$REPO" >/dev/null 2>&1
    sed -n 's/^--from-literal=internal-api-key=//p' "$WORK/created"
}

FAILED=0
check() {
    if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; FAILED=1; fi
}

k="$(run_create "from-env" "in-cluster")"
check "INTERNAL_API_KEY from .env wins"                 '[[ "$k" == from-env ]]'

k="$(run_create "" "in-cluster")"
check "unset: the key already in the cluster is kept"   '[[ "$k" == in-cluster ]]'

k="$(run_create "" "")"
check "unset and none in the cluster: one is generated" '[[ "$k" =~ ^[0-9a-f]{64}$ ]]'

k2="$(run_create "" "")"
check "and two fresh clusters get different keys"       '[[ "$k2" =~ ^[0-9a-f]{64}$ && "$k2" != "$k" ]]'

exit $FAILED
