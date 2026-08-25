import { PrismaService } from '../prisma/prisma.service';
import { PlanData, StateMachineService } from './state-machine.service';

// Minimal in-memory shape for SessionState rows used by this spec.
// We only model the fields that StateMachineService reads/writes.
type SessionStateRecord = {
  id: string;
  sessionId: string;
  planId: string | null;
  planData: PlanData;
  currentStateId: string;
  completedTasks: string[];
  skippedTasks: string[];
  deliverables: Record<string, unknown>;
  turnsWithoutProgress: number;
  totalTurns: number;
  createdAt: Date;
  updatedAt: Date;
  lastTransitionAt: Date | null;
};

function clone<T>(value: T): T {
  // Keep mock behavior close to Prisma: callers always receive detached data.
  return structuredClone(value);
}

function createPrismaMock() {
  // In-memory "table" keyed by sessionId.
  const store = new Map<string, SessionStateRecord>();

  const sessionState = {
    // Simulates prisma.sessionState.findUnique({ where: { sessionId } })
    findUnique: jest.fn(async ({ where: { sessionId } }: { where: { sessionId: string } }) => {
      const record = store.get(sessionId);
      return record ? clone(record) : null;
    }),
    // Simulates prisma.sessionState.create(...)
    create: jest.fn(async ({ data }: { data: Partial<SessionStateRecord> & { sessionId: string } }) => {
      const now = new Date();
      const record: SessionStateRecord = {
        id: `state-${data.sessionId}`,
        sessionId: data.sessionId,
        planId: data.planId || null,
        planData: data.planData as PlanData,
        currentStateId: data.currentStateId as string,
        completedTasks: (data.completedTasks || []) as string[],
        skippedTasks: (data.skippedTasks || []) as string[],
        deliverables: (data.deliverables || {}) as Record<string, unknown>,
        turnsWithoutProgress: (data.turnsWithoutProgress || 0) as number,
        totalTurns: (data.totalTurns || 0) as number,
        createdAt: now,
        updatedAt: now,
        lastTransitionAt: null,
      };
      store.set(data.sessionId, record);
      return clone(record);
    }),
    // Simulates prisma.sessionState.update(...), including Prisma-style
    // numeric increment operations used by incrementTurn().
    update: jest.fn(async ({ where: { sessionId }, data }: { where: { sessionId: string }; data: Record<string, unknown> }) => {
      const record = store.get(sessionId);
      if (!record) {
        throw new Error(`Session state not found: ${sessionId}`);
      }

      const next = clone(record) as SessionStateRecord & Record<string, unknown>;
      for (const [key, value] of Object.entries(data)) {
        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          'increment' in (value as Record<string, unknown>)
        ) {
          const amount = Number((value as { increment: number }).increment);
          next[key] = Number(next[key] || 0) + amount;
        } else {
          next[key] = value;
        }
      }

      next.updatedAt = new Date();
      store.set(sessionId, next as SessionStateRecord);
      return clone(next);
    }),
  };

  return {
    // Service only touches prisma.sessionState in these tests.
    prisma: { sessionState } as unknown as PrismaService,
  };
}

function buildNonLinearPlan(): PlanData {
  // Test plan intentionally supports non-linear routing:
  // A can jump directly to C (skipping B), and C can jump backward to A.
  return {
    id: 'plan-nonlinear',
    title: 'Non Linear Plan',
    initial_state_id: 'state-a',
    states: [
      {
        id: 'state-a',
        title: 'A',
        type: 'loose',
        tasks: [
          {
            id: 'task-a',
            description: 'Collect route',
            deliverables: [
              { key: 'route_to_c', description: 'Route to C', required: true, type: 'string' },
            ],
          },
        ],
        transitions: [
          {
            target_state_id: 'state-c',
            condition_type: 'deliverable_exists',
            condition_config: { key: 'route_to_c' },
            priority: 1,
          },
        ],
      },
      {
        id: 'state-b',
        title: 'B',
        type: 'loose',
        tasks: [
          {
            id: 'task-b',
            description: 'Middle state task',
            deliverables: [
              { key: 'middle_data', description: 'Middle data', required: true, type: 'string' },
            ],
          },
        ],
        // Intentionally empty so StateMachineService.ensureTransitions()
        // auto-generates B -> C. This mirrors real plan normalization.
        transitions: [],
      },
      {
        id: 'state-c',
        title: 'C',
        type: 'loose',
        tasks: [
          {
            id: 'task-c',
            description: 'Collect return signal',
            deliverables: [
              { key: 'go_back', description: 'Go back to A', required: true, type: 'string' },
            ],
          },
        ],
        transitions: [
          {
            target_state_id: 'state-a',
            condition_type: 'deliverable_exists',
            condition_config: { key: 'go_back' },
            priority: 1,
          },
        ],
      },
    ],
  };
}

function buildCircularPlan(): PlanData {
  return {
    id: 'plan-circular',
    title: 'Circular Plan',
    initial_state_id: 'state-a',
    states: [
      {
        id: 'state-a',
        title: 'A',
        type: 'loose',
        tasks: [],
        // turn_count_exceeded with turns:0 is trivially true on entry
        // (totalTurns starts at 0), giving a stable always-true condition to
        // exercise the cycle guard without relying on all_tasks_complete (which
        // no longer fires for no-required-work states, #172).
        transitions: [
          {
            target_state_id: 'state-b',
            condition_type: 'turn_count_exceeded',
            condition_config: { turns: 0, scope: 'total' },
            priority: 1,
          },
        ],
      },
      {
        id: 'state-b',
        title: 'B',
        type: 'loose',
        tasks: [],
        transitions: [
          {
            target_state_id: 'state-a',
            condition_type: 'turn_count_exceeded',
            condition_config: { turns: 0, scope: 'total' },
            priority: 1,
          },
        ],
      },
    ],
  };
}

function buildDeadEndPlan(): PlanData {
  // Dead-end scenario:
  // state-a has a transition, but its condition requires a deliverable key
  // that is never set in this test ("missing_key").
  // Expected behavior: no transition should happen.
  return {
    id: 'plan-dead-end',
    title: 'Dead End Plan',
    initial_state_id: 'state-a',
    states: [
      {
        id: 'state-a',
        title: 'A',
        type: 'loose',
        tasks: [],
        transitions: [
          {
            target_state_id: 'state-b',
            condition_type: 'deliverable_exists',
            condition_config: { key: 'missing_key' },
            priority: 1,
          },
        ],
      },
      {
        id: 'state-b',
        title: 'B',
        type: 'loose',
        tasks: [],
        transitions: [],
      },
    ],
  };
}

function buildMultiMatchPriorityPlan(): PlanData {
  // Multiple transitions from state-a intentionally match at the same time.
  // The lower priority number (1) should win deterministically.
  // Both conditions use turn_count_exceeded turns:0 (trivially true on entry) so
  // the test exercises priority resolution rather than all_tasks_complete, which
  // no longer fires for no-required-work states (#172).
  return {
    id: 'plan-multi-match-priority',
    title: 'Multi Match Priority Plan',
    initial_state_id: 'state-a',
    states: [
      {
        id: 'state-a',
        title: 'A',
        type: 'loose',
        tasks: [],
        transitions: [
          {
            target_state_id: 'state-b',
            condition_type: 'turn_count_exceeded',
            condition_config: { turns: 0, scope: 'total' },
            priority: 2,
          },
          {
            target_state_id: 'state-c',
            condition_type: 'turn_count_exceeded',
            condition_config: { turns: 0, scope: 'total' },
            priority: 1,
          },
        ],
      },
      { id: 'state-b', title: 'B', type: 'loose', tasks: [], transitions: [] },
      { id: 'state-c', title: 'C', type: 'loose', tasks: [], transitions: [] },
    ],
  };
}

function buildMultiMatchTiePlan(): PlanData {
  // Tie case: both transitions from state-a have identical priority and both match.
  // We verify runtime behavior stays deterministic across repeated runs.
  // turn_count_exceeded turns:0 is trivially true on entry — a stable always-true
  // condition independent of the no-required-work completion fix (#172).
  return {
    id: 'plan-multi-match-tie',
    title: 'Multi Match Tie Plan',
    initial_state_id: 'state-a',
    states: [
      {
        id: 'state-a',
        title: 'A',
        type: 'loose',
        tasks: [],
        transitions: [
          {
            target_state_id: 'state-b',
            condition_type: 'turn_count_exceeded',
            condition_config: { turns: 0, scope: 'total' },
            priority: 1,
          },
          {
            target_state_id: 'state-c',
            condition_type: 'turn_count_exceeded',
            condition_config: { turns: 0, scope: 'total' },
            priority: 1,
          },
        ],
      },
      { id: 'state-b', title: 'B', type: 'loose', tasks: [], transitions: [] },
      { id: 'state-c', title: 'C', type: 'loose', tasks: [], transitions: [] },
    ],
  };
}

function buildGoalStatePlan(): PlanData {
  return {
    id: 'plan-goal-state',
    title: 'Goal State Plan',
    initial_state_id: 'state-goal',
    states: [
      {
        id: 'state-goal',
        title: 'Goal',
        type: 'goal',
        goal: {
          objective: 'Help participant define a concrete next step',
          success_description: 'Participant states a concrete, realistic next step they will take this week',
        },
        tasks: [],
        transitions: [],
      },
      {
        id: 'state-next',
        title: 'Next',
        type: 'loose',
        tasks: [],
        transitions: [],
      },
    ],
  };
}

