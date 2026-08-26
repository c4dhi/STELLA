#!/usr/bin/env bash
# Regenerate the SDK's committed gRPC stubs from ../../proto.
#
# protoc emits `import stt_pb2` (a top-level import) for the *_pb2_grpc modules,
# which only resolves if the output directory happens to be on sys.path. Inside
# the SDK it is a package, so the stubs need `from . import stt_pb2` instead.
# That rewrite is the reason this script exists: doing it by hand is silently
# skippable, and the failure shows up at container start rather than in CI.
set -euo pipefail
cd "$(dirname "$0")"
OUT=src/stella_agent_sdk/_grpc

# Generated from the SDK's OWN proto/ copy, not the repo root's. The two have
# drifted (root's tts.proto carries GetCapabilities/VoiceInfo that this one does
# not), so pointing at the root would silently regenerate the TTS stubs against
# a different service contract as a side effect of an unrelated change.
# Regenerate only what you changed here.
python -m grpc_tools.protoc -I proto \
    --python_out="$OUT" --grpc_python_out="$OUT" \
    "proto/${1:-stt}.proto"

# Package-relative imports (see above).
sed -i.bak -E 's/^import ([a-z_]+_pb2) as /from . import \1 as /' "$OUT"/*_pb2_grpc.py
rm -f "$OUT"/*.bak

python - <<'PY'
import pathlib, re
out = pathlib.Path("src/stella_agent_sdk/_grpc")
bad = [p.name for p in out.glob("*_pb2_grpc.py")
       if re.search(r"^import [a-z_]+_pb2 as ", p.read_text(), re.M)]
assert not bad, f"stubs still carry top-level imports: {bad}"
print("[SDK] proto stubs regenerated with package-relative imports")
PY
