#!/usr/bin/env bash
#
# The deploy's internal key (#145) is created once and stays the same.
#
# The message recorder sends INTERNAL_API_KEY to the backend's internal
# monitoring endpoints; both pods read it from the stella-internal-key secret.
# Each deploy applies k8s/03-secrets.yaml and then create_secrets. If the key
# changed on a redeploy, pods that weren't restarted would hold the old one and
# the recorder's posts would be refused; if it came from the repo, every
# install would share a public key. This runs that sequence against a kubectl
# stub that keeps secrets in files (an apply replaces the whole secret, as
# kubectl's merge does for keys the last apply carried). Touches no cluster.
#
#   ./scripts/internal-key-secret-test.sh
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin" "$WORK/state"
cat > "$WORK/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
# get secret NAME: exists or not.
# create secret generic NAME --from-literal=k=v... [--dry-run=client -o yaml]:
#   with --dry-run prints "secret NAME" plus k=v lines, else stores them.
# apply -f FILE|-: stores a "secret NAME" document; a yaml Secret file is
#   reduced to its stringData keys.
store() { local name="$1"; shift; printf '%s\n' "$@" > "$STATE/$name"; }
case "$1 $2" in
    "get secret") [[ -f "$STATE/$3" ]] ;;
    "create secret")
        name="$4"; shift 4; lits=(); dry=0
        for a in "$@"; do
            case "$a" in --from-literal=*) lits+=("${a#--from-literal=}") ;; --dry-run=*) dry=1 ;; esac
        done
        if (( dry )); then printf 'secret %s\n' "$name"; printf '%s\n' "${lits[@]}"; else store "$name" "${lits[@]}"; fi ;;
    "apply -f")
        if [[ "$3" == - ]]; then doc="$(cat)"; else doc="$(cat "$3")"; fi
        if [[ "$doc" == "secret "* ]]; then
            name="$(head -1 <<<"$doc" | cut -d' ' -f2)"; store "$name" $(tail -n +2 <<<"$doc")
        elif grep -q '^kind: Secret' <<<"$doc"; then
            name="$(sed -n 's/^  name: //p' <<<"$doc" | head -1)"
            store "$name" $(awk '/^stringData:/{on=1;next} on && /^  [a-z]/{sub(/^  /,""); sub(/: /,"="); gsub(/"/,""); print}' <<<"$doc")
        fi ;;
esac
EOF
chmod +x "$WORK/bin/"*

# One deploy's secret steps, in deploy.sh's order.
deploy() {
    env -i HOME="$HOME" PATH="$WORK/bin:$PATH" STATE="$WORK/state" INTERNAL_API_KEY="$1" bash -c '
        set -e
        source "$1/scripts/lib/colors.sh"; source "$1/scripts/lib/utils.sh"; source "$1/scripts/lib/deploy.sh"
        trap - EXIT ERR
        KUBERNETES_NAMESPACE=test-ns VERBOSE_MODE=false DRY_RUN_MODE=false
        POSTGRES_USER=u POSTGRES_PASSWORD=p POSTGRES_DB=d OPENAI_API_KEY=x LIVEKIT_API_KEY=k LIVEKIT_API_SECRET=s
        kubectl apply -f "$1/k8s/03-secrets.yaml"
        create_secrets
    ' _ "$REPO" >/dev/null 2>&1
}
key() { sed -n 's/^internal-api-key=//p' "$WORK/state/stella-internal-key" 2>/dev/null; }

FAILED=0
check() {
    if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; FAILED=1; fi
}

check "03-secrets.yaml carries no internal key"            '! grep -q "internal-api-key:" "$REPO/k8s/03-secrets.yaml"'

deploy ""; k1="$(key)"
check "a fresh cluster gets a generated 64-hex key"         '[[ "$k1" =~ ^[0-9a-f]{64}$ ]]'
check "and it is not in stella-ai-secrets"                   '! grep -q internal-api-key "$WORK/state/stella-ai-secrets"'

deploy ""; k2="$(key)"
check "a redeploy keeps the same key"                       '[[ "$k2" == "$k1" ]]'

deploy "from-env"; k3="$(key)"
check "INTERNAL_API_KEY from .env sets it"                  '[[ "$k3" == from-env ]]'

rm -rf "$WORK/state"; mkdir "$WORK/state"; deploy ""; k4="$(key)"
check "another fresh cluster gets a different key"          '[[ "$k4" =~ ^[0-9a-f]{64}$ && "$k4" != "$k1" ]]'

exit $FAILED
