"""Entry point: run ELIAS-Interviewer with the STELLA agent SDK."""

import asyncio
import logging
import os
import sys

from stella_agent_sdk import run_agent_from_env

from elias_interviewer.agent import EliasInterviewerAgent


def main() -> None:
    logging.basicConfig(
        level=getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO),
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
        force=True,
    )
    asyncio.run(run_agent_from_env(EliasInterviewerAgent()))


if __name__ == "__main__":
    main()
