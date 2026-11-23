"""Entry point for the STELLA V2 Agent.

Reads configuration from environment variables and launches the agent
via the STELLA Agent SDK.

Environment Variables (set by session-management-server):
    LIVEKIT_URL: LiveKit server URL
    ROOM_NAME: Room to join
    AGENT_IDENTITY: Agent participant identity
    LIVEKIT_API_KEY: API key for JWT
    LIVEKIT_API_SECRET: API secret for JWT
    STT_SERVICE_ADDRESS: External STT service address (gRPC)
    TTS_SERVICE_ADDRESS: External TTS service address (gRPC)
    OPENAI_API_KEY: OpenAI API key for LLM

Optional Environment Variables:
    LLM_CONFIG_PATH: Path to LLM configuration file
    STELLA_EXPERTS_DIR: Path to directory containing expert JSON configs
    EXPERT_TIMEOUT_MS: Timeout per expert in milliseconds (default: 3000)
"""

import asyncio
import logging
import os

from stella_agent_sdk import run_agent_from_env
from stella_v2_agent import StellaV2Agent

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


def main():
    """Run the STELLA V2 Agent (config from environment)."""
    logger.info("Starting STELLA V2 Agent")

    config_path = os.environ.get("LLM_CONFIG_PATH")
    experts_dir = os.environ.get("STELLA_EXPERTS_DIR")

    agent = StellaV2Agent(
        llm_config_path=config_path,
        experts_dir=experts_dir,
    )

    asyncio.run(run_agent_from_env(agent))


if __name__ == "__main__":
    main()
