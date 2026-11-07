#!/usr/bin/env python3
"""
Check that the Python examples in the SDK docs work against the SDK (#887).

Every ```python block in the SDK docs must parse, and every import
in it must resolve: the module exists and has each name imported from it.
Nothing else in the block runs. A block that is deliberately not runnable
(an outline, a fragment) is marked by putting `<!-- pseudo-code -->` on the
line before its fence; such blocks are skipped.

A block titled with a file path (```python title="my_agent/tools.py") stands
for the reader's own module, so imports of a package defined that way on the
same page are not looked up.

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
    "docs-site/docs/guides/build-your-own-agent.md",
    "docs-site/docs/agents/stella-agent/index.md",
    "docs-site/docs/contributing/coding-standards/python.md",
]
PSEUDO = "<!-- pseudo-code -->"
# A fence may carry attributes after the language, e.g. ```python title="src/agent.py".
FENCE = re.compile(r"^(\s*)```(\w+)?(?:\s.*)?$")
TITLE = re.compile(r'title="([\w./-]+)\.py"')


def python_blocks(path: Path):
    """(first line number, code, title) for each ```python block not marked as pseudo-code."""
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
            title = TITLE.search(lines[i])
            yield start + 1, "\n".join(body), title.group(1) if title else None
        i = j + 1


def page_packages(titles) -> set[str]:
    """Top-level packages the page itself defines, from titles like my_agent/agent."""
    return {t.split("/")[0] for t in titles if t and "/" in t}


def import_problems(code: str, own: frozenset[str] = frozenset()) -> list[tuple[int, str]]:
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [(e.lineno or 1, f"does not parse: {e.msg}")]
    problems = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] in own:
                    continue
                try:
                    importlib.import_module(alias.name)
                except Exception as e:  # noqa: BLE001 - report any import failure
                    problems.append((node.lineno, f"import {alias.name}: {type(e).__name__}: {e}"))
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            if node.module.split(".")[0] in own:
                continue
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
        page = list(python_blocks(path))
        own = frozenset(page_packages(title for _, _, title in page))
        for line, code, _ in page:
            blocks += 1
            for offset, problem in import_problems(code, own):
                failures += 1
                print(f"{path.relative_to(ROOT)}:{line + offset - 1}: {problem}")
    print(f"{blocks} Python blocks checked, {failures} problems", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
