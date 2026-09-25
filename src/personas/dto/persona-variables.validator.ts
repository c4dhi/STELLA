import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/** Keys must be safe to embed in a {{persona.<key>}} token and to match with \w+. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_KEYS = 50;
const MAX_VALUE_LENGTH = 2000;

/**
 * Validates a persona's `variables` map.
 *
 * The key rule is not cosmetic: the prompt compiler matches `{{persona.<key>}}`
 * with `\w+`, so a key containing a dot, dash or space could never be referenced
 * and would look silently broken to whoever wrote the prompt. Rejecting it at
 * write time turns that into an error message instead of a mystery.
 *
 * Values are capped because they are substituted into every prompt that
 * references them, on every turn.
 */
@ValidatorConstraint({ name: 'isPersonaVariableMap', async: false })
export class IsPersonaVariableMap implements ValidatorConstraintInterface {
  private message = 'variables must be a flat map of identifier keys to strings';

  validate(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value !== 'object' || Array.isArray(value)) {
      this.message = 'variables must be an object';
      return false;
    }

    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_KEYS) {
      this.message = `variables may define at most ${MAX_KEYS} keys`;
      return false;
    }

    for (const [key, val] of entries) {
      if (!KEY_PATTERN.test(key)) {
        this.message =
          `variable name "${key}" is not usable in a prompt: use letters, ` +
          'digits and underscores only, starting with a letter or underscore';
        return false;
      }
      if (typeof val !== 'string') {
        this.message = `variable "${key}" must be a string`;
        return false;
      }
      if (val.length > MAX_VALUE_LENGTH) {
        this.message = `variable "${key}" exceeds ${MAX_VALUE_LENGTH} characters`;
        return false;
      }
    }
    return true;
  }

  defaultMessage(): string {
    return this.message;
  }
}
