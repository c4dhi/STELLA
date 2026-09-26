let n = 0;
jest.mock('uuid', () => ({ v4: () => `id-${++n}` }));
jest.mock('openai', () => ({ __esModule: true, default: class {} }));

import { ConfigService } from '@nestjs/config';
import { PlanGeneratorService } from './plan-generator.service';

describe('PlanGeneratorService — plans end after the last state (#452)', () => {
  const service = new PlanGeneratorService({ get: () => undefined } as unknown as ConfigService);
  const normalize = (states: any[]) =>
    (service as any).validateAndNormalizeResponse({ content: { states } }).content.states;

  const task = [{ id: 't', description: 'd', deliverables: [] }];

  it('routes the last state to the end of the conversation', () => {
    const [first, last] = normalize([
      { id: 'a', title: 'A', type: 'strict', tasks: task },
      { id: 'b', title: 'B', type: 'strict', tasks: task },
    ]);
    expect(first.transitions[0].target_state_id).toBe(last.id);
    expect(last.transitions).toEqual([
      { target_state_id: '__end__', condition_type: 'all_tasks_complete', priority: 1 },
    ]);
  });

  it('ends a last goal state on goal_achieved', () => {
    const [, last] = normalize([
      { id: 'a', title: 'A', type: 'strict', tasks: task },
      { id: 'b', title: 'B', type: 'goal', tasks: [] },
    ]);
    expect(last.transitions[0]).toMatchObject({ target_state_id: '__end__', condition_type: 'goal_achieved' });
  });

  it('keeps an end transition the model wrote and does not remap it', () => {
    const [state] = normalize([
      { id: 'a', title: 'A', type: 'strict', tasks: task, transitions: [{ target_state_id: '__end__', condition_type: 'all_tasks_complete', priority: 1 }] },
    ]);
    expect(state.transitions).toHaveLength(1);
    expect(state.transitions[0].target_state_id).toBe('__end__');
  });

  it('maps the model\'s initial_state_id to the new state id', () => {
    const content = (service as any).validateAndNormalizeResponse({
      content: {
        initial_state_id: 'b',
        states: [
          { id: 'a', title: 'A', type: 'strict', tasks: task },
          { id: 'b', title: 'B', type: 'strict', tasks: task },
        ],
      },
    }).content;
    expect(content.initial_state_id).toBe(content.states[1].id);
  });

  it('falls back to the first state when initial_state_id names no state', () => {
    const content = (service as any).validateAndNormalizeResponse({
      content: {
        initial_state_id: 'state_name',
        states: [
          { id: 'a', title: 'A', type: 'strict', tasks: task },
          { id: 'b', title: 'B', type: 'strict', tasks: task },
        ],
      },
    }).content;
    expect(content.initial_state_id).toBe(content.states[0].id);
  });

  it('tells the model about the end transition', () => {
    const prompt: string = (service as any).buildSystemPrompt();
    expect(prompt).toContain('"__end__"');
    expect(prompt.match(/"target_state_id": "__end__"/g)!.length).toBeGreaterThanOrEqual(3);
  });
});