describe('StateMachineService non-linear transitions', () => {
  const sessionId = 'session-nonlinear';
  let service: StateMachineService;

  beforeEach(async () => {
    // Fresh service + isolated in-memory state per test.
    const { prisma } = createPrismaMock();
    service = new StateMachineService(prisma);
    await service.initializeForSession(sessionId, buildNonLinearPlan());
  });

  it('transitions forward to a non-adjacent state using transition target_state_id', async () => {
    // Verification target:
    // ensure transition follows explicit target_state_id (A -> C), not adjacency.
    const result = await service.setDeliverable(
      sessionId,
      'route_to_c',
      'yes',
      'User wants to skip to state C',
    );

    // Transition metadata should reflect explicit jump target.
    expect(result.success).toBe(true);
    expect(result.transitioned).toBe(true);
    expect(result.newStateId).toBe('state-c');

    // Current state should now be C, not B.
    const currentState = await service.getCurrentState(sessionId);
    expect(currentState?.stateId).toBe('state-c');

    // Task surface should also move to C's task set immediately.
    const pendingTasks = await service.getPendingTasks(sessionId);
    expect(pendingTasks.map(t => t.id)).toEqual(['task-c']);
  });

  it('marks state statuses correctly after backward jump', async () => {
    // Regression guard for getFullState():
    // after jumping backward (C -> A), statuses must reflect actual completion,
    // not state order in the plan array.
    await service.setDeliverable(sessionId, 'route_to_c', 'yes', 'Move to C');
    // Completion is explicit (#291): collecting a deliverable no longer completes
    // the task, so we tick task-c before jumping back to demonstrate that a
    // genuinely-completed earlier state stays 'completed' after a backward jump.
    await service.completeTask(sessionId, 'task-c', 'Finished C');
    const backward = await service.setDeliverable(sessionId, 'go_back', 'yes', 'Move back to A');

    // Backward transition should be reported explicitly.
    expect(backward.success).toBe(true);
    expect(backward.transitioned).toBe(true);
    expect(backward.newStateId).toBe('state-a');

    const fullState = await service.getFullState(sessionId);
    expect(fullState?.currentStateId).toBe('state-a');

    // Core regression assertion:
    // state status must come from actual completion checks, not array position.
    // After C -> A jump:
    // - A is active (current)
    // - B remains pending (never addressed)
    // - C is completed (its task was explicitly completed)
    const stateStatus = new Map(fullState?.states.map(s => [s.id, s.status]));
    expect(stateStatus.get('state-a')).toBe('active');
    expect(stateStatus.get('state-b')).toBe('pending');
    expect(stateStatus.get('state-c')).toBe('completed');
  });

  it('stops circular transitions with max-transitions-per-turn guard', async () => {
    const circularSessionId = 'session-circular';
    await service.initializeForSession(circularSessionId, buildCircularPlan());

    // Call transition evaluation directly to verify backend loop guard behavior.
    const result = await (service as any).evaluateAndTransition(circularSessionId);

    expect(result.transitioned).toBe(true);
    expect(result.newStateId).toBeDefined();

    const state = await service.getCurrentState(circularSessionId);
    expect(state?.stateId).toBe(result.newStateId);
    expect(['state-a', 'state-b']).toContain(state?.stateId);
  });

  it('stays in current state when no transition condition matches (dead end)', async () => {
    const deadEndSessionId = 'session-dead-end';
    await service.initializeForSession(deadEndSessionId, buildDeadEndPlan());

    // Baseline: session starts in state-a.
    const before = await service.getCurrentState(deadEndSessionId);
    expect(before?.stateId).toBe('state-a');

    // Evaluate transitions directly with no deliverables present.
    // Transition condition should fail, so no state change.
    const result = await (service as any).evaluateAndTransition(deadEndSessionId);
    expect(result.transitioned).toBe(false);
    expect(result.newStateId).toBeUndefined();

    // Verify state remains unchanged after evaluation.
    const after = await service.getCurrentState(deadEndSessionId);
    expect(after?.stateId).toBe('state-a');
  });

  it('uses priority deterministically when multiple transition conditions match', async () => {
    // Both transitions are trivially true (turn_count_exceeded turns:0),
    // so transition choice must be resolved by priority.
    const sessionId = 'session-multi-match-priority';
    await service.initializeForSession(sessionId, buildMultiMatchPriorityPlan());

    const result = await (service as any).evaluateAndTransition(sessionId);
    expect(result.transitioned).toBe(true);
    // priority=1 transition targets state-c, so it must win over priority=2.
    expect(result.newStateId).toBe('state-c');

    const state = await service.getCurrentState(sessionId);
    expect(state?.stateId).toBe('state-c');
  });

  it('remains deterministic when multiple matching transitions have equal priority', async () => {
    // Run the same tie-priority setup multiple times with fresh sessions.
    // Expected: identical outcome each run (stable deterministic selection).
    const outcomes: string[] = [];

    for (let i = 0; i < 5; i++) {
      const sessionId = `session-multi-match-tie-${i}`;
      await service.initializeForSession(sessionId, buildMultiMatchTiePlan());
      const result = await (service as any).evaluateAndTransition(sessionId);
      expect(result.transitioned).toBe(true);
      outcomes.push(result.newStateId as string);
    }

    // If deterministic, all outcomes collapse to a single selected target.
    expect(new Set(outcomes).size).toBe(1);
  });
});

describe('goal_achieved condition', () => {
  it('auto-generates goal_achieved as default transition for goal states', async () => {
    const sessionId = 'session-goal-default-transition';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, buildGoalStatePlan());

    const rawState = await (svc as any).getState(sessionId);
    const goalState = (rawState?.planData as PlanData)?.states.find((state) => state.id === 'state-goal');

    expect(goalState?.transitions?.[0]?.condition_type).toBe('goal_achieved');
  });

  it('does not transition immediately in goal states without deliverables', async () => {
    const sessionId = 'session-goal-no-immediate-transition';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, buildGoalStatePlan());

    const result = await (svc as any).evaluateAndTransition(sessionId);

    expect(result.transitioned).toBe(false);
    expect(result.newStateId).toBeUndefined();
  });

  it('treats required goal tasks without deliverables as auto-complete in state completion checks', async () => {
    const sessionId = 'session-goal-action-task-auto-complete';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    const plan = buildGoalStatePlan();
    plan.states[0].tasks = [
      {
        id: 'action-task',
        description: 'A guidance/action step without deliverables',
      },
    ];
    await svc.initializeForSession(sessionId, plan);

    const state = await (svc as any).getState(sessionId);
    const planState = (state.planData as PlanData).states.find((s) => s.id === 'state-goal');
    const isComplete = (svc as any).isCurrentStateComplete(state, planState);

    expect(isComplete).toBe(true);
  });

  it('transitions when __goal_achieved__ is set truthy', async () => {
    const sessionId = 'session-goal-achieved';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, buildGoalStatePlan());

    const result = await svc.setDeliverable(
      sessionId,
      '__goal_achieved__',
      true,
      'Objective is met',
    );

    expect(result.transitioned).toBe(true);
    expect(result.newStateId).toBe('state-next');
  });

  it('still transitions via goal_achieved when goal state has an action task without deliverables', async () => {
    const sessionId = 'session-goal-achieved-with-action-task';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    const plan = buildGoalStatePlan();
    plan.states[0].tasks = [
      {
        id: 'action-task',
        description: 'Offer reflective summary to participant',
      },
    ];
    await svc.initializeForSession(sessionId, plan);

    const result = await svc.setDeliverable(
      sessionId,
      '__goal_achieved__',
      true,
      'Objective reached after action step',
    );

    expect(result.transitioned).toBe(true);
    expect(result.newStateId).toBe('state-next');
  });

  it('does not auto-evaluate transitions for arbitrary discovered goal insights', async () => {
    const sessionId = 'session-goal-discovered-insight-no-auto-transition';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    const plan = buildGoalStatePlan();
    plan.states[0].transitions = [
      {
        target_state_id: 'state-next',
        condition_type: 'deliverable_exists',
        condition_config: { deliverable_key: 'insight_summary' },
        priority: 1,
      },
    ];
    await svc.initializeForSession(sessionId, plan);

    const result = await svc.setDeliverable(
      sessionId,
      'insight_summary',
      'User shared enough context',
      'Captured as discovered insight',
    );

    expect(result.success).toBe(true);
    expect(result.transitioned).toBe(false);

    const current = await svc.getCurrentState(sessionId);
    expect(current?.stateId).toBe('state-goal');
  });

  it('injects goal completion instruction using success_description in synthetic goal task', async () => {
    const sessionId = 'session-goal-instruction';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, buildGoalStatePlan());

    const pendingTasks = await svc.getPendingTasks(sessionId);
    const goalTask = pendingTasks.find((task) => task.id === '__goal__');

    expect(goalTask?.instruction).toContain('success criteria is met');
    expect(goalTask?.instruction).toContain('setDeliverable("__goal_achieved__", true)');
  });

  it('migrates goal all_tasks_complete transitions to goal_achieved', async () => {
    const sessionId = 'session-goal-all-tasks-complete-blocked';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    const plan = buildGoalStatePlan();
    plan.states[0].transitions = [
      {
        target_state_id: 'state-next',
        condition_type: 'all_tasks_complete',
        priority: 1,
      },
    ];
    await svc.initializeForSession(sessionId, plan);

    const rawState = await (svc as any).getState(sessionId);
    const goalState = (rawState?.planData as PlanData)?.states.find((state) => state.id === 'state-goal');
    expect(goalState?.transitions?.[0]?.condition_type).toBe('goal_achieved');

    const result = await (svc as any).evaluateAndTransition(sessionId);

    expect(result.transitioned).toBe(false);
    expect(result.newStateId).toBeUndefined();
  });

  it('does not allow goal_achieved transitions for non-goal states', async () => {
    const sessionId = 'session-non-goal-goal-achieved-blocked';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    const plan = buildTwoStatePlan(
      {
        target_state_id: 'state-b',
        condition_type: 'goal_achieved',
        priority: 1,
      },
      ['__goal_achieved__'],
    );
    await svc.initializeForSession(sessionId, plan);

    await svc.setDeliverable(sessionId, '__goal_achieved__', true, 'marker set');
    const result = await (svc as any).evaluateAndTransition(sessionId);

    expect(result.transitioned).toBe(false);
    expect(result.newStateId).toBeUndefined();
  });

  it('cascades skipped onto uncollected goal deliverables once the goal state is complete (#310)', async () => {
    // A goal state can complete (goal achieved) without every goal-level
    // deliverable being collected. Those uncollected deliverables must render
    // 'skipped' — mirroring the regular task skip cascade — not a stale
    // 'pending' circle. Previously goal deliverables only ever got
    // 'completed'/'pending', diverging from regular task deliverables.
    const sessionId = 'session-goal-deliverable-skip-cascade';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    const plan = buildGoalStatePlan();
    plan.states[0].goal!.deliverables = [
      { key: 'next_step', description: 'Concrete next step', required: true },
      { key: 'timeframe', description: 'Timeframe', required: false },
    ];
    await svc.initializeForSession(sessionId, plan);

    // Collect one goal deliverable, then achieve the goal so the state advances
    // with the other deliverable still uncollected.
    await svc.setDeliverable(sessionId, 'next_step', 'Go for a walk', 'captured');
    const transition = await svc.setDeliverable(sessionId, '__goal_achieved__', true, 'done');
    expect(transition.transitioned).toBe(true);

    const fullState = await svc.getFullState(sessionId);
    const goalState = fullState?.states.find(s => s.id === 'state-goal');
    expect(goalState?.status).toBe('completed');

    const goalTask = goalState?.tasks.find(t => t.id === '__goal_deliverables__');
    expect(goalTask?.status).toBe('completed');
    const byKey = new Map(goalTask?.deliverables.map(d => [d.key, d.status]));
    expect(byKey.get('next_step')).toBe('completed');
    // Uncollected goal deliverable cascades to skipped now the state is done.
    expect(byKey.get('timeframe')).toBe('skipped');
  });

  it('renders regular tasks and goal deliverables together without double-counting keys (#310)', async () => {
    const sessionId = 'session-goal-coexist-no-double-count';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    const plan = buildGoalStatePlan();
    plan.states[0].goal!.deliverables = [
      { key: 'goal_d1', description: 'Goal deliverable', required: true },
    ];
    plan.states[0].tasks = [
      {
        id: 'regular',
        description: 'A regular task in a goal state',
        deliverables: [{ key: 'task_d1', description: 'Task deliverable', required: true }],
      },
    ];
    await svc.initializeForSession(sessionId, plan);

    const fullState = await svc.getFullState(sessionId);
    const goalState = fullState?.states.find(s => s.id === 'state-goal');

    // Both the synthetic goal task and the real task are present.
    const taskIds = goalState?.tasks.map(t => t.id) ?? [];
    expect(taskIds).toContain('__goal_deliverables__');
    expect(taskIds).toContain('regular');

    // No deliverable key appears under more than one task (no double count).
    const allKeys = goalState?.tasks.flatMap(t => t.deliverables.map(d => d.key)) ?? [];
    expect(allKeys.sort()).toEqual(['goal_d1', 'task_d1']);
    expect(allKeys.length).toBe(new Set(allKeys).size);
  });
});

