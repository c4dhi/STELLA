import { IsPlanContent } from './dto/plan-content.validator';

/**
 * The write-time half of the phase-2 clean cut (#467).
 *
 * The extraction migration strips `system_prompt` from stored plans, but without
 * this the field grows straight back: the AI generator used to emit one on every
 * generation, and the Plan Builder round-tripped whatever it found.
 */
describe('IsPlanContent', () => {
  const v = new IsPlanContent();

  it('accepts a plan that carries structure only', () => {
    expect(v.validate({ states: [], initial_state_id: 's1' })).toBe(true);
  });

  it('rejects system_prompt and says where identity lives now', () => {
    expect(v.validate({ states: [], system_prompt: 'You are Max.' })).toBe(false);
    expect(v.defaultMessage()).toContain('Persona');
  });

  it('rejects an EMPTY system_prompt too', () => {
    // Presence is the test, not truthiness: accepting '' would let the Plan
    // Builder keep round-tripping a dead key indefinitely.
    expect(v.validate({ states: [], system_prompt: '' })).toBe(false);
  });

  it('rejects voice, which is part of identity', () => {
    expect(v.validate({ states: [], voice: 'grace' })).toBe(false);
  });

  it('ignores absent content rather than failing', () => {
    expect(v.validate(undefined)).toBe(true);
    expect(v.validate(null)).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(v.validate([])).toBe(false);
  });
});
