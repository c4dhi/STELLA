#!/usr/bin/env python3
"""
Check that the Python examples in the SDK docs work against the SDK (#887).

Every ```python block under the SDK doc folders must parse, and every import
in it must resolve: the module exists and has each name imported from it.
Nothing else in the block runs. A block that is deliberately not runnable
(an outline, a fragment) is marked by putting `<!-- pseudo-code -->` on the
line before its fence; such blocks are skipped.

Usage: python scripts/check-sdk-doc-examples.py [doc paths...]
Run it in a venv with the SDK installed (pip install -e agents/stella-ai-agent-sdk).
Exits 1 and lists each problem as file:line when anything fails.
"""
from __future__ import annotations

import ast
import importlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PATHS = [
    "docs-site/docs/agent-sdk",
    "docs-site/docs/sdk",
    "docs-site/docs/guides/build-your-own-agent.md",
    "docs-site/docs/agents/stella-agent/index.md",
    "docs-site/docs/contributing/coding-standards/python.md",
]
PSEUDO = "<!-- pseudo-code -->"
FENCE = re.compile(r"^(\s*)```(\w+)?\s*$")


def python_blocks(path: Path):
    """(first line number, code) for each ```python block not marked as pseudo-code."""
    lines = path.read_text(encoding="utf-8").splitlines()
    i = 0
    while i < len(lines):
        m = FENCE.match(lines[i])
        if not m or not m.group(2):
            i += 1
            continue
        lang, indent, start = m.group(2).lower(), m.group(1), i + 1
        j = start
        while j < len(lines) and lines[j].strip() != "```":
            j += 1
        prev = next((lines[k].strip() for k in range(i - 1, -1, -1) if lines[k].strip()), "")
        if lang in ("python", "py") and prev != PSEUDO:
            body = [l[len(indent):] if l.startswith(indent) else l for l in lines[start:j]]
            yield start + 1, "\n".join(body)
        i = j + 1


def import_problems(code: str) -> list[tuple[int, str]]:
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [(e.lineno or 1, f"does not parse: {e.msg}")]
    problems = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                try:
                    importlib.import_module(alias.name)
                except Exception as e:  # noqa: BLE001 - report any import failure
                    problems.append((node.lineno, f"import {alias.name}: {type(e).__name__}: {e}"))
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            try:
                module = importlib.import_module(node.module)
            except Exception as e:  # noqa: BLE001
                problems.append((node.lineno, f"from {node.module}: {type(e).__name__}: {e}"))
                continue
            for alias in node.names:
                if alias.name == "*" or hasattr(module, alias.name):
                    continue
                try:
                    importlib.import_module(f"{node.module}.{alias.name}")
                except Exception:  # noqa: BLE001
                    problems.append((node.lineno, f"{node.module} has no {alias.name}"))
    return problems


def files(paths: list[str]):
    for p in paths:
        path = (ROOT / p) if not Path(p).is_absolute() else Path(p)
        yield from sorted(path.rglob("*.md")) if path.is_dir() else [path]


def main(argv: list[str]) -> int:
    failures = blocks = 0
    for path in files(argv or DEFAULT_PATHS):
        for line, code in python_blocks(path):
            blocks += 1
            for offset, problem in import_problems(code):
                failures += 1
                print(f"{path.relative_to(ROOT)}:{line + offset - 1}: {problem}")
    print(f"{blocks} Python blocks checked, {failures} problems", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
