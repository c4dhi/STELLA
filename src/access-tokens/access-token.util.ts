import { createHash, randomInt } from 'crypto';

/** Every secret starts with this, so secret scanners and the guard can spot one. */
export const PAT_PREFIX = 'stella_pat_';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// 43 base62 characters carry just over 256 bits.
const SECRET_LENGTH = 43;
// Characters of the secret kept in clear (after the prefix) to tell tokens apart.
const DISPLAY_CHARS = 6;

export const PAT_SCOPES = ['mcp:read', 'mcp:write'] as const;
export type PatScope = (typeof PAT_SCOPES)[number];

export function generatePatSecret(): string {
  let body = '';
  for (let i = 0; i < SECRET_LENGTH; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  return PAT_PREFIX + body;
}

/** sha256 is enough here: the secret is random and long, so it needs no salt or slow hash. */
export function hashPatSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function displayPrefixOf(secret: string): string {
  return secret.slice(0, PAT_PREFIX.length + DISPLAY_CHARS);
}

export function looksLikePat(secret: string): boolean {
  return secret.startsWith(PAT_PREFIX) && secret.length === PAT_PREFIX.length + SECRET_LENGTH;
}