// =============================================================================
// New condition types (ported from main via PR-121 fix)
//
// Each describe block isolates one condition type and covers:
//   - the happy path (condition fires and transition happens)
//   - the negative path (condition does not fire, state stays put)
//   - edge/invalid config cases where applicable
// =============================================================================

// ---------------------------------------------------------------------------
// Helper: build a minimal two-state plan with a configurable transition on
// state-a.  Used across all new-condition-type tests to avoid repetition.
//
// deliverableKeys: optional list of deliverable keys to register on state-a's
// task.  setDeliverable() rejects unknown keys on strict/loose states, so any
// deliverable the test plans to set must be declared here.  Keys are marked
// required:false so their absence doesn't block all_tasks_complete evaluation.
// ---------------------------------------------------------------------------
function buildTwoStatePlan(
  transition: import('./state-machine.service').StateTransition,
  deliverableKeys: string[] = [],
): PlanData {
  return {
    id: 'plan-two-state',
    title: 'Two State Plan',
    initial_state_id: 'state-a',
    states: [
      {
        id: 'state-a',
        title: 'A',
        type: 'loose',
        tasks: deliverableKeys.length > 0
          ? [
              {
                id: 'task-collect',
                description: 'Collect deliverables used by this test',
                deliverables: deliverableKeys.map(key => ({
                  key,
                  description: key,
                  required: false, // optional so state-a isn't blocked waiting for them
                })),
              },
            ]
          : [],
        transitions: [transition],
      },
      {
        id: 'state-b',
        title: 'B',
        type: 'loose',
        tasks: [],
        transitions: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helper: initialise a fresh service + session, optionally pre-seed
// deliverables, and return the service ready for a transition check.
// ---------------------------------------------------------------------------
async function setupSession(
  sessionId: string,
  plan: PlanData,
  deliverables: Record<string, { value: unknown; reasoning: string }> = {},
): Promise<StateMachineService> {
  const { prisma } = createPrismaMock();
  const svc = new StateMachineService(prisma);
  await svc.initializeForSession(sessionId, plan);

  // Seed each deliverable via the public API so the service's internal state
  // is consistent (completedTasks, etc.) rather than injecting raw DB rows.
  for (const [key, { value, reasoning }] of Object.entries(deliverables)) {
    await svc.setDeliverable(sessionId, key, value, reasoning);
  }

  return svc;
}

// =============================================================================
// turn_count_exceeded
// Fires when a turn counter (total turns or turns without progress) crosses a
// threshold.  Useful for automatic fallback / escalation routes in a plan.
// =============================================================================
describe('turn_count_exceeded condition', () => {
  it('transitions when turns_without_progress meets the threshold (scope: without_progress)', async () => {
    // The default scope is 'without_progress'.  We need at least 2 turns without
    // setting a deliverable for this condition to fire.
    const sessionId = 'session-turn-without-progress';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'turn_count_exceeded',
      condition_config: { turns: 2, scope: 'without_progress' },
      priority: 1,
    });

    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, plan);

    // incrementTurn() advances both counters (total and without-progress) without
    // touching deliverables, AND now re-evaluates transitions itself (#172) — so
    // the transition fires on the turn that crosses the threshold, not on a
    // separate evaluation pass.
    const firstTurn = await svc.incrementTurn(sessionId); // turn 1 — below threshold
    expect(firstTurn.transitioned).toBe(false);

    const result = await svc.incrementTurn(sessionId); // turn 2 — reaches threshold
    expect(result.transitioned).toBe(true);
    expect(result.newStateId).toBe('state-b');
  });

  it('does NOT transition when turns_without_progress is below the threshold', async () => {
    // Only 1 turn has passed; threshold is 2 — should stay in state-a.
    const sessionId = 'session-turn-below-threshold';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'turn_count_exceeded',
      condition_config: { turns: 2, scope: 'without_progress' },
      priority: 1,
    });

    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, plan);
    await svc.incrementTurn(sessionId); // only 1 turn — threshold of 2 not reached

    const result = await (svc as any).evaluateAndTransition(sessionId);
    expect(result.transitioned).toBe(false);
  });

  it('transitions based on total turns (scope: total)', async () => {
    // 'total' scope counts all turns regardless of whether progress was made.
    // incrementTurn() increments totalTurns and re-evaluates transitions (#172),
    // so a single turn both reaches the threshold and fires the transition.
    const sessionId = 'session-turn-total';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'turn_count_exceeded',
      condition_config: { turns: 1, scope: 'total' },
      priority: 1,
    });

    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, plan);

    // One turn is enough to reach totalTurns >= 1, and incrementTurn transitions.
    const result = await svc.incrementTurn(sessionId);
    expect(result.transitioned).toBe(true);
    expect(result.newStateId).toBe('state-b');
  });

  it('skips the transition and logs a warning when config is invalid (missing turns)', async () => {
    // Invalid config: 'turns' field is missing entirely.
    // The transition must be skipped (fail-closed) rather than throw.
    const sessionId = 'session-turn-invalid';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'turn_count_exceeded',
      condition_config: { scope: 'total' }, // missing 'turns' / 'value'
      priority: 1,
    });

    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, plan);
    await svc.incrementTurn(sessionId);

    // validateConditionConfig() catches the missing field and skips the transition.
    const result = await (svc as any).evaluateAndTransition(sessionId);
    expect(result.transitioned).toBe(false);
  });
});

