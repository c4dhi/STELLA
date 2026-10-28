#!/usr/bin/env bash
#
# Deploys keep only the running image and the one before it, and the build
# cache stays bounded (#780).
#
# CI exports a unique IMAGE_TAG per run, and nothing ever removed an older
# one: every release since 0.3.0 stayed on disk, 94 images / 254GB on
# production. This retags a tiny real image under a disposable repo name
# (get_all_image_names is overridden to return only that name) and drives
# snapshot_previous_image_tags / prune_old_image_generations through several
# simulated deploy generations, on real Docker, including a second simulated
# namespace sharing the same image name (review round 1's regression: a
# sweep over every tag on the repo took another namespace's running image
# with it). Touches no cluster, no real Stella image, and removes everything
# it creates.
#
#   ./scripts/image-retention-test.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAKE_REPO="stella-image-retention-test-fake"
CHECKSUM_DIR="$(mktemp -d)"
export CHECKSUM_DIR
export OS_TYPE="${OS_TYPE:-macos}"
export DRY_RUN_MODE="false"

# Stand-ins for the logging helpers build.sh expects from colors.sh.
info() { :; }; success() { :; }; warning() { echo "[warn] $*"; }; error() { echo "[error] $*"; }; verbose() { :; }

# shellcheck disable=SC1091
source "$REPO/scripts/lib/build.sh"

# Only this fake repo, never the real fleet.
get_all_image_names() { echo "$FAKE_REPO"; }

FAILED=0

cleanup() {
    # shellcheck disable=SC2046
    docker rmi $(docker images "$FAKE_REPO" --format '{{.Repository}}:{{.Tag}}' 2>/dev/null) >/dev/null 2>&1 || true
    rm -rf "$CHECKSUM_DIR"
}
trap cleanup EXIT

docker pull -q alpine:3.20 >/dev/null 2>&1 || true

tags_now() {
    docker images "$FAKE_REPO" --format '{{.Tag}}' 2>/dev/null | sort | tr '\n' ' ' | sed 's/ *$//'
}

check() {
    local name="$1" want="$2" got="$3"
    if [[ "$got" == "$want" ]]; then
        echo "ok   $name"
    else
        echo "FAIL $name: want [$want], got [$got]"
        FAILED=1
    fi
}

deploy_generation() {
    local tag="$1"
    export IMAGE_TAG="$tag"
    docker tag alpine:3.20 "${FAKE_REPO}:${tag}"
    snapshot_previous_image_tags
    record_service_tag "$FAKE_REPO"
    prune_old_image_generations
}

deploy_generation gen1
check "first deploy ever: nothing to prune" "gen1" "$(tags_now)"

deploy_generation gen2
check "second deploy: keeps the one before" "gen1 gen2" "$(tags_now)"

deploy_generation gen3
check "third deploy: gen1 is now too old" "gen2 gen3" "$(tags_now)"

deploy_generation gen4
check "rolling window keeps advancing" "gen3 gen4" "$(tags_now)"

docker tag alpine:3.20 "${FAKE_REPO}:latest"
docker tag alpine:3.20 "${FAKE_REPO}:cfg-deadbeef1234"
deploy_generation gen5
check "latest and cfg-* survive any generation" "cfg-deadbeef1234 gen4 gen5 latest" "$(tags_now)"

# Review round 1's regression: image names are shared across namespaces on
# one host, but CHECKSUM_DIR/IMAGE_TAG are per namespace. A sweep over every
# tag on the repo took another namespace's running image with it; this must
# only ever remove a tag THIS namespace's own history put there.
NAMESPACE_B_CHECKSUM_DIR="$(mktemp -d)"
docker tag alpine:3.20 "${FAKE_REPO}:ai-agents-review"
(
    CHECKSUM_DIR="$NAMESPACE_B_CHECKSUM_DIR"
    IMAGE_TAG="ai-agents-review"
    export CHECKSUM_DIR IMAGE_TAG
    snapshot_previous_image_tags
    record_service_tag "$FAKE_REPO"
    prune_old_image_generations
)
deploy_generation gen6
check "another namespace's tag survives this namespace's own deploy" "ai-agents-review cfg-deadbeef1234 gen5 gen6 latest" "$(tags_now)"
rm -rf "$NAMESPACE_B_CHECKSUM_DIR"
docker rmi "${FAKE_REPO}:ai-agents-review" >/dev/null 2>&1 || true

# Review round 2's regression: previous_tag can end up equal to tag (a build
# that failed before record_service_tag, or anything else that shifted the
# window without a real deploy closing it). Treating that as a retiring
# generation would delete the only real rollback image left. Simulate it by
# corrupting previous_tag to match the current tag, then deploy once more:
# the "previous" generation must survive, not get deleted as if it were
# the stale one.
echo "gen6" > "${CHECKSUM_DIR}/${FAKE_REPO}.previous_tag"
deploy_generation gen7
check "previous_tag == tag: nothing wrongly retired" "cfg-deadbeef1234 gen5 gen6 gen7 latest" "$(tags_now)"

deploy_generation gen8
check "window resumes advancing normally afterward" "cfg-deadbeef1234 gen5 gen7 gen8 latest" "$(tags_now)"

# Smoke-only: these two just need to run clean on real Docker, no assertion
# on disk/cache state (that depends on the machine running the test).
if trim_build_cache; then
    echo "ok   trim_build_cache runs clean"
else
    echo "FAIL trim_build_cache exited non-zero"
    FAILED=1
fi
if warn_if_image_disk_full; then
    echo "ok   warn_if_image_disk_full runs clean"
else
    echo "FAIL warn_if_image_disk_full exited non-zero"
    FAILED=1
