"""Entry point for the STELLA Jev Agent.

Reads the same environment variables as the STELLA V2 Agent, plus:
    TYPESAFE_API_KEY: API key for Jev
"""

import asyncio
import logging
import os

from stella_agent_sdk import run_agent_from_env
from stella_jev_agent import StellaJevAgent

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


def main():
    """Run the STELLA Jev Agent (config from environment)."""
    logger.info("Starting STELLA Jev Agent")
    agent = StellaJevAgent(
        llm_config_path=os.environ.get("LLM_CONFIG_PATH"),
        experts_dir=os.environ.get("STELLA_EXPERTS_DIR"),
    )
    asyncio.run(run_agent_from_env(agent))


if __name__ == "__main__":
    main()