// =============================================================================
// Agent-driven completion (#291)
// A state is complete only once every task is explicitly completed or skipped.
// `required` is informational; nothing auto-completes from deliverable presence,
// and there is NO turn-based fallback — the agent advances by completing/skipping
// tasks (or skipping the whole state).
// =============================================================================
describe('agent-driven completion (#291)', () => {
  // required-routed state-a -> all-optional state-b -> empty state-c.
  function buildOptionalMiddlePlan(): PlanData {
    return {
      id: 'plan-optional-middle',
      title: 'Optional Middle Plan',
      initial_state_id: 'state-a',
      states: [
        {
          id: 'state-a',
          title: 'A',
          type: 'loose',
          tasks: [
            {
              id: 'task-a',
              description: 'Collect route',
              deliverables: [{ key: 'go_to_b', description: 'go', required: true, type: 'string' }],
            },
          ],
          transitions: [
            {
              target_state_id: 'state-b',
              condition_type: 'deliverable_exists',
              condition_config: { key: 'go_to_b' },
              priority: 1,
            },
          ],
        },
        {
          id: 'state-b',
          title: 'B',
          type: 'loose',
          tasks: [
            {
              id: 'task-b',
              description: 'Optional chat',
              deliverables: [{ key: 'opt_note', description: 'optional note', required: false }],
            },
          ],
        },
        { id: 'state-c', title: 'C', type: 'loose', tasks: [], transitions: [] },
      ],
    };
  }

  async function newServiceInStateB(sessionId: string): Promise<StateMachineService> {
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, buildOptionalMiddlePlan());
    // state-a routes to B on the deliverable (deliverable_exists), independent of
    // task completion — used purely to land us in the all-optional state-b.
    const enter = await svc.setDeliverable(sessionId, 'go_to_b', 'yes', 'routing');
    expect(enter.newStateId).toBe('state-b');
    return svc;
  }

  it('does NOT auto-complete an all-optional state on entry, and does not advance during normal operation', async () => {
    const svc = await newServiceInStateB('session-opt-no-skip');

    // It must NOT chain through the all-optional state-b.
    expect((await svc.getCurrentState('session-opt-no-skip'))?.stateId).toBe('state-b');

    // There is no eager turn fallback: a handful of no-progress turns (below the
    // last-resort safety-net limit) do not advance the state.
    for (let i = 0; i < 6; i++) await svc.incrementTurn('session-opt-no-skip');
    expect((await svc.getCurrentState('session-opt-no-skip'))?.stateId).toBe('state-b');
  });

  it('SAFETY NET: force-advances a state the agent leaves stuck (last resort)', async () => {
    const svc = await newServiceInStateB('session-safety-net');

    // The agent never completes/skips state-b. It must eventually release on its
    // own rather than hang forever — but only as a last resort, not eagerly.
    let res: { transitioned: boolean; newStateId?: string } = { transitioned: false };
    let calls = 0;
    while (calls < 20 && !res.transitioned) {
      res = await svc.incrementTurn('session-safety-net');
      calls++;
    }
    expect(res.transitioned).toBe(true);
    expect(res.newStateId).toBe('state-c');
    // Last resort, not eager: it must give the agent many turns first.
    expect(calls).toBeGreaterThanOrEqual(5);
  });

  it('uses an all_tasks_complete default, NOT an injected turn_count_exceeded fallback', async () => {
    const sessionId = 'session-opt-shape';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, buildOptionalMiddlePlan());

    const raw = await (svc as any).getState(sessionId);
    const stateB = (raw.planData as PlanData).states.find((s) => s.id === 'state-b');
    expect(stateB?.transitions?.[0]?.condition_type).toBe('all_tasks_complete');
    expect(stateB?.transitions?.[0]?.target_state_id).toBe('state-c');
    expect(stateB?.transitions?.some((t) => t.condition_type === 'turn_count_exceeded')).toBe(false);
  });

  it('COMPLETION FALLBACK: a single-exit gated state (authored condition -> next state) still advances once every task is addressed', async () => {
    // state-x has tasks + an authored deliverable_value gate that targets the NEXT
    // state in plan order and will NOT match. Because every authored transition
    // already routes to the next state, the route-aware fallback is added, so
    // completing every task still advances (#291 follow-up) — the state machine
    // helps even when the author never wrote a completion transition.
    const sessionId = 'session-completion-fallback';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, {
      id: 'plan-fallback',
      title: 'Fallback Plan',
      initial_state_id: 'state-x',
      states: [
        {
          id: 'state-x',
          title: 'X',
          type: 'loose',
          tasks: [{ id: 'task-x', description: 'do work', required: true }],
          transitions: [
            {
              // Gated single-exit: targets the next state, only fires if 'route' set.
              target_state_id: 'state-next',
              condition_type: 'deliverable_value',
              condition_config: { key: 'route', value: 'go' },
              priority: 1,
            },
          ],
        },
        // Next state in plan order; has its own task so it does not chain onwards.
        {
          id: 'state-next',
          title: 'Next',
          type: 'loose',
          tasks: [{ id: 'task-next', description: 'more work', required: true }],
        },
        { id: 'state-end', title: 'End', type: 'loose', tasks: [] },
      ],
    });

    // The authored gate never matches (deliverable 'route' is never set), but the
    // fallback to the next state in plan order fires once task-x is completed.
    const res = await svc.completeTask(sessionId, 'task-x', 'finished');
    expect(res.transitioned).toBe(true);
    expect(res.newStateId).toBe('state-next');
  });

  it('COMPLETION FALLBACK: the fallback is appended at low priority so authored transitions always win the sort', async () => {
    const sessionId = 'session-fallback-priority';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, {
      id: 'plan-fallback2',
      title: 'Fallback Plan 2',
      initial_state_id: 'state-x',
      states: [
        {
          id: 'state-x',
          title: 'X',
          type: 'loose',
          tasks: [{ id: 'task-x', description: 'do work', required: true }],
          transitions: [
            {
              // Gated single-exit to the next state → eligible for the fallback.
              target_state_id: 'state-next',
              condition_type: 'deliverable_value',
              condition_config: { key: 'route', value: 'go' },
              priority: 1,
            },
          ],
        },
        { id: 'state-next', title: 'Next', type: 'loose', tasks: [] },
        { id: 'state-end', title: 'End', type: 'loose', tasks: [] },
      ],
    });

    const raw = await (svc as any).getState(sessionId);
    const stateX = (raw.planData as PlanData).states.find((s) => s.id === 'state-x');
    const authored = stateX?.transitions?.find((t) => t.condition_type === 'deliverable_value');
    const fallback = stateX?.transitions?.find((t) => t.condition_type === 'all_tasks_complete');
    // Both present; the synthesised fallback targets the next state in plan order
    // and carries a strictly lower priority (larger number) than the authored gate.
    expect(authored?.target_state_id).toBe('state-next');
    expect(fallback?.target_state_id).toBe('state-next');
    expect(fallback!.priority!).toBeGreaterThan(authored!.priority!);
  });

  it('COMPLETION FALLBACK: a real fork (authored branch to a non-next state) is NOT given a fallback and does not auto-advance', async () => {
    // state-x routes to state-branch (NOT the next state in plan order) on a data
    // condition. Route-aware: the fallback is suppressed so completing tasks cannot
    // silently take the wrong branch — routing stays driven by the authored data
    // condition (with the stuck-state net as the last resort).
    const sessionId = 'session-fallback-fork';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, {
      id: 'plan-fallback-fork',
      title: 'Fallback Fork Plan',
      initial_state_id: 'state-x',
      states: [
        {
          id: 'state-x',
          title: 'X',
          type: 'loose',
          tasks: [{ id: 'task-x', description: 'do work', required: true }],
          transitions: [
            {
              // Jumps PAST the next state → a real branch, not a single-exit gate.
              target_state_id: 'state-branch',
              condition_type: 'deliverable_value',
              condition_config: { key: 'route', value: 'branch' },
              priority: 1,
            },
          ],
        },
        { id: 'state-next', title: 'Next', type: 'loose', tasks: [] },
        { id: 'state-branch', title: 'Branch', type: 'loose', tasks: [] },
      ],
    });

    const raw = await (svc as any).getState(sessionId);
    const stateX = (raw.planData as PlanData).states.find((s) => s.id === 'state-x');
    // No fallback synthesised: the only authored transition is a branch elsewhere.
    expect(stateX?.transitions?.some((t) => t.condition_type === 'all_tasks_complete')).toBe(false);
    expect(stateX?.transitions).toHaveLength(1);

    // Completing the task does NOT advance: the authored branch's data isn't present,
    // and there is no completion fallback to guess "next in order".
    const res = await svc.completeTask(sessionId, 'task-x', 'finished');
    expect(res.transitioned).toBe(false);
    expect((await svc.getCurrentState(sessionId))?.stateId).toBe('state-x');
  });

  it('COMPLETION FALLBACK: a task-less state with an authored condition is NOT given a vacuous fallback', async () => {
    const sessionId = 'session-fallback-taskless';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, {
      id: 'plan-fallback3',
      title: 'Fallback Plan 3',
      initial_state_id: 'state-x',
      states: [
        {
          id: 'state-x',
          title: 'X',
          type: 'loose',
          tasks: [],
          transitions: [
            {
              target_state_id: 'state-branch',
              condition_type: 'deliverable_value',
              condition_config: { key: 'route', value: 'branch' },
              priority: 1,
            },
          ],
        },
        { id: 'state-branch', title: 'Branch', type: 'loose', tasks: [] },
        { id: 'state-next', title: 'Next', type: 'loose', tasks: [] },
      ],
    });

    const raw = await (svc as any).getState(sessionId);
    const stateX = (raw.planData as PlanData).states.find((s) => s.id === 'state-x');
    // No tasks → no all_tasks_complete fallback synthesised (would be vacuously true
    // and would silently override the author's deliverable gate).
    expect(stateX?.transitions?.some((t) => t.condition_type === 'all_tasks_complete')).toBe(false);
    expect(stateX?.transitions).toHaveLength(1);
  });

  it('collecting an all-optional task\'s only deliverable completes it and advances (#291 hybrid)', async () => {
    // task-b's single deliverable is optional. Because the task has NO required
    // deliverable, collecting every deliverable it declares is what completes it
    // — otherwise (plans mark everything optional) the state would only advance
    // on a separately-timed, often turn-late complete_task. Setting the value is
    // not vacuous: on entry nothing is collected, so the state stays put.
    const svc = await newServiceInStateB('session-opt-setdeliv');
    expect((await svc.getCurrentState('session-opt-setdeliv'))?.stateId).toBe('state-b');
    const res = await svc.setDeliverable('session-opt-setdeliv', 'opt_note', 'hello', 'optional');
    expect(res.transitioned).toBe(true);
    expect(res.newStateId).toBe('state-c');
  });

  it('advances once the optional task is explicitly completed', async () => {
    const svc = await newServiceInStateB('session-opt-complete');
    const res = await svc.completeTask('session-opt-complete', 'task-b', 'done chatting');
    expect(res.transitioned).toBe(true);
    expect(res.newStateId).toBe('state-c');
  });

  it('advances once the optional task is explicitly skipped', async () => {
    const svc = await newServiceInStateB('session-opt-skip');
    const res = await svc.skipTask('session-opt-skip', 'task-b', 'user not interested');
    expect(res.success).toBe(true);
    expect(res.taskSkipped).toBe('task-b');
    expect(res.transitioned).toBe(true);
    expect(res.newStateId).toBe('state-c');
  });

  it('skip_state marks all remaining tasks skipped and advances', async () => {
    const svc = await newServiceInStateB('session-opt-skipstate');
    const res = await svc.skipState('session-opt-skipstate', undefined, 'phase not relevant');
    expect(res.success).toBe(true);
    expect(res.stateSkipped).toBe('state-b');
    expect(res.tasksSkipped).toEqual(['task-b']);
    expect(res.transitioned).toBe(true);
    expect(res.newStateId).toBe('state-c');
  });

  it('a required task may be skipped (required is informational)', async () => {
    const sessionId = 'session-skip-required';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, {
      id: 'p',
      title: 'P',
      initial_state_id: 's',
      states: [
        {
          id: 's',
          title: 'S',
          type: 'loose',
          tasks: [{ id: 'req', description: 'required', required: true }],
        },
        { id: 'end', title: 'End', type: 'loose', tasks: [] },
      ],
    });
    const res = await svc.skipTask(sessionId, 'req', 'not applicable');
    expect(res.transitioned).toBe(true);
    expect(res.newStateId).toBe('end');
  });

  it('skipping a task cascades skipped onto its uncollected deliverables (getFullState)', async () => {
    // Regression: skip_task marks the TASK skipped, but the live UI also reads the
    // per-deliverable status. Before the cascade, the uncollected deliverable stayed
    // 'pending' → rendered as an empty circle and was not counted as done.
    const sessionId = 'session-skip-cascade';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, {
      id: 'p',
      title: 'P',
      initial_state_id: 's',
      states: [
        {
          id: 's',
          title: 'S',
          type: 'loose',
          tasks: [
            {
              id: 'challenges',
              description: 'Ask about challenges',
              deliverables: [
                { key: 'fitness_challenges', description: 'Challenges they encounter', required: false },
              ],
            },
          ],
        },
        { id: 'end', title: 'End', type: 'loose', tasks: [] },
      ],
    });

    const res = await svc.skipTask(sessionId, 'challenges', 'user declined');
    expect(res.taskSkipped).toBe('challenges');

    const full = await svc.getFullState(sessionId);
    const task = full?.states[0].tasks.find(t => t.id === 'challenges');
    expect(task?.status).toBe('skipped');
    // The uncollected deliverable now inherits the skip rather than staying pending.
    expect(task?.deliverables[0].status).toBe('skipped');
  });

  it('getPendingTasks omits a hybrid-complete task (required deliverables collected, no explicit tick)', async () => {
    // #291 consistency: getPendingTasks must use the same "addressed" rule as
    // isCurrentStateComplete/getFullState. A multi-task state where one task's
    // required deliverable is already collected should not re-surface that task
    // as pending (which would steer the agent to re-work it).
    const sessionId = 'session-pending-hybrid';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, {
      id: 'p',
      title: 'P',
      initial_state_id: 's',
      states: [
        {
          id: 's',
          title: 'S',
          type: 'loose',
          tasks: [
            {
              id: 'goal',
              description: 'Ask about fitness goals',
              deliverables: [
                { key: 'fitness_goal', description: 'Main objective', required: true },
              ],
            },
            {
              id: 'challenges',
              description: 'Ask about challenges',
              deliverables: [
                { key: 'fitness_challenges', description: 'Challenges', required: true },
              ],
            },
          ],
        },
        { id: 'end', title: 'End', type: 'loose', tasks: [] },
      ],
    });

    // Collect only the first task's required deliverable.
    await svc.setDeliverable(sessionId, 'fitness_goal', 'be more consistent', 'stated');

    const pending = await svc.getPendingTasks(sessionId);
    const ids = pending.map(t => t.id);
    expect(ids).not.toContain('goal');      // hybrid-complete -> not pending
    expect(ids).toContain('challenges');    // still genuinely pending
  });

  it('skipState rejects a non-current state', async () => {
    const svc = await newServiceInStateB('session-skipstate-reject');
    const res = await svc.skipState('session-skipstate-reject', 'state-a', 'wrong');
    expect(res.success).toBe(false);
    expect(res.error).toContain('only the current state');
  });

  it('isCurrentStateComplete is false for a state with an unaddressed (even optional) task', async () => {
    const sessionId = 'session-iscomplete';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    const plan: PlanData = {
      id: 'plan-opt-only',
      title: 'Optional Only',
      initial_state_id: 's',
      states: [
        {
          id: 's',
          title: 'S',
          type: 'loose',
          tasks: [
            {
              id: 't',
              description: 'opt-only',
              deliverables: [{ key: 'opt', description: 'optional', required: false }],
            },
          ],
          transitions: [],
        },
      ],
    };
    await svc.initializeForSession(sessionId, plan);

    const raw = await (svc as any).getState(sessionId);
    const planState = (raw.planData as PlanData).states[0];
    // Task not yet completed/skipped → not complete (no vacuous truth) (#291).
    expect((svc as any).isCurrentStateComplete(raw, planState)).toBe(false);
  });

  it('DISPLAY: a future all-optional state is NOT rendered as completed (#291 on-screen bug)', async () => {
    // The original bug: getFullState marked a not-yet-reached all-optional state
    // as completed because isPlanStateComplete skipped optional tasks vacuously.
    const sessionId = 'session-display-bug';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, buildOptionalMiddlePlan());

    // Fresh session: still on state-a; state-b (all-optional WITH a task, the exact
    // shape of the on-screen bug) must render as pending, not completed. (state-c is
    // empty — a state with no tasks is legitimately vacuously complete and is a
    // separate, benign display quirk, so it is not asserted here.)
    const full = await svc.getFullState(sessionId);
    const status = new Map(full?.states.map((s) => [s.id, s.status]));
    expect(status.get('state-a')).toBe('active');
    expect(status.get('state-b')).toBe('pending');
  });
});

