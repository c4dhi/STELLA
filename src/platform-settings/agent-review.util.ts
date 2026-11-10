import { BadRequestException } from '@nestjs/common';

/**
 * PlatformSetting key for "uploaded agents need an admin's approval before
 * they run". On by default: a missing row means review is required, because an
 * agent pod still receives the platform-wide LiveKit secret and an upload's
 * Dockerfile RUN steps execute on the host's Docker daemon. An admin can turn
 * review off in Settings → Platform Defaults; the default should go back to off
 * once uploaded agents get a token limited to their own room.
 */
export const AGENT_REVIEW_SETTING_KEY = 'agents.requireReview';

/**
 * PlatformSetting.value is text, so the switch is stored as "true" / "false".
 * Only an explicit "false" turns review off; a missing row or anything else keeps it on.
 */
export function parseStoredAgentReviewRequired(stored: string | null | undefined): boolean {
  return stored !== 'false';
}

/** Validate an admin write: a boolean, nothing else. */
export function parseAgentReviewRequiredSetting(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  throw new BadRequestException('agentReviewRequired must be true or false');
}
