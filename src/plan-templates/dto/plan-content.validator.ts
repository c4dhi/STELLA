import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Fields a plan may no longer carry, and where they went instead.
 *
 * Plans describe WHAT happens; who the agent is lives in a Persona selected at
 * deploy time (#467). Rejecting these at write time is what stops the split from
 * eroding — the AI generator used to emit `system_prompt` on every generation,
 * which is exactly how near-identical personas multiplied across plans.
 */
const FORBIDDEN_KEYS: Record<string, string> = {
  system_prompt:
    'a plan no longer defines who the agent is — create a Persona and select it when deploying. ' +
    'To refer to the agent inside a task, use {{persona.name}}.',
  voice:
    'voice is part of the agent\'s identity — set it on a Persona instead.',
};

@ValidatorConstraint({ name: 'isPlanContent', async: false })
export class IsPlanContent implements ValidatorConstraintInterface {
  private message = 'invalid plan content';

  validate(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value !== 'object' || Array.isArray(value)) {
      this.message = 'content must be an object';
      return false;
    }

    for (const [key, why] of Object.entries(FORBIDDEN_KEYS)) {
      // Presence is the test, not truthiness: an empty string is still an
      // attempt to own the field, and silently accepting it would let the
      // Plan Builder keep round-tripping a dead key.
      if (key in (value as Record<string, unknown>)) {
        this.message = `content.${key} is not allowed — ${why}`;
        return false;
      }
    }
    return true;
  }

  defaultMessage(): string {
    return this.message;
  }
}
