import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

/**
 * `availablePlanIds` only means anything in companion mode (#207): plan mode
 * follows the single `plan` field instead. Accepting it silently alongside
 * `mode: 'plan'` (or no mode at all) would store plans that are never offered,
 * so this refuses the combination outright rather than ignoring it quietly.
 */
@ValidatorConstraint({ name: 'availablePlanIdsNeedsCompanionMode', async: false })
export class AvailablePlanIdsNeedsCompanionMode
  implements ValidatorConstraintInterface
{
  validate(availablePlanIds: unknown, args: ValidationArguments): boolean {
    if (!Array.isArray(availablePlanIds) || availablePlanIds.length === 0) {
      return true;
    }
    const mode = (args.object as { mode?: string }).mode;
    return mode === 'companion';
  }

  defaultMessage(): string {
    return 'availablePlanIds requires mode to be "companion"';
  }
}
