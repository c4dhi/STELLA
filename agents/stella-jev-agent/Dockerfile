# Stella Jev Agent Dockerfile
# Builds the stella-jev-agent on top of the stella-v2-agent and the SDK
#
# Build context: stella-backend/ directory
# Build command: docker build -t stella-jev-agent:latest -f agents/stella-jev-agent/Dockerfile .

FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
# - build-essential: for compiling Python packages
# - libglib2.0-0: provides libgobject-2.0.so required by livekit-rtc
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY agents/stella-ai-agent-sdk /app/stella-ai-agent-sdk
COPY agents/stella-v2-agent /app/stella-v2-agent
COPY agents/stella-jev-agent /app/stella-jev-agent

RUN pip install --no-cache-dir /app/stella-ai-agent-sdk
RUN pip install --no-cache-dir /app/stella-v2-agent
RUN pip install --no-cache-dir /app/stella-jev-agent

ENV PYTHONUNBUFFERED=1
ENV STELLA_EXPERTS_DIR=/app/stella-jev-agent/config/experts

WORKDIR /app/stella-jev-agent
CMD ["python", "-m", "stella_jev_agent", "--server", "session-management-server:50051"]
