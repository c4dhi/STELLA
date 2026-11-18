import { timingSafeEqual } from 'crypto';

/**
 * The shared key that STELLA's own services (the message recorder) send to the
 * backend's internal endpoints (#145, GitHub 889). The deploy keeps it in the
 * `stella-ai-secrets` Kubernetes secret as `internal-api-key`, and both pods
 * get it as INTERNAL_API_KEY.
 */
export const INTERNAL_KEY_HEADER = 'x-internal-key';

/**
 * Whether `given` is the configured internal key. A backend with no key
 * configured accepts nothing: the endpoints fail closed rather than open.
 */
export function internalKeyMatches(
  expected: string | undefined,
  given: unknown,
): boolean {
  if (!expected || typeof given !== 'string' || given.length === 0)
    return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
