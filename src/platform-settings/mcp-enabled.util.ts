import { BadRequestException } from '@nestjs/common';

/**
 * PlatformSetting key for the platform-wide MCP switch (#772). Off by default:
 * a missing row means /mcp answers 404 for everyone.
 */
export const MCP_ENABLED_SETTING_KEY = 'mcp.enabled';

/** PlatformSetting.value is text, so the switch is stored as "true" / "false". */
export function parseStoredMcpEnabled(
  stored: string | null | undefined,
): boolean {
  return stored === 'true';
}

/** Validate an admin write: a boolean, nothing else. */
export function parseMcpEnabledSetting(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  throw new BadRequestException('mcpEnabled must be true or false');
}
