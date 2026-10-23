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
# simulated deploy generations, on real Docker. Touches no cluster, no real
# Stella image, and removes everything it creates.
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
