-- A failed agent build now leaves a message in the triggering user's inbox.
ALTER TYPE "UserMessageType" ADD VALUE IF NOT EXISTS 'AGENT_BUILD_FAILED';