// =============================================================================
// Concurrent mutations must not clobber each other (live race fix).
// The agent completes several tasks in one turn, firing concurrent gRPC calls.
// Each is a read-modify-write of the completedTasks array; without per-session
// serialization they all read the same pre-update array and the last write wins,
// so only ONE completion survives and all_tasks_complete can never be satisfied
// (observed in production: a state with 3/3 tasks "done" in the UI that never
// advanced). These tests fire the mutations concurrently and assert the full set
// persists and the state advances.
// =============================================================================
describe('concurrent mutation race safety', () => {
  function buildThreeTaskPlan(): PlanData {
    return {
      id: 'plan-3task',
      title: 'Three Task Plan',
      initial_state_id: 'work',
      states: [
        {
          id: 'work',
          title: 'Work',
          type: 'loose',
          tasks: [
            { id: 'task-1', description: 'one', required: true },
            { id: 'task-2', description: 'two', required: true },
            { id: 'task-3', description: 'three', required: true },
          ],
        },
        { id: 'done', title: 'Done', type: 'loose', tasks: [] },
      ],
    };
  }

  it('completing all tasks concurrently persists every completion and advances', async () => {
    const sessionId = 'session-concurrent-complete';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, buildThreeTaskPlan());

    // Fire all three completions at once, as the agent does in a single turn.
    const results = await Promise.all([
      svc.completeTask(sessionId, 'task-1', 'done 1'),
      svc.completeTask(sessionId, 'task-2', 'done 2'),
      svc.completeTask(sessionId, 'task-3', 'done 3'),
    ]);

    // No completion was lost: all three are recorded.
    const full = await svc.getFullState(sessionId);
    const work = full?.states.find((s) => s.id === 'work');
    const completed = work?.tasks.filter((t) => t.status === 'completed').map((t) => t.id) ?? [];
    expect(completed.sort()).toEqual(['task-1', 'task-2', 'task-3']);

    // And exactly one of the concurrent calls observed the now-complete state and
    // advanced (the others ran before the set was full).
    expect(results.some((r) => r.transitioned && r.newStateId === 'done')).toBe(true);
    expect(full?.currentStateId).toBe('done');
  });

  it('a concurrent mix of completes and skips still advances', async () => {
    const sessionId = 'session-concurrent-mixed';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, buildThreeTaskPlan());

    await Promise.all([
      svc.completeTask(sessionId, 'task-1', 'done 1'),
      svc.skipTask(sessionId, 'task-2', 'n/a'),
      svc.completeTask(sessionId, 'task-3', 'done 3'),
    ]);

    const full = await svc.getFullState(sessionId);
    const work = full?.states.find((s) => s.id === 'work');
    const addressed = work?.tasks
      .filter((t) => t.status === 'completed' || t.status === 'skipped')
      .map((t) => t.id) ?? [];
    expect(addressed.sort()).toEqual(['task-1', 'task-2', 'task-3']);
    expect(full?.currentStateId).toBe('done');
  });
});

// =============================================================================
// Optional tasks must not be auto-completed on startup (#213)
// getFullState() reports per-task status to the frontend. A task with zero
// REQUIRED deliverables must surface as 'pending' on a fresh session, not
// 'completed' — otherwise `requiredKeys.every(...)` is vacuously true and the
// UI renders a green checkmark before the user has done anything.
// =============================================================================
describe('getFullState optional-task status on startup (#213)', () => {
  // One state holding three contrasting tasks:
  // - opt-deliverable-task: has only an optional deliverable (requiredKeys === [])
  //                         — this is the case that actually exercised the bug.
  // - optional-task:        the task itself is required:false. Note getFullState()'s
  //                         STATUS computation never reads task.required; this case
  //                         exists to pin the surfaced `.required` output flag (the
  //                         only thing task.required drives) and to confirm a task
  //                         whose required deliverable is uncollected stays pending.
  // - required-task:        a normal required deliverable (positive control).
  const buildOptionalTaskPlan = (): PlanData => ({
    id: 'plan-optional-tasks',
    title: 'Optional Tasks',
    initial_state_id: 's',
    states: [
      {
        id: 's',
        title: 'S',
        type: 'loose',
        tasks: [
          {
            id: 'opt-deliverable-task',
            description: 'task whose only deliverable is optional',
            deliverables: [{ key: 'opt_note', description: 'optional note', required: false }],
          },
          {
            id: 'optional-task',
            description: 'task explicitly marked optional',
            required: false,
            deliverables: [{ key: 'maybe_field', description: 'maybe', required: true }],
          },
          {
            id: 'required-task',
            description: 'normal required task',
            deliverables: [{ key: 'must_field', description: 'must', required: true }],
          },
        ],
        transitions: [],
      },
    ],
  });

  it('reports tasks with no required deliverables as pending, not completed', async () => {
    const sessionId = 'session-213-startup';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, buildOptionalTaskPlan());

    const fullState = await svc.getFullState(sessionId);
    const tasks = new Map(fullState?.states[0].tasks.map(t => [t.id, t.status]));

    // Core regression assertions for #213: nothing is completed before any work.
    expect(tasks.get('opt-deliverable-task')).toBe('pending');
    expect(tasks.get('optional-task')).toBe('pending');
    expect(tasks.get('required-task')).toBe('pending');

    // The task-level `required` flag does not affect status (status is computed
    // purely from deliverables), but it must still be surfaced correctly so the
    // frontend can distinguish optional tasks. This is the only path task.required
    // drives (state-machine.service.ts:1985).
    const required = new Map(fullState?.states[0].tasks.map(t => [t.id, t.required]));
    expect(required.get('optional-task')).toBe(false);
    expect(required.get('opt-deliverable-task')).toBe(true);
    expect(required.get('required-task')).toBe(true);
  });

  it('HYBRID: auto-completes a deliverable-bearing task once all its required deliverables are collected (#291)', async () => {
    const sessionId = 'session-213-collected';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, buildOptionalTaskPlan());

    // Collecting the task's single required deliverable now auto-completes the
    // task — the agent doesn't have to also fire complete_task. This is the
    // hybrid model that keeps progress derivable from data (a deliverable-less
    // task would still need an explicit tick; see the next assertions).
    await svc.setDeliverable(sessionId, 'must_field', 'done', 'collected');
    let tasks = new Map(
      (await svc.getFullState(sessionId))?.states[0].tasks.map(t => [t.id, t.status]),
    );
    expect(tasks.get('required-task')).toBe('completed');

    // An explicit complete_task remains valid and idempotent.
    await svc.completeTask(sessionId, 'required-task', 'done');
    tasks = new Map(
      (await svc.getFullState(sessionId))?.states[0].tasks.map(t => [t.id, t.status]),
    );
    expect(tasks.get('required-task')).toBe('completed');

    // A task whose required deliverable is still missing stays pending, and a
    // task with NO required deliverable is never auto-completed (no data-defined
    // bar — it would reintroduce vacuous completion). Both await explicit work.
    expect(tasks.get('optional-task')).toBe('pending');
    expect(tasks.get('opt-deliverable-task')).toBe('pending');
  });

  it('HYBRID: a multi-deliverable task completes only when EVERY required deliverable is collected (#291)', async () => {
    const sessionId = 'session-hybrid-multi';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, {
      id: 'plan-hybrid-multi',
      title: 'Hybrid Multi',
      initial_state_id: 's',
      states: [
        {
          id: 's',
          title: 'S',
          type: 'loose',
          tasks: [
            {
              id: 'multi',
              description: 'task with three required deliverables',
              deliverables: [
                { key: 'a', description: 'a', required: true, type: 'string' },
                { key: 'b', description: 'b', required: true, type: 'string' },
                { key: 'c', description: 'c', required: false, type: 'string' },
              ],
            },
          ],
          transitions: [],
        },
      ],
    });

    const statusOf = async () =>
      new Map(
        (await svc.getFullState(sessionId))?.states[0].tasks.map(t => [t.id, t.status]),
      ).get('multi');

    // First required deliverable: partial -> in_progress, not complete.
    await svc.setDeliverable(sessionId, 'a', '1', 'first');
    expect(await statusOf()).toBe('in_progress');

    // Optional deliverable does not complete it either.
    await svc.setDeliverable(sessionId, 'c', '3', 'optional');
    expect(await statusOf()).toBe('in_progress');

    // Once the LAST required deliverable lands, the task auto-completes.
    await svc.setDeliverable(sessionId, 'b', '2', 'second');
    expect(await statusOf()).toBe('completed');
  });

  it('HYBRID REGRESSION: collecting every task\'s deliverables advances a flexible state without any complete_task (the live stuck bug)', async () => {
    // Reproduces the production incident: a flexible state with three
    // deliverable-bearing tasks where the agent set all deliverables but only
    // ticked some tasks. Under the hybrid model the state advances purely from
    // the collected data — no complete_task required.
    const sessionId = 'session-hybrid-advance';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, {
      id: 'plan-hybrid-advance',
      title: 'Hybrid Advance',
      initial_state_id: 'habits',
      states: [
        {
          id: 'habits',
          title: 'Exercise Habits',
          type: 'loose',
          tasks: [
            { id: 't1', description: 'preferred', deliverables: [{ key: 'pref', description: 'p', required: true, type: 'string' }] },
            { id: 't2', description: 'frequency', deliverables: [{ key: 'freq', description: 'f', required: true, type: 'string' }] },
            { id: 't3', description: 'duration', deliverables: [{ key: 'dur', description: 'd', required: true, type: 'string' }] },
          ],
          transitions: [
            { target_state_id: 'goals', condition_type: 'all_tasks_complete', priority: 1 },
          ],
        },
        // Next state has its own task so it does not chain onward.
        {
          id: 'goals',
          title: 'Goals and Challenges',
          type: 'loose',
          tasks: [{ id: 'g1', description: 'goal', deliverables: [{ key: 'goal', description: 'g', required: true, type: 'string' }] }],
          transitions: [],
        },
      ],
    });

    // Agent sets all three deliverables and never calls complete_task.
    await svc.setDeliverable(sessionId, 'pref', 'strength', 'collected');
    await svc.setDeliverable(sessionId, 'freq', '3x', 'collected');
    expect((await svc.getCurrentState(sessionId))?.stateId).toBe('habits'); // not yet
    const last = await svc.setDeliverable(sessionId, 'dur', '45m', 'collected');

    // The final deliverable satisfies all_tasks_complete and advances the state.
    expect(last.transitioned).toBe(true);
    expect(last.newStateId).toBe('goals');
    expect((await svc.getCurrentState(sessionId))?.stateId).toBe('goals');
  });

  it('ALL-OPTIONAL REGRESSION: a state whose every deliverable is required:false still advances from data alone (the live "Goals and Challenges" lag)', async () => {
    // Exact shape of the production plan that advanced a turn late: a flexible
    // state with two tasks, each carrying ONE deliverable marked required:false
    // (plan generators emit everything optional). Collecting both deliverables —
    // with NO complete_task at all — must complete the state the same turn.
    const sessionId = 'session-all-optional';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, {
      id: 'plan-all-optional',
      title: 'All Optional',
      initial_state_id: 'goals',
      states: [
        {
          id: 'goals',
          title: 'Goals and Challenges',
          type: 'loose',
          tasks: [
            { id: 'g-goal', description: 'Ask about fitness goals', deliverables: [{ key: 'fitness_goal', description: 'goal', required: false, type: 'string' }] },
            { id: 'g-chal', description: 'Ask about challenges', deliverables: [{ key: 'fitness_challenges', description: 'challenges', required: false, type: 'string' }] },
          ],
          transitions: [{ target_state_id: 'followup', condition_type: 'all_tasks_complete', priority: 1 }],
        },
        {
          id: 'followup',
          title: 'Follow-up',
          type: 'loose',
          tasks: [{ id: 'f-sched', description: 'Schedule follow-up', deliverables: [{ key: 'followup_schedule', description: 'sched', required: false, type: 'string' }] }],
          transitions: [],
        },
      ],
    });

    // First optional deliverable: only one of two tasks is addressed -> hold.
    await svc.setDeliverable(sessionId, 'fitness_goal', 'be more active', 'collected');
    expect((await svc.getCurrentState(sessionId))?.stateId).toBe('goals');

    // Second optional deliverable completes the last task -> advance, no tick.
    const advanced = await svc.setDeliverable(sessionId, 'fitness_challenges', 'allergies', 'collected');
    expect(advanced.transitioned).toBe(true);
    expect(advanced.newStateId).toBe('followup');

    // And the badges reflect backend truth without any complete_task call.
    const full = await svc.getFullState(sessionId);
    const goals = full?.states.find(s => s.id === 'goals');
    expect(goals?.status).toBe('completed');
    expect(new Map(goals?.tasks.map(t => [t.id, t.status])).get('g-chal')).toBe('completed');
  });

  it('completes an optional-only-deliverable task once all its deliverables are collected (#291 hybrid)', async () => {
    const sessionId = 'session-213-optional-progress';
    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, buildOptionalTaskPlan());

    // On entry the task is pending — not vacuously complete.
    let tasks = new Map(
      (await svc.getFullState(sessionId))?.states[0].tasks.map(t => [t.id, t.status]),
    );
    expect(tasks.get('opt-deliverable-task')).toBe('pending');

    // opt_note is opt-deliverable-task's ONLY deliverable. Since the task has no
    // required deliverable, collecting all it declares completes it — this is the
    // fix for plans that mark every deliverable optional (the "advances a turn
    // late" lag). Tasks that still have a required deliverable are unaffected.
    await svc.setDeliverable(sessionId, 'opt_note', 'hi', 'optional provided');

    tasks = new Map(
      (await svc.getFullState(sessionId))?.states[0].tasks.map(t => [t.id, t.status]),
    );
    expect(tasks.get('opt-deliverable-task')).toBe('completed');
  });
});

