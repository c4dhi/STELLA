"""The installed stella-ai-agent-sdk version, as the agent reports it to STELLA."""

from importlib.metadata import PackageNotFoundError, version

try:
    SDK_VERSION = version("stella-ai-agent-sdk")
except PackageNotFoundError:  # running from a source tree that was never installed
    SDK_VERSION = "0.0.0+unknown"
