import { BadRequestException } from '@nestjs/common';

/**
 * PlatformSetting key for "uploaded agents need an admin's approval before
 * they run". Off by default: a missing row means a user can upload, build and
 * deploy their own agent without waiting for anyone. An admin can turn review
 * on in Settings → Platform Defaults.
 */
export const AGENT_REVIEW_SETTING_KEY = 'agents.requireReview';

/** PlatformSetting.value is text, so the switch is stored as "true" / "false". */
export function parseStoredAgentReviewRequired(stored: string | null | undefined): boolean {
  return stored === 'true';
}

/** Validate an admin write: a boolean, nothing else. */
export function parseAgentReviewRequiredSetting(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  throw new BadRequestException('agentReviewRequired must be true or false');
}
