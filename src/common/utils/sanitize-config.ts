import { Logger } from '@nestjs/common';

const logger = new Logger('sanitizeAgentConfig');

// Blocklist of keys that should never be in agent config
const BLOCKED_KEYS = new Set([
  'OPENAI_API_KEY', 'TYPESAFE_API_KEY', 'ELEVENLABS_API_KEY', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET',
  'DATABASE_URL', 'JWT_SECRET', 'password', 'secret', 'token', 'credential',
  '__proto__', 'constructor', 'prototype',
]);
const BLOCKED_KEYS_NORMALIZED = new Set(Array.from(BLOCKED_KEYS).map((key) => key.toLowerCase()));

// Allow deeper nested plan structures (e.g., composite transition conditions)
// while still keeping a practical recursion guard.
const MAX_DEPTH = 8;
const MAX_STRING_LENGTH = 10000;
const MAX_KEYS = 100;

/**
 * Security: Sanitize agent config to prevent injection attacks.
 * - Validates structure
 * - Removes potentially dangerous keys
 * - Limits string lengths
 * - Prevents deeply nested objects
 */
export function sanitizeAgentConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return {};
  }

  const sanitize = (obj: Record<string, unknown>, depth: number): Record<string, unknown> => {
    if (depth > MAX_DEPTH) {
      return {};
    }

    const result: Record<string, unknown> = {};
    let keyCount = 0;

    for (const [key, value] of Object.entries(obj)) {
      if (keyCount >= MAX_KEYS) break;

      // Skip blocked keys (case-insensitive) to prevent secret leakage via key casing tricks.
      if (BLOCKED_KEYS_NORMALIZED.has(key.toLowerCase())) {
        logger.warn(`Blocked key in agent config: ${key}`);
        continue;
      }

      // Sanitize key name
      const sanitizedKey = key.substring(0, 255).replace(/[\x00-\x1F\x7F]/g, '');
      if (!sanitizedKey) continue;

      if (typeof value === 'string') {
        result[sanitizedKey] = value.substring(0, MAX_STRING_LENGTH);
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        result[sanitizedKey] = value;
      } else if (value === null) {
        result[sanitizedKey] = null;
      } else if (Array.isArray(value)) {
        result[sanitizedKey] = value.slice(0, 100).map(item => {
          if (typeof item === 'string') return item.substring(0, MAX_STRING_LENGTH);
          if (typeof item === 'number' || typeof item === 'boolean') return item;
          if (item === null) return null;
          if (typeof item === 'object' && item !== null) {
            return sanitize(item as Record<string, unknown>, depth + 1);
          }
          return null;
        });
      } else if (typeof value === 'object') {
        result[sanitizedKey] = sanitize(value as Record<string, unknown>, depth + 1);
      }

      keyCount++;
    }

    return result;
  };

  return sanitize(config, 0);
}
