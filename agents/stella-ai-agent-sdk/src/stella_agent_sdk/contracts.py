"""Write the SDK's platform contracts for the backend and UI.

    python -m stella_agent_sdk.contracts [DIR]     # default: ./contracts

- ``agent-session-config.schema.json``: JSON Schema of AGENT_CONFIG
  (``SessionConfig``), which the backend's builder is typed against.
- ``sdk-platform-env.json``: the env vars the SDK reads for every agent
  (``platform_env.PLATFORM_ENV``), which the backend and UI merge with what
  an agent.yaml declares.

``tests/test_platform_contract.py`` fails when the committed files are stale.
"""

from __future__ import annotations

import json
import pathlib
import sys
from typing import Dict

from stella_agent_sdk.platform_env import platform_env_json
from stella_agent_sdk.session_config import SessionConfig

SESSION_CONFIG_SCHEMA = "agent-session-config.schema.json"
PLATFORM_ENV_FILE = "sdk-platform-env.json"


def render() -> Dict[str, str]:
    return {
        SESSION_CONFIG_SCHEMA: json.dumps(SessionConfig.json_schema(), indent=2, ensure_ascii=False) + "\n",
        PLATFORM_ENV_FILE: platform_env_json(),
    }


def main(argv=None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    out = pathlib.Path(argv[0] if argv else "contracts")
    out.mkdir(parents=True, exist_ok=True)
    for name, text in render().items():
        (out / name).write_text(text)
        print(f"wrote {out / name}")


if __name__ == "__main__":  # pragma: no cover
    main()
