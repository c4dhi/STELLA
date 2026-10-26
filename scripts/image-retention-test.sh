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

exit "$FAILED"