// =============================================================================
// deliverable_value_in
// Fires when a deliverable's value is present in a predefined set of values.
// Useful for enum-style routing (e.g. user picks 'option_a', 'option_b', …).
// =============================================================================
describe('deliverable_value_in condition', () => {
  it('transitions when the deliverable value is in the allowed set', async () => {
    const sessionId = 'session-value-in-match';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'deliverable_value_in',
      condition_config: { key: 'user_choice', values: ['option_a', 'option_b', 'option_c'] },
      priority: 1,
    }, ['user_choice']); // register 'user_choice' so setDeliverable accepts it

    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, plan);

    // setDeliverable stores the value AND calls evaluateAndTransition internally,
    // so we check its return value directly rather than calling evaluateAndTransition again.
    const result = await svc.setDeliverable(sessionId, 'user_choice', 'option_b', 'User chose option B');

    expect(result.transitioned).toBe(true);
    expect(result.newStateId).toBe('state-b');
  });

  it('does NOT transition when the deliverable value is NOT in the allowed set', async () => {
    const sessionId = 'session-value-in-no-match';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'deliverable_value_in',
      condition_config: { key: 'user_choice', values: ['option_a', 'option_b'] },
      priority: 1,
    });

    const svc = await setupSession(sessionId, plan, {
      user_choice: { value: 'option_z', reasoning: 'User chose something unexpected' },
    });

    const result = await (svc as any).evaluateAndTransition(sessionId);
    expect(result.transitioned).toBe(false);
  });

  it('comparison is case-insensitive (string normalisation)', async () => {
    // 'OPTION_A' should match 'option_a' because areValuesEqualLoose() trims & lowercases.
    const sessionId = 'session-value-in-case';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'deliverable_value_in',
      condition_config: { key: 'choice', values: ['option_a'] },
      priority: 1,
    }, ['choice']);

    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, plan);

    // Uppercase value must still match lowercase entry in the values array.
    const result = await svc.setDeliverable(sessionId, 'choice', 'OPTION_A', 'uppercase input');

    expect(result.transitioned).toBe(true);
  });

  it('skips the transition when config is invalid (missing values array)', async () => {
    // 'values' field is absent — should fail-closed via validateConditionConfig().
    const sessionId = 'session-value-in-invalid';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'deliverable_value_in',
      condition_config: { key: 'choice' }, // missing 'values'
      priority: 1,
    });

    const svc = await setupSession(sessionId, plan, {
      choice: { value: 'option_a', reasoning: 'any value' },
    });

    const result = await (svc as any).evaluateAndTransition(sessionId);
    expect(result.transitioned).toBe(false);
  });
});

// =============================================================================
// deliverable_value_numeric
// Fires when a numeric deliverable satisfies a comparison operator.
// Supports: gt, gte, lt, lte, eq, neq, between (inclusive by default).
// =============================================================================
describe('deliverable_value_numeric condition', () => {
  it('transitions with operator "gt" when value is greater than threshold', async () => {
    const sessionId = 'session-numeric-gt';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'deliverable_value_numeric',
      condition_config: { key: 'score', operator: 'gt', value: 80 },
      priority: 1,
    }, ['score']);

    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, plan);

    // 95 > 80 → condition fires.  Check via setDeliverable return value.
    const result = await svc.setDeliverable(sessionId, 'score', 95, 'High score');

    expect(result.transitioned).toBe(true);
  });

  it('does NOT transition with operator "gt" when value equals the threshold (strict)', async () => {
    // 'gt' is strictly greater-than; equal value must not fire.
    const sessionId = 'session-numeric-gt-equal';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'deliverable_value_numeric',
      condition_config: { key: 'score', operator: 'gt', value: 80 },
      priority: 1,
    });

    const svc = await setupSession(sessionId, plan, {
      score: { value: 80, reasoning: 'Exactly at threshold' },
    });

    const result = await (svc as any).evaluateAndTransition(sessionId);
    expect(result.transitioned).toBe(false);
  });

  it('transitions with operator "lte" (symbolic alias <=)', async () => {
    // Verifies that symbolic operator aliases ('<=') are normalised to canonical 'lte'.
    const sessionId = 'session-numeric-lte';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'deliverable_value_numeric',
      condition_config: { key: 'risk', operator: '<=', value: 5 },
      priority: 1,
    }, ['risk']);

    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, plan);

    // 3 <= 5 → condition fires.
    const result = await svc.setDeliverable(sessionId, 'risk', 3, 'Low risk');

    expect(result.transitioned).toBe(true);
  });

  it('transitions with operator "between" (inclusive range)', async () => {
    const sessionId = 'session-numeric-between';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'deliverable_value_numeric',
      condition_config: { key: 'temperature', operator: 'between', min: 36, max: 38 },
      priority: 1,
    }, ['temperature']);

    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, plan);

    // Value exactly at the upper boundary must match because inclusive is true by default.
    const result = await svc.setDeliverable(sessionId, 'temperature', 38, 'At upper bound');

    expect(result.transitioned).toBe(true);
  });

  it('does NOT transition with "between" when value is outside the range', async () => {
    const sessionId = 'session-numeric-between-out';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'deliverable_value_numeric',
      condition_config: { key: 'temperature', operator: 'between', min: 36, max: 38 },
      priority: 1,
    });

    const svc = await setupSession(sessionId, plan, {
      temperature: { value: 40, reasoning: 'Too high' },
    });

    const result = await (svc as any).evaluateAndTransition(sessionId);
    expect(result.transitioned).toBe(false);
  });

  it('skips the transition when config is invalid (missing operator)', async () => {
    // No 'operator' field — should fail-closed.
    const sessionId = 'session-numeric-invalid';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'deliverable_value_numeric',
      condition_config: { key: 'score', value: 50 }, // missing 'operator'
      priority: 1,
    });

    const svc = await setupSession(sessionId, plan, {
      score: { value: 99, reasoning: 'High score' },
    });

    const result = await (svc as any).evaluateAndTransition(sessionId);
    expect(result.transitioned).toBe(false);
  });
});

// =============================================================================
// all_of  (composite AND)
// Fires only when ALL child conditions are true.
// =============================================================================
describe('all_of condition (composite AND)', () => {
  it('transitions when ALL child conditions are true', async () => {
    // Both 'consent' and 'age_verified' deliverables must be present.
    const sessionId = 'session-all-of-match';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'all_of',
      condition_config: {
        conditions: [
          { condition_type: 'deliverable_exists', condition_config: { key: 'consent' } },
          { condition_type: 'deliverable_exists', condition_config: { key: 'age_verified' } },
        ],
      },
      priority: 1,
    }, ['consent', 'age_verified']); // both keys must be registered so setDeliverable accepts them

    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, plan);

    // Set first deliverable — AND condition not yet satisfied, so no transition.
    const first = await svc.setDeliverable(sessionId, 'consent', 'yes', 'User gave consent');
    expect(first.transitioned).toBe(false);

    // Set second deliverable — both children now true, AND fires.
    const result = await svc.setDeliverable(sessionId, 'age_verified', 'yes', 'Age confirmed');
    expect(result.transitioned).toBe(true);
    expect(result.newStateId).toBe('state-b');
  });

  it('does NOT transition when only SOME child conditions are true (AND requires all)', async () => {
    // Only 'consent' is set; 'age_verified' is missing — AND must fail.
    const sessionId = 'session-all-of-partial';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'all_of',
      condition_config: {
        conditions: [
          { condition_type: 'deliverable_exists', condition_config: { key: 'consent' } },
          { condition_type: 'deliverable_exists', condition_config: { key: 'age_verified' } },
        ],
      },
      priority: 1,
    });

    const svc = await setupSession(sessionId, plan, {
      consent: { value: 'yes', reasoning: 'User gave consent' },
      // age_verified intentionally NOT set
    });

    const result = await (svc as any).evaluateAndTransition(sessionId);
    expect(result.transitioned).toBe(false);
  });
});

// =============================================================================
// any_of  (composite OR)
// Fires when AT LEAST ONE child condition is true.
// =============================================================================
describe('any_of condition (composite OR)', () => {
  it('transitions when at least one child condition is true', async () => {
    // Either 'express_checkout' OR 'standard_checkout' being present is enough.
    const sessionId = 'session-any-of-match';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'any_of',
      condition_config: {
        conditions: [
          { condition_type: 'deliverable_exists', condition_config: { key: 'express_checkout' } },
          { condition_type: 'deliverable_exists', condition_config: { key: 'standard_checkout' } },
        ],
      },
      priority: 1,
    }, ['express_checkout', 'standard_checkout']);

    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, plan);

    // Setting only 'standard_checkout' is enough — OR fires immediately on the first match.
    const result = await svc.setDeliverable(sessionId, 'standard_checkout', 'yes', 'Standard checkout selected');

    expect(result.transitioned).toBe(true);
    expect(result.newStateId).toBe('state-b');
  });

  it('does NOT transition when NO child condition is true', async () => {
    // Neither deliverable is set — OR must fail.
    const sessionId = 'session-any-of-none';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'any_of',
      condition_config: {
        conditions: [
          { condition_type: 'deliverable_exists', condition_config: { key: 'express_checkout' } },
          { condition_type: 'deliverable_exists', condition_config: { key: 'standard_checkout' } },
        ],
      },
      priority: 1,
    });

    // Neither deliverable set.
    const svc = await setupSession(sessionId, plan);

    const result = await (svc as any).evaluateAndTransition(sessionId);
    expect(result.transitioned).toBe(false);
  });
});

