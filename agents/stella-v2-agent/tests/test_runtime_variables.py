"""Drift guards (#251): the manifest's declared runtime-variable palette must match
what the SDK prompt compiler can actually resolve, and the declared compiler
version must match the version the agent pins in code.
"""

import os
import re

import yaml

from stella_agent_sdk.prompts import KNOWN_PLACEHOLDERS, get_compiler

AGENT_DIR = os.path.dirname(os.path.dirname(__file__))
MANIFEST_PATH = os.path.join(AGENT_DIR, "agent.yaml")
AGENT_PY = os.path.join(AGENT_DIR, "src", "stella_v2_agent", "agent.py")


# stella-v2 exposes the SDK's full placeholder palette. If a resolver is ever
# added to the SDK that this agent intentionally should NOT surface, list its token
# here (with a reason) so the reverse drift guard below stays green by decision, not
# by oversight.
INTENTIONALLY_OMITTED: set = set()


def _manifest():
    with open(MANIFEST_PATH) as f:
        return yaml.safe_load(f)


def _declared_tokens(runtime_vars):
    # Parametric vars (e.g. history) resolve as {{name_N}} → sentinel "name_N".
    # Namespaced vars (persona) are excluded: they resolve as {{name.<key>}} by
    # pattern, against per-deployment data, so there is no fixed token for
    # KNOWN_PLACEHOLDERS to contain. They get their own guard below.
    return {
        f"{v['name']}_N" if v.get("parametric") else v["name"]
        for v in runtime_vars
        if not v.get("namespaced")
    }


def _namespaced(runtime_vars):
    return {v["name"] for v in runtime_vars if v.get("namespaced")}


def test_declared_runtime_variables_are_resolvable_by_the_compiler():
    """Forward drift guard: every declared variable must be resolvable by the SDK."""
    runtime_vars = _manifest().get("runtimeVariables") or []
    assert runtime_vars, "stella-v2 must declare runtimeVariables"
    for token in _declared_tokens(runtime_vars):
        assert token in KNOWN_PLACEHOLDERS, (
            f"runtimeVariable token '{token}' is declared but not resolvable by the "
            f"SDK prompt compiler (known: {sorted(KNOWN_PLACEHOLDERS)})"
        )


def test_every_resolvable_placeholder_is_declared_or_intentionally_omitted():
    """Reverse drift guard: a resolver added to the SDK must be either declared in
    the manifest or explicitly listed in INTENTIONALLY_OMITTED — never silently
    forgotten (which would leave a working {{placeholder}} undocumented in the UI
    palette)."""
    declared = _declared_tokens(_manifest().get("runtimeVariables") or [])
    missing = KNOWN_PLACEHOLDERS - declared - INTENTIONALLY_OMITTED
    assert not missing, (
        f"SDK resolves placeholders the manifest neither declares nor intentionally "
        f"omits: {sorted(missing)}. Add them to runtimeVariables, or to "
        f"INTENTIONALLY_OMITTED with a reason."
    )


def test_namespaced_variables_are_supported_by_the_pinned_compiler():
    """A namespace resolves by pattern, so KNOWN_PLACEHOLDERS cannot vouch for it.

    The check that matters is the pinned COMPILER: {{persona.*}} only resolves
    from 1.1.0 on. Declaring the palette entry while pinning 1.0.0 would put a
    token in the UI that renders literally — and plan prose is spoken aloud, so
    the user would hear the token read out.
    """
    manifest = _manifest()
    namespaced = _namespaced(manifest.get("runtimeVariables") or [])
    if not namespaced:
        return
    assert namespaced == {"persona"}, f"unknown namespace declared: {namespaced}"
    version = (manifest.get("promptCompiler") or {}).get("version")
    assert getattr(get_compiler(version), "RESOLVES_PERSONA", False), (
        f"manifest declares the persona namespace but pins compiler {version}, "
        "which does not resolve it"
    )


def test_manifest_compiler_version_matches_pinned_constant():
    declared = (_manifest().get("promptCompiler") or {}).get("version")
    assert declared, "stella-v2 must declare promptCompiler.version"
    with open(AGENT_PY) as f:
        source = f.read()
    m = re.search(r'PROMPT_COMPILER_VERSION\s*=\s*"([^"]+)"', source)
    assert m, "PROMPT_COMPILER_VERSION not found in agent.py"
    assert declared == m.group(1), (
        f"manifest promptCompiler.version ({declared}) must match the agent's "
        f"pinned PROMPT_COMPILER_VERSION ({m.group(1)})"
    )