fi

# _size_over_cap: garbage never counts as over cap - round 4's fix (an
# unparseable docker system df result must stop trim_build_cache's loop,
# not drive it to the most aggressive filter tier).
if _size_over_cap "61.5GB" 50000000000; then
    echo "ok   _size_over_cap: 61.5GB is over a 50GB cap"
else
    echo "FAIL _size_over_cap: 61.5GB should be over a 50GB cap"
    FAILED=1
fi
if _size_over_cap "not-a-size" 50000000000; then
    echo "FAIL _size_over_cap: garbage should not count as over cap"
    FAILED=1
else
    echo "ok   _size_over_cap: garbage does not count as over cap"
fi

# trim_build_cache: if docker system df's size can't be parsed, stop
# instead of escalating, and say so rather than going quiet.
_build_cache_size() { echo "not-a-size"; }
out=$(trim_build_cache 2>&1)
if echo "$out" | grep -q "Couldn't read the build cache size"; then
    echo "ok   trim_build_cache warns on an unreadable size instead of escalating"
else
    echo "FAIL trim_build_cache: expected a warning about an unreadable size, got: $out"
    FAILED=1
fi
unset -f _build_cache_size

# --- prune_untagged_containerd_images (#107): stubbed crictl, no real K3s ---
# `sudo` is overridden here because the function under test calls
# `sudo crictl ...`; running it directly against our stub keeps this test
# from needing real root or a real K3s host.
CRICTL_STUB_DIR="$(mktemp -d)"
CRICTL_STUB_STATE="$(mktemp -d)"
cat > "$CRICTL_STUB_DIR/crictl" <<'STUB'
#!/usr/bin/env bash
# Fake crictl for image-retention-test.sh. Never touches real Docker/K3s.
set -euo pipefail
state="${CRICTL_STUB_STATE:?CRICTL_STUB_STATE not set}"
case "${1:-}" in
    images)
        if [[ -f "$state/unconfigured" ]]; then
            echo "fake crictl: not configured" >&2
            exit 1
        fi
        cat <<'TABLE'
IMAGE                            TAG      IMAGE ID       SIZE
<none>                           <none>   aaaa11111111   10MB
<none>                           <none>   bbbb22222222   10MB
docker.io/library/frontend-ui    v1       cccc33333333   10MB
TABLE
        ;;
    rmi)
        shift
        echo "$*" >> "$state/rmi-calls.log"
        for arg in "$@"; do
            if [[ "$arg" == "--prune" ]]; then
                echo "fake crictl: refusing --prune" >&2
                exit 1
            fi
        done
        if [[ "$1" == "bbbb22222222" && -f "$state/refuse-bbbb22222222" ]]; then
            echo "fake crictl: image in use" >&2
            exit 1
        fi
        echo "$1" >> "$state/removed.log"
        ;;
    *)
        echo "fake crictl: unsupported subcommand $*" >&2
        exit 1
        ;;
esac
STUB
chmod +x "$CRICTL_STUB_DIR/crictl"

ORIGINAL_PATH="$PATH"
PATH="$CRICTL_STUB_DIR:$PATH"
export PATH CRICTL_STUB_STATE
OS_TYPE=linux
sudo() { "$@"; }

prune_untagged_containerd_images
check "prune_untagged_containerd_images: removes only the <none> digests" \
    "aaaa11111111 bbbb22222222" "$(sort "$CRICTL_STUB_STATE/removed.log" | tr '\n' ' ' | sed 's/ *$//')"
if grep -q -- '--prune' "$CRICTL_STUB_STATE/rmi-calls.log" 2>/dev/null; then
    echo "FAIL prune_untagged_containerd_images: called crictl rmi with --prune"
    FAILED=1
else
    echo "ok   prune_untagged_containerd_images: never uses --prune"
fi

# An image crictl refuses (still in use, e.g. a running container) is left
# alone, not retried or forced - crictl's own refusal is trusted as-is.
rm -f "$CRICTL_STUB_STATE/removed.log" "$CRICTL_STUB_STATE/rmi-calls.log"
touch "$CRICTL_STUB_STATE/refuse-bbbb22222222"
prune_untagged_containerd_images
check "prune_untagged_containerd_images: an in-use digest is left alone" \
    "aaaa11111111" "$(cat "$CRICTL_STUB_STATE/removed.log" 2>/dev/null)"

# crictl not configured (no /etc/crictl.yaml, e.g. production's relocated
# data-dir): skip with a warning, never abort the deploy over housekeeping.
rm -f "$CRICTL_STUB_STATE/removed.log" "$CRICTL_STUB_STATE/rmi-calls.log" "$CRICTL_STUB_STATE/refuse-bbbb22222222"
touch "$CRICTL_STUB_STATE/unconfigured"
out=$(prune_untagged_containerd_images 2>&1)
rc=$?
if [[ $rc -eq 0 ]] && echo "$out" | grep -q "warn.*crictl isn't configured"; then
    echo "ok   prune_untagged_containerd_images: unconfigured crictl warns and does not abort"
else
    echo "FAIL prune_untagged_containerd_images: expected a warning and exit 0 when crictl isn't configured, got rc=$rc: $out"
    FAILED=1
fi
check "prune_untagged_containerd_images: unconfigured crictl removes nothing" \
    "" "$(cat "$CRICTL_STUB_STATE/removed.log" 2>/dev/null)"

unset -f sudo
PATH="$ORIGINAL_PATH"
OS_TYPE=macos
rm -rf "$CRICTL_STUB_DIR" "$CRICTL_STUB_STATE"

exit "$FAILED"