// =============================================================================
// compound  (explicit AND/OR via operator field)
// Same semantics as all_of / any_of but with an explicit 'operator' field.
// Useful when a plan generator prefers a uniform structure over named types.
// =============================================================================
describe('compound condition (explicit operator)', () => {
  it('transitions with operator "and" when all children are true', async () => {
    const sessionId = 'session-compound-and';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'compound',
      condition_config: {
        operator: 'and',
        conditions: [
          { condition_type: 'deliverable_exists', condition_config: { key: 'form_filled' } },
          { condition_type: 'deliverable_value', condition_config: { key: 'agreement', value: 'yes' } },
        ],
      },
      priority: 1,
    }, ['form_filled', 'agreement']);

    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, plan);

    // First deliverable alone is not enough — AND requires both.
    const first = await svc.setDeliverable(sessionId, 'form_filled', 'true', 'Form was completed');
    expect(first.transitioned).toBe(false);

    // Both children now satisfied — AND fires on the second setDeliverable.
    const result = await svc.setDeliverable(sessionId, 'agreement', 'yes', 'User agreed');
    expect(result.transitioned).toBe(true);
    expect(result.newStateId).toBe('state-b');
  });

  it('does NOT transition with operator "and" when one child is false', async () => {
    const sessionId = 'session-compound-and-fail';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'compound',
      condition_config: {
        operator: 'and',
        conditions: [
          { condition_type: 'deliverable_exists', condition_config: { key: 'form_filled' } },
          // agreement value won't match
          { condition_type: 'deliverable_value', condition_config: { key: 'agreement', value: 'yes' } },
        ],
      },
      priority: 1,
    });

    const svc = await setupSession(sessionId, plan, {
      form_filled: { value: 'true', reasoning: 'Form done' },
      agreement: { value: 'no', reasoning: 'User declined' }, // does NOT match 'yes'
    });

    const result = await (svc as any).evaluateAndTransition(sessionId);
    expect(result.transitioned).toBe(false);
  });

  it('transitions with operator "or" when only one child is true', async () => {
    const sessionId = 'session-compound-or';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'compound',
      condition_config: {
        operator: 'or',
        conditions: [
          { condition_type: 'deliverable_exists', condition_config: { key: 'fast_track' } },
          { condition_type: 'deliverable_exists', condition_config: { key: 'slow_track' } },
        ],
      },
      priority: 1,
    }, ['fast_track', 'slow_track']);

    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, plan);

    // Only 'fast_track' is set — OR fires immediately with the first match.
    const result = await svc.setDeliverable(sessionId, 'fast_track', 'yes', 'Fast track chosen');

    expect(result.transitioned).toBe(true);
  });

  it('skips the transition when operator is invalid (fail-closed)', async () => {
    // operator must be 'and' or 'or' — anything else must be rejected.
    const sessionId = 'session-compound-invalid-op';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'compound',
      condition_config: {
        operator: 'xor', // not a valid operator
        conditions: [
          { condition_type: 'deliverable_exists', condition_config: { key: 'item' } },
        ],
      },
      priority: 1,
    });

    const svc = await setupSession(sessionId, plan, {
      item: { value: 'yes', reasoning: 'Present' },
    });

    const result = await (svc as any).evaluateAndTransition(sessionId);
    expect(result.transitioned).toBe(false);
  });
});

// =============================================================================
// Nested composite conditions
// Verifies that all_of / any_of / compound can be nested inside each other.
// This exercises the recursive depth guard (MAX_CONDITION_DEPTH).
// =============================================================================
describe('nested composite conditions', () => {
  it('evaluates a two-level nested composite (all_of containing an any_of)', async () => {
    // Outer: all_of requires BOTH children to be true.
    // Child 1: deliverable_exists 'base_requirement'
    // Child 2: any_of — either 'route_a' or 'route_b' must be present.
    const sessionId = 'session-nested-composite';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'all_of',
      condition_config: {
        conditions: [
          {
            condition_type: 'deliverable_exists',
            condition_config: { key: 'base_requirement' },
          },
          {
            // Inner composite: OR of two possible routes.
            condition_type: 'any_of',
            condition_config: {
              conditions: [
                { condition_type: 'deliverable_exists', condition_config: { key: 'route_a' } },
                { condition_type: 'deliverable_exists', condition_config: { key: 'route_b' } },
              ],
            },
          },
        ],
      },
      priority: 1,
    }, ['base_requirement', 'route_a', 'route_b']); // all keys referenced in conditions must be registered

    const { prisma } = createPrismaMock();
    const svc = new StateMachineService(prisma);
    await svc.initializeForSession(sessionId, plan);

    // Only base_requirement set — inner OR has no match yet, outer AND still fails.
    const first = await svc.setDeliverable(sessionId, 'base_requirement', 'met', 'Base condition satisfied');
    expect(first.transitioned).toBe(false);

    // Adding route_b satisfies the inner any_of — outer all_of now also true → transition fires.
    const result = await svc.setDeliverable(sessionId, 'route_b', 'chosen', 'Route B selected');
    expect(result.transitioned).toBe(true);
    expect(result.newStateId).toBe('state-b');
  });

  it('does NOT transition when the outer AND fails despite the inner OR passing', async () => {
    // Same plan but 'base_requirement' is missing — outer AND must fail even though
    // the inner any_of would pass on its own.
    const sessionId = 'session-nested-outer-fail';
    const plan = buildTwoStatePlan({
      target_state_id: 'state-b',
      condition_type: 'all_of',
      condition_config: {
        conditions: [
          {
            condition_type: 'deliverable_exists',
            condition_config: { key: 'base_requirement' }, // NOT set
          },
          {
            condition_type: 'any_of',
            condition_config: {
              conditions: [
                { condition_type: 'deliverable_exists', condition_config: { key: 'route_a' } },
                { condition_type: 'deliverable_exists', condition_config: { key: 'route_b' } },
              ],
            },
          },
        ],
      },
      priority: 1,
    });

    const svc = await setupSession(sessionId, plan, {
      // base_requirement intentionally absent
      route_a: { value: 'chosen', reasoning: 'Route A selected' },
    });

    const result = await (svc as any).evaluateAndTransition(sessionId);
    expect(result.transitioned).toBe(false);
  });
});

// =============================================================================
// Realistic conversation simulation (#291)
//
// Rather than poking one mutator at a time, these tests drive a full multi-state
// dialogue through the exact public tools the agent calls
// (set_deliverable / complete_task / skip_task / skip_state / a conversational
// turn). They mirror the production "Grace" plan that surfaced the live stuck
// bug — Greeting (sequential) -> Exercise Habits (flexible) -> Goals (goal) —
// so the class of bug ("agent collected the data but forgot to tick the task")
// is reproduced the way it actually happens in a conversation, and we assert the
// state machine stays the single source of truth throughout.
// =============================================================================
describe('realistic conversation simulation (#291)', () => {
  const GRACE_PLAN = (): PlanData => ({
    id: 'plan-grace',
    title: 'Grace',
    initial_state_id: 'greeting',
    states: [
      {
        id: 'greeting',
        title: 'Greeting',
        type: 'strict',
        tasks: [
          {
            id: 'greet',
            description: 'Greet and ask for name',
            deliverables: [{ key: 'user_name', description: "user's name", required: true, type: 'string' }],
          },
        ],
        transitions: [{ target_state_id: 'exercise', condition_type: 'all_tasks_complete', priority: 1 }],
      },
      {
        id: 'exercise',
        title: 'Exercise Habits',
        type: 'loose',
        tasks: [
          {
            id: 'ex-pref',
            description: 'Ask about preferred exercise',
            deliverables: [{ key: 'preferred_exercise', description: 'preferred exercise', required: true, type: 'string' }],
          },
          {
            id: 'ex-freq',
            description: 'Ask about workout frequency',
            deliverables: [{ key: 'weekly_frequency', description: 'weekly frequency', required: true, type: 'string' }],
          },
          {
            id: 'ex-dur',
            description: 'Ask about workout duration',
            deliverables: [{ key: 'session_duration_minutes', description: 'duration', required: true, type: 'string' }],
          },
        ],
        transitions: [{ target_state_id: 'goals', condition_type: 'all_tasks_complete', priority: 1 }],
      },
      {
        id: 'goals',
        title: 'Goals and Challenges',
        type: 'goal',
        goal: {
          objective: "Understand the user's fitness goals",
          deliverables: [{ key: 'primary_goal', description: 'primary goal', required: true, type: 'string' }],
        },
        tasks: [{ id: 'goal-explore', description: 'Explore goals together' }],
        transitions: [],
      },
    ],
  });

  // A tiny conversational harness so each scenario reads like a dialogue. Every
  // method mirrors exactly one thing the agent (or the runtime) does and returns
  // the state-machine result, so a scenario can assert on a transition at the
  // precise tool call that should (or should not) trigger it.
  class Grace {
    private constructor(
      private readonly svc: StateMachineService,
      readonly sessionId: string,
    ) {}

    static async start(sessionId: string): Promise<Grace> {
      const { prisma } = createPrismaMock();
      const svc = new StateMachineService(prisma);
      await svc.initializeForSession(sessionId, GRACE_PLAN());
      return new Grace(svc, sessionId);
    }

    /** Agent records a piece of information the user provided (set_deliverable). */
    collect(key: string, value: unknown) {
      return this.svc.setDeliverable(this.sessionId, key, value, `user provided ${key}`);
    }
    /** Agent explicitly marks a task done (complete_task). */
    tick(taskId: string) {
      return this.svc.completeTask(this.sessionId, taskId, 'addressed');
    }
    /** Agent skips a task it judges unnecessary (skip_task). */
    skip(taskId: string) {
      return this.svc.skipTask(this.sessionId, taskId, 'user declined');
    }
    /** Agent abandons the whole current state (skip_state). */
    leaveState() {
      return this.svc.skipState(this.sessionId, undefined, 'agent advanced the conversation');
    }
    /** A conversational turn that makes no state progress (small talk). */
    smallTalk() {
      return this.svc.incrementTurn(this.sessionId);
    }

    async at(): Promise<string | undefined> {
      return (await this.svc.getCurrentState(this.sessionId))?.stateId;
    }
    async taskStatus(stateId: string, taskId: string): Promise<string | undefined> {
      const full = await this.svc.getFullState(this.sessionId);
      return full?.states.find(s => s.id === stateId)?.tasks.find(t => t.id === taskId)?.status;
    }
    async stateBadge(stateId: string): Promise<string | undefined> {
      const full = await this.svc.getFullState(this.sessionId);
      return full?.states.find(s => s.id === stateId)?.status;
    }
  }

  it('THE LIVE BUG: agent collects all three habits but forgets to tick the last task — state still advances', async () => {
    const g = await Grace.start('sim-live-bug');

    // --- Greeting -------------------------------------------------------------
    // "Hi! I'm Grace. What's your name?" / "I'm Alex."
    // The agent records the name. Under the hybrid model that single deliverable
    // already satisfies the greeting task, so we advance without an explicit tick.
    const afterName = await g.collect('user_name', 'Alex');
    expect(afterName.transitioned).toBe(true);
    expect(afterName.newStateId).toBe('exercise');
    expect(await g.at()).toBe('exercise');
    expect(await g.stateBadge('greeting')).toBe('completed');

    // --- Exercise Habits (the incident) --------------------------------------
    // The agent asks all three questions and records every answer, but only
    // remembers to call complete_task for the first two — exactly the tool-call
    // sequence seen in the production logs (set_deliverable x3, complete_task x2).
    await g.collect('preferred_exercise', 'strength workouts');
    await g.tick('ex-pref');
    await g.collect('weekly_frequency', '3x per week');
    await g.tick('ex-freq');

    expect(await g.at()).toBe('exercise'); // not yet — duration still open

    // The agent records the duration but NEVER ticks ex-dur. Previously this hung
    // the conversation at 3/3 deliverables forever; now the deliverable itself
    // completes the task and the state advances.
    const afterDuration = await g.collect('session_duration_minutes', '45');
    expect(afterDuration.transitioned).toBe(true);
    expect(afterDuration.newStateId).toBe('goals');
    expect(await g.at()).toBe('goals');

    // The UI badge for the un-ticked task must read 'completed', matching the
    // backend — no more "3/3 done but stuck" divergence.
    expect(await g.taskStatus('exercise', 'ex-dur')).toBe('completed');
    expect(await g.stateBadge('exercise')).toBe('completed');
  });

  it('STRAY TICK: a redundant complete_task issued after the auto-advance is a harmless no-op', async () => {
    const g = await Grace.start('sim-stray-tick');
    await g.collect('user_name', 'Sam'); // -> exercise

    // The agent batches its turn as: record duration, then (redundantly) tick the
    // other two tasks it already handled. Recording the LAST deliverable advances
    // to 'goals' immediately, so the subsequent ticks now target a task that no
    // longer lives in the current state. They must succeed as no-ops, not error.
    await g.collect('preferred_exercise', 'running');
    await g.collect('weekly_frequency', 'daily');
    const advance = await g.collect('session_duration_minutes', '30');
    expect(advance.newStateId).toBe('goals');

    const strayPref = await g.tick('ex-pref');
    const strayFreq = await g.tick('ex-freq');
    expect(strayPref.success).toBe(true);
    expect(strayFreq.success).toBe(true);
    expect(await g.at()).toBe('goals'); // the stray ticks didn't disturb anything
  });

  it('FLEXIBLE OUT-OF-ORDER: the user volunteers answers in a different order, with zero complete_task calls', async () => {
    const g = await Grace.start('sim-out-of-order');
    await g.collect('user_name', 'Robin'); // -> exercise

    // "Actually I usually train for about an hour." (duration first, unprompted)
    await g.collect('session_duration_minutes', '60');
    expect(await g.at()).toBe('exercise');
    expect(await g.taskStatus('exercise', 'ex-dur')).toBe('completed');
    expect(await g.taskStatus('exercise', 'ex-pref')).toBe('pending');

    // "...mostly yoga, five days a week." (preferred + frequency, still no ticks)
    await g.collect('preferred_exercise', 'yoga');
    expect(await g.at()).toBe('exercise');
    const last = await g.collect('weekly_frequency', '5x per week');

    expect(last.transitioned).toBe(true);
    expect(last.newStateId).toBe('goals');
  });

  it('USER DECLINES: the agent skips a refused question and the state still advances', async () => {
    const g = await Grace.start('sim-decline');
    await g.collect('user_name', 'Jordan'); // -> exercise

    await g.collect('preferred_exercise', 'swimming');
    await g.collect('weekly_frequency', '2x per week');

    // "I'd rather not say how long I train." -> agent skips that task.
    expect(await g.at()).toBe('exercise');
    const afterSkip = await g.skip('ex-dur');

    expect(afterSkip.transitioned).toBe(true);
    expect(afterSkip.newStateId).toBe('goals');
    expect(await g.taskStatus('exercise', 'ex-dur')).toBe('skipped');
  });

  it('SMALL TALK does not advance: ordinary conversational turns with no data keep the state put', async () => {
    const g = await Grace.start('sim-small-talk');
    await g.collect('user_name', 'Casey'); // -> exercise

    // A few back-and-forth turns where the user chats but answers nothing.
    for (let i = 0; i < 4; i++) {
      const r = await g.smallTalk();
      expect(r.transitioned).toBe(false);
    }
    expect(await g.at()).toBe('exercise');

    // Partial progress is still just partial — one answer doesn't advance.
    await g.collect('preferred_exercise', 'cycling');
    expect(await g.at()).toBe('exercise');
    expect(await g.stateBadge('exercise')).toBe('active');
  });

  it('AGENT JUMPS AHEAD: skip_state moves the conversation on mid-state', async () => {
    const g = await Grace.start('sim-jump');
    await g.collect('user_name', 'Lee'); // -> exercise

    // The agent reads the room and decides to move on after one answer.
    await g.collect('preferred_exercise', 'hiking');
    expect(await g.at()).toBe('exercise');

    const jumped = await g.leaveState();
    expect(jumped.transitioned).toBe(true);
    expect(jumped.newStateId).toBe('goals');
    expect(await g.at()).toBe('goals');
  });

  it('GOAL STATE: deliverable-less scaffolding is non-blocking and the goal accepts its marker', async () => {
    const g = await Grace.start('sim-goal');
    // Fast-forward to the goal state through the normal flow.
    await g.collect('user_name', 'Max');
    await g.collect('preferred_exercise', 'pilates');
    await g.collect('weekly_frequency', '4x per week');
    await g.collect('session_duration_minutes', '50');
    expect(await g.at()).toBe('goals');

    // The deliverable-less 'goal-explore' task must NOT block the goal (it's
    // guidance scaffolding); progress is driven by the goal deliverable.
    expect(await g.taskStatus('goals', 'goal-explore')).toBe('pending');

    // Collecting the goal deliverable records it without error in goal mode.
    const collected = await g.collect('primary_goal', 'run a half marathon');
    expect(collected.success).toBe(true);
  });
});

function buildDeliverableGatePlan(): PlanData {
  // One state with: a deliverable-bearing required task (greet -> user_name),
  // a deliverable-less task (intro), and an optional-only task (optional_ask).
  return {
    id: 'plan-deliverable-gate',
    title: 'Deliverable Gate Plan',
    initial_state_id: 'state-a',
    states: [
      {
        id: 'state-a',
        title: 'A',
        type: 'loose',
        tasks: [
          {
            id: 'greet',
            description: 'Greet and ask for name',
            deliverables: [
              { key: 'user_name', description: 'Name', required: true, type: 'string' },
            ],
          },
          { id: 'intro', description: 'Deliverable-less intro', deliverables: [] },
          {
            id: 'optional_ask',
            description: 'Optional ask',
            deliverables: [
              { key: 'note', description: 'Optional note', required: false, type: 'string' },
            ],
          },
        ],
        transitions: [
          { target_state_id: 'state-b', condition_type: 'all_tasks_complete', priority: 1 },
        ],
      },
      { id: 'state-b', title: 'B', type: 'loose', tasks: [], transitions: [] },
    ],
  };
}

describe('StateMachineService complete_task deliverable guard (reliability)', () => {
  const sessionId = 'session-deliverable-gate';
  let service: StateMachineService;

  beforeEach(async () => {
    const { prisma } = createPrismaMock();
    service = new StateMachineService(prisma);
    await service.initializeForSession(sessionId, buildDeliverableGatePlan());
  });

  it('REJECTS completing a task whose required deliverable is not collected, and does not advance', async () => {
    const res = await service.completeTask(sessionId, 'greet', 'tried to complete before any name');
    expect(res.success).toBe(false);
    expect(res.error).toContain('user_name');

    // The bug this fixes: the state must NOT have advanced.
    const current = await service.getCurrentState(sessionId);
    expect(current?.stateId).toBe('state-a');
  });

  it('ALLOWS completing the task once its required deliverable is collected', async () => {
    await service.setDeliverable(sessionId, 'user_name', 'Felix', 'name given');
    const res = await service.completeTask(sessionId, 'greet', 'name now collected');
    expect(res.success).toBe(true);
  });

  it('ALLOWS completing a deliverable-less task freely', async () => {
    const res = await service.completeTask(sessionId, 'intro', 'introduced myself');
    expect(res.success).toBe(true);
  });

  it('ALLOWS completing a task that owns only OPTIONAL deliverables', async () => {
    const res = await service.completeTask(sessionId, 'optional_ask', 'asked; user did not specify');
    expect(res.success).toBe(true);
  });

  it('still lets the agent SKIP a required-deliverable task to move on without the data', async () => {
    const res = await service.skipTask(sessionId, 'greet', 'user declined to give a name');
    expect(res.success).toBe(true);
    // Skipping is the honest way past it; complete is the one that was blocked.
  });
});

/**
 * Mentioned-but-unconfirmed deliverables.
 *
 * There used to be only two states — never collected, or settled. So something
 * the user volunteered ("I usually walk, though not in this heat") was either
 * re-asked from scratch later, or silently treated as an agreed fact. A real
 * interviewer does neither: they bring it back and check. `unconfirmed` records
 * the value while keeping it open, and surfaces as status 'partial'.
 */
describe('StateMachineService — unconfirmed deliverables', () => {
  const sessionId = 'session-unconfirmed';
  let service: StateMachineService;

  beforeEach(async () => {
    const { prisma } = createPrismaMock();
    service = new StateMachineService(prisma);
    // A plan whose deliverables do NOT drive transitions, so status is not
    // confounded by the state machine moving on mid-test.
    await service.initializeForSession(sessionId, buildDeliverableGatePlan());
  });

  const statusOf = async (key: string) => {
    const full = await service.getFullState(sessionId);
    for (const st of full?.states ?? []) {
      for (const task of st.tasks ?? []) {
        const d = (task.deliverables ?? []).find(x => x.key === key);
        if (d) return d.status;
      }
    }
    return undefined;
  };

  it('defaults to confirmed, so existing callers are unchanged', async () => {
    await service.setDeliverable(sessionId, 'user_name', 'Felix', 'answered directly');
    expect(await statusOf('user_name')).toBe('completed');
  });

  it('records an unconfirmed value as partial, not completed', async () => {
    await service.setDeliverable(
      sessionId, 'user_name', 'Felix', 'mentioned in passing', true,
    );
    // Captured — losing it would be worse than re-asking...
    const collected = await service.getCollectedDeliverables(sessionId);
    expect(collected['user_name']).toBe('Felix');
    // ...but not settled, so the agent checks rather than assumes.
    expect(await statusOf('user_name')).toBe('partial');
  });

  it('setting the same key again without the flag confirms it', async () => {
    await service.setDeliverable(
      sessionId, 'user_name', 'Felix', 'mentioned in passing', true,
    );
    expect(await statusOf('user_name')).toBe('partial');

    await service.setDeliverable(sessionId, 'user_name', 'Felix', 'user confirmed it');
    expect(await statusOf('user_name')).toBe('completed');
  });

  it('an unconfirmed value is still visible to everything that reads deliverables', async () => {
    // It is open, not hidden — downstream consumers must still see the data.
    await service.setDeliverable(
      sessionId, 'user_name', 'Felix', 'mentioned in passing', true,
    );
    expect(await service.getCollectedDeliverables(sessionId)).toHaveProperty('user_name');
  });
});
