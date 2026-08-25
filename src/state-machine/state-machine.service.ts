import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionState, Prisma } from '@prisma/client';

/**
 * Reserved sentinel ID for the End node drawn in the Plan Builder canvas.
 * Not a real plan state — used to signal conversation termination when a
 * transition targets it. Matches END_NODE_ID in PlanCanvas.tsx.
 */
export const END_STATE_ID = '__end__';

/**
 * Plan data structure (matches SDK Plan type)
 */
export interface PlanData {
  id: string;
  title?: string;
  initial_state_id?: string;
  states: PlanState[];
  system_prompt?: string;
  // Canvas metadata written by the Plan Builder UI.
  // end_node_config is read when a transition reaches END_STATE_ID.
  metadata?: {
    plan_builder?: {
      canvas?: {
        end_node_config?: {
          farewell_message?: string;
          summary_behavior?: 'none' | 'brief' | 'full';
        };
      };
    };
  };
}

/**
 * Goal-mode context for natural, goal-oriented conversation states.
 * Only used when state type is 'goal'.
 */
export interface StateGoal {
  objective: string;
  context?: string;
  depth_guidance?: string;
  boundaries?: string;
  success_description?: string;
  deliverables?: PlanDeliverable[];
}

export interface PlanState {
  id: string;
  title?: string;
  description?: string;
  type?: 'strict' | 'loose' | 'goal';
  tasks: PlanTask[];
  transitions?: StateTransition[];
  goal?: StateGoal;
}

export interface PlanTask {
  id: string;
  description: string;
  instruction?: string;
  required?: boolean;
  deliverables?: PlanDeliverable[];
}

export interface PlanDeliverable {
  key: string;
  description: string;
  type?: string;
  required?: boolean;
  acceptance_criteria?: string;
  enum_values?: string[];
}

export interface StateTransition {
  target_state_id: string;
  /**
   * All supported condition types. The full set must be listed here so that
   * TypeScript catches unsupported types at compile time and the plan generator
   * can reference them without silent runtime failures.
   *
   * Simple:
   *   all_tasks_complete       – all required tasks/deliverables in the state are done
   *   goal_achieved           – __goal_achieved__ deliverable is truthy
   *   deliverable_value        – a deliverable key equals a specific value (loose equality)
   *   deliverable_value_in     – a deliverable key matches any value in an array
   *   deliverable_value_numeric – a deliverable key satisfies a numeric comparison
   *   deliverable_exists       – a deliverable key is present regardless of value
   *   turn_count_exceeded      – turn counter (total or without-progress) exceeds threshold
   *
   * Composite (nest any of the above with AND/OR logic):
   *   all_of    – all child conditions must be true (AND)
   *   any_of    – at least one child condition must be true (OR)
   *   compound  – explicit operator:'and'|'or' with child conditions array
   */
  condition_type:
    | 'all_tasks_complete'
    | 'goal_achieved'
    | 'turn_count_exceeded'
    | 'deliverable_value'
    | 'deliverable_value_in'
    | 'deliverable_value_numeric'
    | 'compound'
    | 'all_of'
    | 'any_of'
    | 'deliverable_exists';
  condition_config?: Record<string, unknown>;
  priority?: number;
}

/**
 * Deliverable value stored in state
 */
export interface DeliverableValue {
  value: unknown;
  reasoning: string;
  collectedAt: string;
  discovered?: boolean;
  /**
   * Recorded, but the user has not confirmed it.
   *
   * Set when the user mentioned something in passing rather than answering a
   * question about it. Without this there were only two states — never asked,
   * or settled — so a volunteered answer was either re-asked from scratch (the
   * user says they walk, and is asked ten turns later whether they walk) or
   * silently treated as fact. A real interviewer does neither: they come back
   * and check.
   *
   * Surfaces as status 'partial'. Setting the same key again WITHOUT the flag
   * is what confirms it.
   */
  unconfirmed?: boolean;
}

/**
 * Result of state machine operations
 */
export interface StateMachineResult {
  success: boolean;
  error?: string;
  transitioned?: boolean;
  newStateId?: string;
  newStateTitle?: string;
  taskCompleted?: string;
  taskSkipped?: string;
  stateSkipped?: string;
  tasksSkipped?: string[];
  progress?: number;
  // Set when the state machine reached END_STATE_ID. Agent should stop prompting.
  sessionCompleted?: boolean;
  // Populated from end_node_config when sessionCompleted is true.
  farewellMessage?: string;
  summaryBehavior?: string;
}

/**
 * Current state info
 */
export interface CurrentStateInfo {
  stateId: string;
  stateTitle: string;
  stateType: 'strict' | 'loose' | 'goal';
  progress: number;
  turnsWithoutProgress: number;
  totalTurns: number;
  goal?: StateGoal;
}

/**
 * Pending task info
 */
export interface PendingTaskInfo {
  id: string;
  description: string;
  instruction?: string;
  required: boolean;
  hasDeliverables: boolean;
  deliverableKeys: string[];
  isPreview?: boolean;  // True for "next task" preview in strict mode
  isGoal?: boolean;     // True when state type is "goal"
}

/**
 * Pending deliverable info
 */
export interface PendingDeliverableInfo {
  key: string;
  description: string;
  type: string;
  required: boolean;
  acceptanceCriteria?: string;
  taskId: string;
}

/**
 * Full state deliverable info (for frontend updates)
 */
export interface FullStateDeliverableInfo {
  key: string;
  description: string;
  type: string;
  required: boolean;
  status: 'pending' | 'completed' | 'partial' | 'skipped';
  value?: unknown;
  collectedAt?: string;
  acceptanceCriteria?: string;
  reasoning?: string;
  discovered?: boolean;
}

/**
 * Full state task info (for frontend updates)
 */
export interface FullStateTaskInfo {
  id: string;
  description: string;
  instruction?: string;
  required: boolean;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  deliverables: FullStateDeliverableInfo[];
}

/**
 * Full state state info (for frontend updates)
 */
export interface FullStateStateInfo {
  id: string;
  title: string;
  type: 'strict' | 'loose' | 'goal';
  status: 'pending' | 'active' | 'completed';
  tasks: FullStateTaskInfo[];
  goal?: StateGoal;
}

/**
 * Full state info (for frontend updates)
 */
export interface FullStateInfo {
  planId: string;
  planTitle: string;
  currentStateId: string;
  progress: number;
  totalTurns: number;
  turnsWithoutProgress: number;
  states: FullStateStateInfo[];
  collectedDeliverables: Record<string, unknown>;
  // True when currentStateId === END_STATE_ID (conversation terminated).
  sessionCompleted?: boolean;
}

@Injectable()
export class StateMachineService {
  private readonly logger = new Logger(StateMachineService.name);
  // Guard against circular transition loops in a single turn (e.g., A -> B -> A).
  private static readonly MAX_TRANSITIONS_PER_TURN = 10;
  // Guard against runaway recursion in composite conditions (all_of / any_of / compound).
  private static readonly MAX_CONDITION_DEPTH = 5;
  // Last-resort safety net (#291). Completion is agent-driven: the agent advances
  // by completing/skipping a state's tasks. If it never does, the state would hang
  // forever. After this many turns WITHOUT PROGRESS in a single state, force the
  // default forward transition so the conversation can always recover. This is a
  // floor, not the primary mechanism — set high enough that a well-behaved agent
  // never hits it, and every firing is logged loudly so stuck agents are visible.
  private static readonly STUCK_STATE_TURN_LIMIT = 10;

  // Priority for the implicit `all_tasks_complete` fallback transition that
  // ensureTransitions guarantees on every non-goal state (#291 follow-up). It is
  // deliberately very low (large number = lowest urgency) so any author-defined
  // transition — branch conditions, deliverable gates, explicit jumps — always
  // wins the priority sort. The fallback only decides the move when nothing the
  // author wrote matched but the agent HAS addressed every task in the state.
  private static readonly COMPLETION_FALLBACK_PRIORITY = 1000;

  // Per-session serialization. Every state-mutating operation (complete/skip a
  // task, skip a state, set a deliverable, increment a turn) is a read-modify-
  // write-then-evaluate sequence against one SessionState row. The agent fires
  // several of these per turn (e.g. completing three tasks at once), and on
  // Node's single event loop those gRPC handlers interleave at every `await`.
  // Without serialization each handler reads the SAME pre-update array, appends
  // only its own id, and writes the whole array back — so concurrent completions
  // clobber each other (last-writer-wins) and the full set is never persisted,
  // leaving `all_tasks_complete` permanently false. Chaining all mutations for a
  // given session through a promise makes each sequence atomic, so the final
  // evaluation always sees every completion. (Single-writer assumption: one
  // session-management-server process owns a session; horizontal scaling would
  // additionally need a DB row lock / advisory lock.)
  private readonly sessionChains = new Map<string, Promise<unknown>>();

  constructor(private prisma: PrismaService) {}

  /**
   * Run `fn` exclusively with respect to other mutations on the same session,
   * serializing read-modify-write-evaluate sequences so concurrent agent tool
   * calls cannot clobber each other's array updates. Operations on different
   * sessions still run concurrently. The chain is self-cleaning: the map entry is
   * dropped once the session goes idle so it does not grow unbounded.
   */
  private withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = (this.sessionChains.get(sessionId) ?? Promise.resolve()).catch(() => {});
    const result = prev.then(() => fn());
    // Tail tracks completion (success or failure) without rejecting the chain.
    const tail = result.then(() => {}, () => {});
    this.sessionChains.set(sessionId, tail);
    void tail.then(() => {
      if (this.sessionChains.get(sessionId) === tail) {
        this.sessionChains.delete(sessionId);
      }
    });
    return result;
  }

  /**
   * Ensure all states have transitions defined.
   * If a state doesn't have transitions, auto-generate a default transition to the
   * next state in plan order.
   *
   * #291 redesign: the backend no longer auto-injects a `turn_count_exceeded`
   * fallback for all-optional states. Advancement is agent-driven (the agent
   * completes/skips tasks, or calls skip_state). `turn_count_exceeded` remains a
   * supported condition that a PLAN AUTHOR may add explicitly as an escape hatch,
   * but nothing implicit is added here.
   *
   * #291 follow-up: a non-goal, non-last state that has tasks is ALSO given an
   * implicit `all_tasks_complete` transition to the next state in plan order, so
   * that once the agent has addressed every task the state machine advances on its
   * own instead of waiting on an explicit skip_state. This is ROUTE-AWARE: it is
   * only added when every authored transition already targets that same next state
   * (linear / single-exit gated states). On a real fork or jump — where an authored
   * transition targets a different state — the fallback is suppressed, because
   * routing there depends on data the agent produces and guessing "next in order"
   * on completion could silently take the wrong branch. Author-defined transitions
   * are always kept and out-prioritise the fallback (see COMPLETION_FALLBACK_PRIORITY).
   */
  private ensureTransitions(plan: PlanData): PlanData {
    const statesWithTransitions = plan.states.map((state, index) => {
      const normalizedExistingTransitions = (state.transitions || []).map((transition) =>
        state.type === 'goal' && transition.condition_type === 'all_tasks_complete'
          ? { ...transition, condition_type: 'goal_achieved' as const, condition_config: undefined }
          : transition,
      );

      const isLastState = index === plan.states.length - 1;
      const stateType = state.type || 'loose';
      const nextStateId = isLastState ? undefined : plan.states[index + 1].id;

      // Keep authored transitions as-is (after goal normalization). For non-goal,
      // non-last states, additionally guarantee an `all_tasks_complete` fallback to
      // the next state so "every task addressed -> advance" always holds, even when
      // the author only wrote branch/deliverable conditions. Goal states are driven
      // by goal_achieved (all_tasks_complete is unsupported for them), so they are
      // left untouched here.
      if (normalizedExistingTransitions.length > 0) {
        // Route-aware completion fallback. We only synthesise an all_tasks_complete
        // -> next-state transition when adding it can never cause a WRONG move:
        //  - the state must have tasks ("all tasks ticked off" is meaningless without
        //    them, and a vacuous all_tasks_complete would override the author's gate);
        //  - the state must not already define a completion transition;
        //  - and crucially, EVERY authored transition must already target the next
        //    state in plan order. If any authored transition is a real branch or jump
        //    (a different target, or the __end__ sentinel), the state's routing
        //    genuinely depends on data the agent produces — guessing "next in order"
        //    on task completion could silently take the wrong branch, so we leave it
        //    to the authored conditions (and, as a last resort, the stuck-state net).
        const routesOnlyToNextState =
          !isLastState &&
          normalizedExistingTransitions.every(
            (t) => t.target_state_id === nextStateId,
          );
        const needsCompletionFallback =
          !isLastState &&
          stateType !== 'goal' &&
          (state.tasks?.length ?? 0) > 0 &&
          routesOnlyToNextState &&
          !normalizedExistingTransitions.some(
            (t) => t.condition_type === 'all_tasks_complete',
          );

        if (needsCompletionFallback) {
          this.logger.log(
            `Adding all_tasks_complete fallback for state '${state.id}' -> '${nextStateId}'`,
          );
          return {
            ...state,
            transitions: [
              ...normalizedExistingTransitions,
              {
                target_state_id: nextStateId!,
                condition_type: 'all_tasks_complete' as const,
                priority: StateMachineService.COMPLETION_FALLBACK_PRIORITY,
              },
            ],
          };
        }

        return { ...state, transitions: normalizedExistingTransitions };
      }

      // Last state: terminal, no transition.
      if (isLastState) {
        return { ...state, transitions: [] };
      }

      // Default transition to the next state: completion-driven (goal states use
      // goal_achieved). A state with tasks becomes "complete" once the agent has
      // completed/skipped them all; an empty state advances immediately.
      this.logger.log(
        `Auto-generating transition for state '${state.id}' -> '${nextStateId}'`,
      );
      const defaultTransition: StateTransition = {
        target_state_id: nextStateId!,
        condition_type: stateType === 'goal' ? 'goal_achieved' : 'all_tasks_complete',
        priority: 1,
      };

      return { ...state, transitions: [defaultTransition] };
    });

    return { ...plan, states: statesWithTransitions };
  }

  /**
   * Initialize state machine for a session with a plan
   */
  async initializeForSession(
    sessionId: string,
    plan: PlanData,
  ): Promise<SessionState> {
    // Ensure all states have transitions
    const normalizedPlan = this.ensureTransitions(plan);

    const initialStateId = normalizedPlan.initial_state_id || normalizedPlan.states[0]?.id;

    if (!initialStateId) {
      throw new BadRequestException('Plan must have at least one state');
    }

    // If state already exists for this session, resume from it instead of resetting.
    // This preserves progress (completedTasks, deliverables, currentStateId) when an
    // agent is restarted after being paused for inactivity.
    const existingState = await this.prisma.sessionState.findUnique({
      where: { sessionId },
    });

    if (existingState) {
      this.logger.log(`Resuming existing state machine for session ${sessionId} (state: ${existingState.currentStateId}, tasks: ${existingState.completedTasks.length} completed)`);
      return existingState;
    }

    this.logger.log(`Initializing state machine for session ${sessionId} with plan ${normalizedPlan.id}`);

    return this.prisma.sessionState.create({
      data: {
        sessionId,
        planId: normalizedPlan.id,
        planData: normalizedPlan as unknown as Prisma.InputJsonValue,
        currentStateId: initialStateId,
        completedTasks: [],
        skippedTasks: [],
        deliverables: {},
        turnsWithoutProgress: 0,
        totalTurns: 0,
      },
    });
  }

  /**
   * Get state machine state for a session
   */
  async getState(sessionId: string): Promise<SessionState | null> {
    return this.prisma.sessionState.findUnique({
      where: { sessionId },
    });
  }

  /**
   * Complete a task by ID
   */
  async completeTask(
    sessionId: string,
    taskId: string,
    reasoning: string,
  ): Promise<StateMachineResult> {
    // Serialized per session so concurrent completions don't clobber each other.
    return this.withSessionLock(sessionId, () =>
      this.completeTaskLocked(sessionId, taskId, reasoning),
    );
  }

  private async completeTaskLocked(
    sessionId: string,
    taskId: string,
    _reasoning: string,  // Reserved for future audit logging; not used in current logic
  ): Promise<StateMachineResult> {
    const state = await this.getState(sessionId);
    if (!state) {
      return { success: false, error: 'State machine not initialized for this session' };
    }

    const plan = state.planData as unknown as PlanData;
    const currentState = this.getCurrentPlanState(plan, state.currentStateId);

    if (!currentState) {
      return { success: false, error: `Current state ${state.currentStateId} not found in plan` };
    }

    // Find the task
    const task = currentState.tasks.find(t => t.id === taskId);
    if (!task) {
      // Hybrid auto-advance (#291) can move the state forward the instant a
      // deliverable completes the final task, so a redundant complete_task the
      // agent emits in the SAME turn may arrive after we've already left that
      // task's state. If the task lives in an already-completed state, treat the
      // tick as a harmless no-op rather than erroring — the task is done.
      const owningState = plan.states.find(s => s.tasks?.some(t => t.id === taskId));
      if (owningState && this.isPlanStateComplete(state, owningState)) {
        return { success: true, taskCompleted: taskId };
      }
      const availableTaskIds = currentState.tasks.map(t => t.id);
      return {
        success: false,
        error: `Task '${taskId}' not found in current state. Available: ${availableTaskIds.join(', ')}`,
      };
    }

    // Check if task is already completed
    if (state.completedTasks.includes(taskId)) {
      return { success: true, taskCompleted: taskId }; // Already done
    }

    // Reliability invariant — owned by the state machine, never delegated to the
    // agent: a task that OWNS required deliverables may not be completed until
    // those deliverables have been collected. Completing it otherwise ticks the
    // task and, via `all_tasks_complete`, advances the state with its required
    // data missing (the observed bug: "Greet and ask for name" got completed on
    // a bare "Hello", jumping the conversation to the next phase before any name
    // was given). The agent still drives state — to move on WITHOUT the data it
    // must `skip_task` (an honest, distinct status), not `complete_task`.
    // Deliverable-less and optional-only tasks complete freely; the #291 hybrid
    // path (collecting the last required deliverable auto-advances the state) is
    // unaffected — that runs through set_deliverable, not here.
    const collectedDeliverables =
      state.deliverables as unknown as Record<string, DeliverableValue>;
    const missingRequired = this.uncollectedRequiredDeliverables(task, collectedDeliverables);
    if (missingRequired.length > 0) {
      this.logger.warn(
        `Rejected complete_task '${taskId}' for session ${sessionId}: ` +
          `required deliverable(s) not yet collected: ${missingRequired.join(', ')}`,
      );
      return {
        success: false,
        error:
          `Task '${taskId}' has required deliverable(s) not yet collected: ` +
          `${missingRequired.join(', ')}. Record them with set_deliverable first, ` +
          `or skip_task to move on without them.`,
      };
    }

    // Mark task as completed (and clear any prior skip of the same id).
    const updatedCompletedTasks = [...state.completedTasks, taskId];
    const updatedSkippedTasks = state.skippedTasks.filter(id => id !== taskId);

    await this.prisma.sessionState.update({
      where: { sessionId },
      data: {
        completedTasks: updatedCompletedTasks,
        skippedTasks: updatedSkippedTasks,
        turnsWithoutProgress: 0, // Reset counter on progress
      },
    });

    this.logger.log(`Task ${taskId} completed for session ${sessionId}`);

    // Check for state transitions
    const transitionResult = await this.evaluateAndTransition(sessionId);

    return {
      success: true,
      taskCompleted: taskId,
      transitioned: transitionResult.transitioned,
      newStateId: transitionResult.newStateId,
      newStateTitle: transitionResult.newStateTitle,
      sessionCompleted: transitionResult.sessionCompleted,
      farewellMessage: transitionResult.farewellMessage,
      summaryBehavior: transitionResult.summaryBehavior,
      progress: await this.calculateProgress(sessionId, {
        ...state,
        completedTasks: updatedCompletedTasks,
        turnsWithoutProgress: 0,
      } as SessionState),
    };
  }

  /**
   * Set a deliverable value
   */
  async setDeliverable(
    sessionId: string,
    key: string,
    value: unknown,
    reasoning: string,
    unconfirmed = false,
  ): Promise<StateMachineResult> {
    // Serialized per session so concurrent writes don't clobber the deliverables JSON.
    return this.withSessionLock(sessionId, () =>
      this.setDeliverableLocked(sessionId, key, value, reasoning, unconfirmed),
    );
  }

  private async setDeliverableLocked(
    sessionId: string,
    key: string,
    value: unknown,
    reasoning: string,
    unconfirmed = false,
  ): Promise<StateMachineResult> {
    const state = await this.getState(sessionId);
    if (!state) {
      return { success: false, error: 'State machine not initialized for this session' };
    }

    const plan = state.planData as unknown as PlanData;
    const currentState = this.getCurrentPlanState(plan, state.currentStateId);

    if (!currentState) {
      return { success: false, error: `Current state ${state.currentStateId} not found in plan` };
    }

    // Find the deliverable — search tasks first, then goal.deliverables
    let foundTask: PlanTask | null = null;
    let foundDeliverable: PlanDeliverable | null = null;
    let isGoalDeliverable = false;

    // 1. Search task-level deliverables (works for all state types)
    for (const task of currentState.tasks) {
      for (const deliverable of task.deliverables || []) {
        if (deliverable.key === key) {
          foundTask = task;
          foundDeliverable = deliverable;
          break;
        }
      }
      if (foundDeliverable) break;
    }

    // 2. For goal states, also search goal-level deliverables
    if (!foundDeliverable && currentState.type === 'goal' && currentState.goal?.deliverables) {
      for (const deliverable of currentState.goal.deliverables) {
        if (deliverable.key === key) {
          foundDeliverable = deliverable;
          isGoalDeliverable = true;
          break;
        }
      }
    }

    // 3. Handle not-found cases
    const deliverables = state.deliverables as unknown as Record<string, DeliverableValue>;

    if (!foundDeliverable && currentState.type === 'goal') {
      // Goal mode: accept as discovered insight
      this.logger.log(`[setDeliverable] Discovered insight '${key}' in goal state for session ${sessionId}`);
      deliverables[key] = {
        value,
        reasoning,
        collectedAt: new Date().toISOString(),
        discovered: true,
      };

      await this.prisma.sessionState.update({
        where: { sessionId },
        data: {
          deliverables: deliverables as unknown as Prisma.InputJsonValue,
          turnsWithoutProgress: 0,
        },
      });

      // Preserve existing semantics for generic discovered insights:
      // only the explicit goal completion marker should trigger transition evaluation.
      if (key !== '__goal_achieved__') {
        return {
          success: true,
          transitioned: false,
          progress: await this.calculateProgress(sessionId, {
            ...state,
            deliverables: deliverables as unknown as Prisma.JsonValue,
            turnsWithoutProgress: 0,
          } as SessionState),
        };
      }

      const transitionResult = await this.evaluateAndTransition(sessionId);

      return {
        success: true,
        transitioned: transitionResult.transitioned,
        newStateId: transitionResult.newStateId,
        newStateTitle: transitionResult.newStateTitle,
        progress: await this.calculateProgress(sessionId, {
          ...state,
          deliverables: deliverables as unknown as Prisma.JsonValue,
          turnsWithoutProgress: 0,
        } as SessionState),
      };
    }

    if (!foundDeliverable) {
      // Strict/loose mode: reject unknown keys
      const availableKeys = currentState.tasks
        .flatMap(t => t.deliverables || [])
        .map(d => d.key);
      return {
        success: false,
        error: `Deliverable '${key}' not found in current state. Available: ${availableKeys.join(', ')}`,
      };
    }

    // Update deliverables. The flag is written only when true, so confirming a
    // value (setting it again without the flag) clears it, and rows collected
    // before this existed stay exactly as they were.
    deliverables[key] = {
      value,
      reasoning,
      collectedAt: new Date().toISOString(),
      ...(unconfirmed ? { unconfirmed: true } : {}),
    };

    // Setting a deliverable ONLY records data — it never auto-completes a task or
    // goal. Completion is an explicit agent action via complete_task / skip_task
    // (#291 redesign: no state mutation is ever derived from deliverable presence).
    await this.prisma.sessionState.update({
      where: { sessionId },
      data: {
        deliverables: deliverables as unknown as Prisma.InputJsonValue,
        turnsWithoutProgress: 0,
      },
    });

    this.logger.log(`[setDeliverable] Deliverable '${key}' set for session ${sessionId}, value: ${JSON.stringify(value)}`);

    // Re-evaluate transitions: a deliverable can satisfy an author-defined
    // deliverable_value / deliverable_exists route (still agent-initiated, via this
    // tool). It can no longer fire all_tasks_complete on its own, since that now
    // requires the agent to have completed/skipped every task.
    const transitionResult = await this.evaluateAndTransition(sessionId);

    return {
      success: true,
      taskCompleted: undefined,
      transitioned: transitionResult.transitioned,
      newStateId: transitionResult.newStateId,
      newStateTitle: transitionResult.newStateTitle,
      sessionCompleted: transitionResult.sessionCompleted,
      farewellMessage: transitionResult.farewellMessage,
      summaryBehavior: transitionResult.summaryBehavior,
      progress: await this.calculateProgress(sessionId, {
        ...state,
        deliverables: deliverables as unknown as Prisma.JsonValue,
        turnsWithoutProgress: 0,
      } as SessionState),
    };
  }

  /**
   * Skip a single task. Mirrors completeTask, but records the task as *skipped*
   * rather than completed. `required` is informational only — the agent may skip
   * any task it judges unnecessary; skipping counts toward state completion the
   * same way completing does (#291 redesign).
   */
  async skipTask(
    sessionId: string,
    taskId: string,
    reasoning: string,
  ): Promise<StateMachineResult> {
    // Serialized per session so concurrent skips/completions don't clobber the arrays.
    return this.withSessionLock(sessionId, () =>
      this.skipTaskLocked(sessionId, taskId, reasoning),
    );
  }

  private async skipTaskLocked(
    sessionId: string,
    taskId: string,
    _reasoning: string,
  ): Promise<StateMachineResult> {
    const state = await this.getState(sessionId);
    if (!state) {
      return { success: false, error: 'State machine not initialized for this session' };
    }

    const plan = state.planData as unknown as PlanData;
    const currentState = this.getCurrentPlanState(plan, state.currentStateId);
    if (!currentState) {
      return { success: false, error: `Current state ${state.currentStateId} not found in plan` };
    }

    const task = currentState.tasks.find(t => t.id === taskId);
    if (!task) {
      // Mirror completeTask: a stray skip for a task whose state already
      // completed (e.g. after a hybrid auto-advance) is a harmless no-op.
      const owningState = plan.states.find(s => s.tasks?.some(t => t.id === taskId));
      if (owningState && this.isPlanStateComplete(state, owningState)) {
        return { success: true, taskSkipped: taskId };
      }
      const availableTaskIds = currentState.tasks.map(t => t.id);
      return {
        success: false,
        error: `Task '${taskId}' not found in current state. Available: ${availableTaskIds.join(', ')}`,
      };
    }

    if (state.skippedTasks.includes(taskId) || state.completedTasks.includes(taskId)) {
      return { success: true, taskSkipped: taskId }; // Already addressed
    }

    const updatedSkippedTasks = [...state.skippedTasks, taskId];

    await this.prisma.sessionState.update({
      where: { sessionId },
      data: {
        skippedTasks: updatedSkippedTasks,
        turnsWithoutProgress: 0, // Addressing a task is progress
      },
    });

    this.logger.log(`Task ${taskId} skipped for session ${sessionId}`);

    const transitionResult = await this.evaluateAndTransition(sessionId);

    return {
      success: true,
      taskSkipped: taskId,
      transitioned: transitionResult.transitioned,
      newStateId: transitionResult.newStateId,
      newStateTitle: transitionResult.newStateTitle,
      sessionCompleted: transitionResult.sessionCompleted,
      farewellMessage: transitionResult.farewellMessage,
      summaryBehavior: transitionResult.summaryBehavior,
      progress: await this.calculateProgress(sessionId, {
        ...state,
        skippedTasks: updatedSkippedTasks,
        turnsWithoutProgress: 0,
      } as SessionState),
    };
  }

  /**
   * Skip the remainder of a state: mark every not-yet-addressed task as skipped,
   * then evaluate transitions so the state advances. `stateId` is optional and
   * defaults to the current state; skipping a non-current state is rejected to
   * keep behavior predictable (#291 redesign).
   */
  async skipState(
    sessionId: string,
    stateId: string | undefined,
    reasoning: string,
  ): Promise<StateMachineResult> {
    // Serialized per session so a concurrent completion can't be lost mid-skip.
    return this.withSessionLock(sessionId, () =>
      this.skipStateLocked(sessionId, stateId, reasoning),
    );
  }

  private async skipStateLocked(
    sessionId: string,
    stateId: string | undefined,
    _reasoning: string,
  ): Promise<StateMachineResult> {
    const state = await this.getState(sessionId);
    if (!state) {
      return { success: false, error: 'State machine not initialized for this session' };
    }

    if (stateId && stateId !== state.currentStateId) {
      return {
        success: false,
        error: `Cannot skip '${stateId}': only the current state ('${state.currentStateId}') can be skipped.`,
      };
    }

    const plan = state.planData as unknown as PlanData;
    const currentState = this.getCurrentPlanState(plan, state.currentStateId);
    if (!currentState) {
      return { success: false, error: `Current state ${state.currentStateId} not found in plan` };
    }

    const addressed = new Set([...state.completedTasks, ...state.skippedTasks]);
    const newlySkipped = currentState.tasks
      .map(t => t.id)
      .filter(id => !addressed.has(id));

    const updatedSkippedTasks = [...state.skippedTasks, ...newlySkipped];

    await this.prisma.sessionState.update({
      where: { sessionId },
      data: {
        skippedTasks: updatedSkippedTasks,
        turnsWithoutProgress: 0,
      },
    });

    this.logger.log(
      `State ${state.currentStateId} skipped for session ${sessionId} (skipped tasks: ${JSON.stringify(newlySkipped)})`,
    );

    const transitionResult = await this.evaluateAndTransition(sessionId);

    return {
      success: true,
      stateSkipped: currentState.id,
      tasksSkipped: newlySkipped,
      transitioned: transitionResult.transitioned,
      newStateId: transitionResult.newStateId,
      newStateTitle: transitionResult.newStateTitle,
      sessionCompleted: transitionResult.sessionCompleted,
      farewellMessage: transitionResult.farewellMessage,
      summaryBehavior: transitionResult.summaryBehavior,
      progress: await this.calculateProgress(sessionId, {
        ...state,
        skippedTasks: updatedSkippedTasks,
        turnsWithoutProgress: 0,
      } as SessionState),
    };
  }

  /**
   * Get current state info
   */
  async getCurrentState(sessionId: string): Promise<CurrentStateInfo | null> {
    const state = await this.getState(sessionId);
    if (!state) return null;

    // Session has reached the end state; no active state to return.
    // Callers should check for null and treat it as session completed.
    if (state.currentStateId === END_STATE_ID) return null;

    const plan = state.planData as unknown as PlanData;
    const currentState = this.getCurrentPlanState(plan, state.currentStateId);

    if (!currentState) return null;

    return {
      stateId: currentState.id,
      stateTitle: currentState.title || currentState.id,
      stateType: currentState.type || 'loose',
      progress: await this.calculateProgress(sessionId, state),
      turnsWithoutProgress: state.turnsWithoutProgress,
      totalTurns: state.totalTurns,
      goal: currentState.goal,
    };
  }

  /**
   * Get pending tasks in current state
   *
   * Behavior depends on state type:
   * - LOOSE (flexible): Returns ALL pending tasks - LLM chooses order
   * - STRICT (sequential): Returns current task + next task as preview
   */
  async getPendingTasks(sessionId: string): Promise<PendingTaskInfo[]> {
    const state = await this.getState(sessionId);
    if (!state) return [];

    const plan = state.planData as unknown as PlanData;
    const currentState = this.getCurrentPlanState(plan, state.currentStateId);

    if (!currentState) return [];

    const pendingTasks: PendingTaskInfo[] = [];
    const deliverables = state.deliverables as unknown as Record<string, DeliverableValue>;

    for (const task of currentState.tasks) {
      // A task is "addressed" — and so no longer pending — when the agent has
      // explicitly completed/skipped it, OR (hybrid #291) its required
      // deliverables are all collected. This MUST match the canonical rule used
      // by isCurrentStateComplete / isPlanStateComplete / getFullState, so the
      // agent is never steered (esp. the strict-mode "current task" preview) to
      // re-work a task whose data is already in. `required` is surfaced for the
      // agent's information only; it never hides a task.
      if (state.completedTasks.includes(task.id)) continue;
      if (state.skippedTasks.includes(task.id)) continue;
      if (this.deliverablesSatisfyTask(task, deliverables)) continue;

      const taskDeliverables = task.deliverables || [];
      const hasDeliverables = taskDeliverables.length > 0;

      pendingTasks.push({
        id: task.id,
        description: task.description,
        instruction: task.instruction,
        required: task.required !== false,
        hasDeliverables,
        deliverableKeys: taskDeliverables.map(d => d.key),
      });
    }

    // Filter based on state type (strict vs loose vs goal)
    const stateType = currentState.type || 'loose';

    if (stateType === 'goal') {
      // GOAL mode: Return a single synthetic task representing the goal.
      // The agent sees information gaps (deliverables), not individual tasks.
      // Tasks auto-complete when their deliverables are set.
      const taskDeliverableKeys = pendingTasks.flatMap(t => t.deliverableKeys);

      // Also include goal-level deliverables
      const goalDeliverableKeys = (currentState.goal?.deliverables || [])
        .filter(d => !(d.key in deliverables))
        .map(d => d.key);

      const allDeliverableKeys = [...new Set([...taskDeliverableKeys, ...goalDeliverableKeys])];

      return [{
        id: '__goal__',
        description: currentState.goal?.objective || currentState.description || currentState.title || 'Complete this phase',
        instruction: [
          currentState.goal?.depth_guidance,
          currentState.goal?.success_description
            ? `Mark this goal as achieved when this success criteria is met: ${currentState.goal.success_description}\nWhen met, call setDeliverable("__goal_achieved__", true).`
            : 'Mark this goal as achieved when the objective is met.\nWhen met, call setDeliverable("__goal_achieved__", true).',
        ].filter(Boolean).join('\n\n'),
        required: true,
        hasDeliverables: true,
        deliverableKeys: allDeliverableKeys,
        isGoal: true,
      }];
    }

    if (stateType === 'strict') {
      // STRICT mode: Return only current task + next task as preview
      // This enables sequential progression with smooth transitions
      const result: PendingTaskInfo[] = [];

      if (pendingTasks.length > 0) {
        result.push(pendingTasks[0]); // Current task
      }
      if (pendingTasks.length > 1) {
        result.push({ ...pendingTasks[1], isPreview: true }); // Next task preview
      }

      return result;
    }

    // LOOSE mode: Return all pending tasks - LLM chooses order based on conversation
    return pendingTasks;
  }

  /**
   * Get pending deliverables in current state
   */
  async getPendingDeliverables(sessionId: string): Promise<PendingDeliverableInfo[]> {
    const state = await this.getState(sessionId);
    if (!state) return [];

    const plan = state.planData as unknown as PlanData;
    const currentState = this.getCurrentPlanState(plan, state.currentStateId);

    if (!currentState) return [];

    const pendingDeliverables: PendingDeliverableInfo[] = [];
    const deliverables = state.deliverables as unknown as Record<string, DeliverableValue>;

    for (const task of currentState.tasks) {
      // Skip tasks the agent already addressed (completed or skipped).
      if (state.completedTasks.includes(task.id)) continue;
      if (state.skippedTasks.includes(task.id)) continue;

      for (const deliverable of task.deliverables || []) {
        // Skip already collected deliverables
        if (deliverable.key in deliverables) continue;

        pendingDeliverables.push({
          key: deliverable.key,
          description: deliverable.description,
          type: deliverable.type || 'string',
          required: deliverable.required !== false,
          acceptanceCriteria: deliverable.acceptance_criteria,
          taskId: task.id,
        });
      }
    }

    // For goal states, also include goal-level deliverables
    if (currentState.type === 'goal' && currentState.goal?.deliverables) {
      const seenKeys = new Set(pendingDeliverables.map(p => p.key));
      for (const deliverable of currentState.goal.deliverables) {
        if (deliverable.key in deliverables) continue; // Already collected
        if (seenKeys.has(deliverable.key)) continue; // Already added from tasks
        pendingDeliverables.push({
          key: deliverable.key,
          description: deliverable.description,
          type: deliverable.type || 'string',
          required: deliverable.required !== false,
          acceptanceCriteria: deliverable.acceptance_criteria,
          taskId: '__goal__',
        });
      }
    }

    return pendingDeliverables;
  }

  /**
   * Increment turn counter (when no progress is made)
   */
  async incrementTurn(sessionId: string): Promise<{
    turnsWithoutProgress: number;
    transitioned: boolean;
    newStateId?: string;
    newStateTitle?: string;
    sessionCompleted?: boolean;
    farewellMessage?: string;
    summaryBehavior?: string;
  }> {
    // Serialized: counting a turn evaluates transitions (read-modify-write of the
    // current state), which must not interleave with a concurrent completion.
    return this.withSessionLock(sessionId, () => this.incrementTurnLocked(sessionId));
  }

  private async incrementTurnLocked(sessionId: string): Promise<{
    turnsWithoutProgress: number;
    transitioned: boolean;
    newStateId?: string;
    newStateTitle?: string;
    sessionCompleted?: boolean;
    farewellMessage?: string;
    summaryBehavior?: string;
  }> {
    const result = await this.prisma.sessionState.update({
      where: { sessionId },
      data: {
        turnsWithoutProgress: { increment: 1 },
        totalTurns: { increment: 1 },
      },
    });

    // Counting a turn is itself a transition trigger. turn_count_exceeded — the
    // natural fallback for optional/goal states — can only fire if we re-evaluate
    // here; nothing else does after a no-progress turn, so without this the
    // counter crosses the threshold but no transition ever happens (#172).
    const transition = await this.evaluateAndTransition(sessionId);

    return {
      // A transition resets turnsWithoutProgress to 0; surface the post-eval value.
      turnsWithoutProgress: transition.transitioned ? 0 : result.turnsWithoutProgress,
      transitioned: transition.transitioned,
      newStateId: transition.newStateId,
      newStateTitle: transition.newStateTitle,
      sessionCompleted: transition.sessionCompleted,
      farewellMessage: transition.farewellMessage,
      summaryBehavior: transition.summaryBehavior,
    };
  }

  /**
   * Record a turn with progress (resets turns without progress)
   */
  async recordProgressTurn(sessionId: string): Promise<void> {
    await this.prisma.sessionState.update({
      where: { sessionId },
      data: {
        turnsWithoutProgress: 0,
        totalTurns: { increment: 1 },
      },
    });
  }

  /**
   * Get all collected deliverables
   */
  async getCollectedDeliverables(
    sessionId: string,
  ): Promise<Record<string, unknown>> {
    const state = await this.getState(sessionId);
    if (!state) return {};

    const deliverables = state.deliverables as unknown as Record<string, DeliverableValue>;
    const result: Record<string, unknown> = {};

    for (const [key, data] of Object.entries(deliverables)) {
      result[key] = data.value;
    }

    return result;
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private getCurrentPlanState(plan: PlanData, stateId: string): PlanState | null {
    return plan.states.find(s => s.id === stateId) || null;
  }

  /**
   * Safety-net release target (#291). Returns the next state in plan order when the
   * current state has been stuck for STUCK_STATE_TURN_LIMIT turns without progress
   * (the agent never completed/skipped its tasks), or undefined otherwise — including
   * for the last state, which is terminal and has nowhere to advance to.
   */
  private stuckStateReleaseTarget(
    plan: PlanData,
    currentState: PlanState,
    state: SessionState,
  ): string | undefined {
    if (state.turnsWithoutProgress < StateMachineService.STUCK_STATE_TURN_LIMIT) {
      return undefined;
    }
    const index = plan.states.findIndex(s => s.id === currentState.id);
    if (index < 0 || index >= plan.states.length - 1) {
      return undefined; // last state / not found: nothing to release to
    }
    return plan.states[index + 1].id;
  }

  private async calculateProgress(
    sessionId: string,
    preloadedState?: SessionState,
  ): Promise<number> {
    const state = preloadedState ?? await this.getState(sessionId);
    if (!state) return 0;

    const plan = state.planData as unknown as PlanData;
    let totalRequired = 0;
    let completedRequired = 0;

    const deliverables = state.deliverables as unknown as Record<string, DeliverableValue>;

    for (const planState of plan.states) {
      const countedKeys = new Set<string>();

      // Count goal-level deliverables first (for goal states)
      if (planState.type === 'goal' && planState.goal?.deliverables) {
        for (const d of planState.goal.deliverables) {
          if (d.required === false) continue;
          countedKeys.add(d.key);
          totalRequired++;
          if (d.key in deliverables && !deliverables[d.key]?.discovered) {
            completedRequired++;
          }
        }
      }

      for (const task of planState.tasks) {
        if (task.required === false) continue;

        const taskDeliverables = task.deliverables || [];
        if (taskDeliverables.length === 0) {
          // Task without deliverables
          totalRequired++;
          if (state.completedTasks.includes(task.id)) {
            completedRequired++;
          }
        } else {
          // Count required deliverables (skip if already counted from goal.deliverables)
          for (const d of taskDeliverables) {
            if (d.required === false) continue;
            if (countedKeys.has(d.key)) continue; // Deduplicate
            countedKeys.add(d.key);
            totalRequired++;
            if (d.key in deliverables && !deliverables[d.key]?.discovered) {
              completedRequired++;
            }
          }
        }
      }
    }

    if (totalRequired === 0) return 100;
    return Math.round((completedRequired / totalRequired) * 100);
  }

  /**
   * Whether the current (non-goal) state is complete for the `all_tasks_complete`
   * transition.
   *
   * #291 redesign — completion is now a fact the AGENT asserts, never one derived
   * from `required`/optional heuristics:
   * - A state is complete only when EVERY task has been explicitly completed or
   *   skipped by the agent. `required` is informational; an optional task still
   *   has to be addressed (ticked or skipped) — it is not silently auto-satisfied.
   * - There is no vacuous-truth case: a state with tasks is never "complete" on
   *   entry, because no task has been addressed yet.
   * - Goal states keep their own semantics: deliverable-less tasks are guidance
   *   scaffolding (non-blocking) and completion is driven by `goal_achieved` /
   *   goal-level deliverables, not task ticks.
   */
  /**
   * #291 hybrid completion. A task that OWNS deliverables is treated as
   * addressed once EVERY required deliverable it owns has been collected — the
   * agent does not also have to fire `complete_task`. This keeps completion
   * derivable from data (reliable) instead of depending on the model
   * remembering a second, redundant tool call after `set_deliverable`.
   *
   * A task with NO required deliverable (deliverable-less, or only optional
   * deliverables) is NOT auto-satisfied: there is no data-defined completion
   * bar, and auto-completing it on entry would reintroduce the vacuous-truth
   * case #291 set out to remove. Those tasks still need an explicit
   * `complete_task` / `skip_task`.
   *
   * Multi-deliverable tasks therefore only count when ALL required deliverables
   * are present. Discovered (goal-mode) insights never satisfy a required key.
   */
  /**
   * Required deliverable keys a task still OWES: declared `required` (not
   * `required === false`) and not yet collected. A discovered (goal-mode) insight
   * does not count as satisfying a required key — mirrors `deliverablesSatisfyTask`.
   * Empty for deliverable-less or optional-only tasks. Used to gate `complete_task`
   * so a task can't be ticked (and advance the state) before its required data
   * exists.
   */
  private uncollectedRequiredDeliverables(
    task: PlanTask,
    deliverables: Record<string, DeliverableValue>,
  ): string[] {
    return (task.deliverables || [])
      .filter(d => d.required !== false)
      .filter(d => !(d.key in deliverables) || deliverables[d.key]?.discovered)
      .map(d => d.key);
  }

  private deliverablesSatisfyTask(
    task: PlanTask,
    deliverables: Record<string, DeliverableValue>,
  ): boolean {
    const all = task.deliverables || [];
    if (all.length === 0) return false; // deliverable-less -> explicit tick only

    const isCollected = (d: PlanDeliverable) =>
      d.key in deliverables && !deliverables[d.key]?.discovered;

    const required = all.filter(d => d.required !== false);
    if (required.length > 0) {
      // Required deliverables gate completion; optional ones never block.
      return required.every(isCollected);
    }

    // All-optional task. There is no required deliverable to gate on, but we
    // must NOT vacuously complete it on entry (the #213/#291 on-screen bug).
    // Plan generators routinely mark EVERY deliverable optional, so a
    // required-only rule would mean these tasks never auto-complete and the
    // agent's explicit complete_task — frequently issued a turn late — becomes
    // the only way forward (the observed "advances a turn late" lag). Treat the
    // task as addressed once every deliverable it declares has actually been
    // collected: nothing on entry, done once the data is in.
    return all.every(isCollected);
  }

  private isCurrentStateComplete(
    state: SessionState,
    currentState: PlanState,
  ): boolean {
    const deliverables = state.deliverables as unknown as Record<string, DeliverableValue>;
    const stateType = currentState.type || 'loose';
    const addressed = new Set([...state.completedTasks, ...state.skippedTasks]);

    this.logger.log(
      `[isCurrentStateComplete] Checking state '${currentState.id}' (type: ${stateType}) — ` +
        `completed: ${JSON.stringify(state.completedTasks)}, skipped: ${JSON.stringify(state.skippedTasks)}`,
    );

    for (const task of currentState.tasks) {
      if (addressed.has(task.id)) continue; // agent completed or skipped it

      // In goal mode, deliverable-less tasks are guidance/action scaffolding and
      // do not block; goal completion is driven by goal markers/deliverables.
      if (stateType === 'goal' && (!task.deliverables || task.deliverables.length === 0)) {
        continue;
      }

      // #291 hybrid: a deliverable-bearing task is addressed once all its
      // required deliverables are collected, even without an explicit
      // complete_task — so collecting the last deliverable advances the state.
      if (this.deliverablesSatisfyTask(task, deliverables)) {
        continue;
      }

      // Any task the agent has not yet completed/skipped (and whose required
      // deliverables are not all collected) blocks completion — regardless of
      // whether it is required or optional.
      this.logger.log(
        `[isCurrentStateComplete] Task '${task.id}' not completed/skipped — state NOT complete`,
      );
      return false;
    }

    // For goal states, also require goal-level required deliverables.
    if (stateType === 'goal' && currentState.goal?.deliverables) {
      for (const d of currentState.goal.deliverables) {
        if (d.required === false) continue;
        if (!(d.key in deliverables)) {
          this.logger.log(
            `[isCurrentStateComplete] Required goal deliverable '${d.key}' NOT found - state NOT complete`,
          );
          return false;
        }
      }
    }

    this.logger.log(`[isCurrentStateComplete] All tasks addressed - state IS complete`);
    return true;
  }

  /**
   * Whether an arbitrary plan state is complete, for the DISPLAY layer
   * (getFullState marks per-state badges so backward jumps don't mismark states).
   *
   * Must use the SAME definition as isCurrentStateComplete (#291): a state is
   * complete only when every task has been explicitly completed or skipped by the
   * agent. This is what fixes the on-screen bug where a future all-optional state
   * rendered as "completed" — previously this function skipped optional tasks
   * (`required === false`) and so returned true vacuously.
   */
  private isPlanStateComplete(state: SessionState, planState: PlanState): boolean {
    const deliverables = state.deliverables as unknown as Record<string, DeliverableValue>;
    const stateType = planState.type || 'loose';
    const addressed = new Set([...state.completedTasks, ...state.skippedTasks]);

    for (const task of planState.tasks) {
      if (addressed.has(task.id)) continue;
      // Goal-mode deliverable-less tasks are non-blocking scaffolding.
      if (stateType === 'goal' && (!task.deliverables || task.deliverables.length === 0)) {
        continue;
      }
      // #291 hybrid: deliverable-bearing task is addressed when all its required
      // deliverables are collected (mirrors isCurrentStateComplete).
      if (this.deliverablesSatisfyTask(task, deliverables)) {
        continue;
      }
      // An unaddressed task (required or optional) means the state is not complete.
      return false;
    }

    if (planState.type === 'goal' && planState.goal?.deliverables) {
      for (const d of planState.goal.deliverables) {
        if (d.required === false) continue;
        if (!(d.key in deliverables)) return false;
      }
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Condition evaluation infrastructure (ported from main, kept as standalones
  // so the loop in evaluateAndTransition can call them without an inline switch).
  // ---------------------------------------------------------------------------

  /**
   * Coerce any value to a finite number.
   * Returns null for null/undefined/empty/non-numeric/NaN/Infinity so callers
   * can treat null as "misconfigured" without separate type checks.
   */
  private toFiniteNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;

    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Normalise a string for loose equality comparisons (trim + lower-case).
   * Centralised so every condition that compares strings uses identical logic.
   */
  private normalizeStringValue(value: string): string {
    return value.trim().toLowerCase();
  }

  /**
   * Compare two values with consistent semantics across all condition types:
   *   - strings  → case-insensitive, trimmed
   *   - anything else → strict equality (===)
   */
  private areValuesEqualLoose(actual: unknown, expected: unknown): boolean {
    if (typeof actual === 'string' && typeof expected === 'string') {
      return this.normalizeStringValue(actual) === this.normalizeStringValue(expected);
    }
    return actual === expected;
  }

  private isGoalAchievedValue(raw: unknown): boolean {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number') return raw === 1;
    if (typeof raw === 'string') {
      const normalized = this.normalizeStringValue(raw);
      return ['true', 'yes', '1', 'done', 'completed', 'complete', 'achieved', 'met'].includes(normalized);
    }
    return false;
  }

  /**
   * Map operator strings (including symbolic aliases) to canonical keys.
   * Returns null when the operator is unrecognised, so callers can fail-closed.
   */
  private normalizeNumericOperator(
    operator: unknown,
  ): 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'between' | null {
    if (typeof operator !== 'string') return null;

    const op = operator.toLowerCase();
    const aliases: Record<string, 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'between'> = {
      gt: 'gt',
      '>': 'gt',
      gte: 'gte',
      '>=': 'gte',
      lt: 'lt',
      '<': 'lt',
      lte: 'lte',
      '<=': 'lte',
      eq: 'eq',
      '==': 'eq',
      neq: 'neq',
      '!=': 'neq',
      between: 'between',
      range: 'between',
    };

    return aliases[op] ?? null;
  }

  /** Centralised warning helper so all condition logs share the same prefix. */
  private warnInvalidCondition(message: string): void {
    this.logger.warn(`[evaluateAndTransition] ${message}`);
  }

  /**
   * Validate one condition config node before runtime evaluation.
   * Called by evaluateAndTransition() before invoking evaluateTransitionCondition()
   * so that malformed plan data fails closed with a deterministic warning instead
   * of throwing or silently returning false.
   */
  private validateConditionConfig(
    conditionType: string,
    conditionConfig: Record<string, unknown> | undefined,
    currentState: PlanState,
    depth = 0,
  ): { valid: boolean; error?: string } {
    if (depth > StateMachineService.MAX_CONDITION_DEPTH) {
      return {
        valid: false,
        error: `condition nesting exceeds max depth (${StateMachineService.MAX_CONDITION_DEPTH})`,
      };
    }

    switch (conditionType) {
      case 'all_tasks_complete':
        if ((currentState.type || 'loose') === 'goal') {
          return { valid: false, error: `'all_tasks_complete' is not supported for goal states` };
        }
        return { valid: true };
      case 'goal_achieved':
        if ((currentState.type || 'loose') !== 'goal') {
          return { valid: false, error: `'goal_achieved' is only supported for goal states` };
        }
        return { valid: true };

      case 'turn_count_exceeded': {
        const rawThreshold = conditionConfig?.turns ?? conditionConfig?.value;
        const threshold = this.toFiniteNumber(rawThreshold);
        if (threshold === null || threshold < 0) {
          return { valid: false, error: `'turns'/'value' must be a non-negative number` };
        }

        const scope = String(conditionConfig?.scope || 'without_progress').toLowerCase();
        if (scope !== 'without_progress' && scope !== 'total') {
          return { valid: false, error: `'scope' must be 'without_progress' or 'total'` };
        }
        return { valid: true };
      }

      case 'deliverable_value': {
        const key = conditionConfig?.key;
        if (typeof key !== 'string' || key.trim() === '') {
          return { valid: false, error: `'key' is required for deliverable_value` };
        }
        if (!conditionConfig || !Object.prototype.hasOwnProperty.call(conditionConfig, 'value')) {
          return { valid: false, error: `'value' is required for deliverable_value` };
        }
        return { valid: true };
      }

      case 'deliverable_value_in': {
        const key = conditionConfig?.key;
        const values = conditionConfig?.values;
        if (typeof key !== 'string' || key.trim() === '') {
          return { valid: false, error: `'key' is required for deliverable_value_in` };
        }
        if (!Array.isArray(values) || values.length === 0) {
          return { valid: false, error: `'values' must be a non-empty array` };
        }
        return { valid: true };
      }

      case 'deliverable_value_numeric': {
        const key = conditionConfig?.key;
        if (typeof key !== 'string' || key.trim() === '') {
          return { valid: false, error: `'key' is required for deliverable_value_numeric` };
        }

        const operator = this.normalizeNumericOperator(conditionConfig?.operator);
        if (!operator) {
          return {
            valid: false,
            error: `'operator' is required and must be one of gt/gte/lt/lte/eq/neq/between`,
          };
        }

        if (operator === 'between') {
          const minValue = this.toFiniteNumber(conditionConfig?.min);
          const maxValue = this.toFiniteNumber(conditionConfig?.max);
          if (minValue === null || maxValue === null || minValue > maxValue) {
            return {
              valid: false,
              error: `'between' requires numeric min/max with min <= max`,
            };
          }
          return { valid: true };
        }

        const value = this.toFiniteNumber(conditionConfig?.value);
        if (value === null) {
          return { valid: false, error: `'value' must be numeric for numeric operators` };
        }
        return { valid: true };
      }

      case 'deliverable_exists': {
        const key = conditionConfig?.key;
        if (typeof key !== 'string' || key.trim() === '') {
          return { valid: false, error: `'key' is required for deliverable_exists` };
        }
        return { valid: true };
      }

      // Composite conditions — delegate child validation recursively.
      case 'all_of':
      case 'any_of':
        return this.validateCompositeConditionConfig(conditionConfig, currentState, depth + 1);

      case 'compound': {
        const operator = String(conditionConfig?.operator || '').toLowerCase();
        if (operator !== 'and' && operator !== 'or') {
          return { valid: false, error: `'operator' must be 'and' or 'or' for compound` };
        }
        return this.validateCompositeConditionConfig(conditionConfig, currentState, depth + 1);
      }

      default:
        return { valid: false, error: `unknown condition type '${conditionType}'` };
    }
  }

  /**
   * Validate the shared child-conditions array used by all_of / any_of / compound.
   * Recurses into each child so deeply-nested composite configs are fully checked.
   */
  private validateCompositeConditionConfig(
    conditionConfig: Record<string, unknown> | undefined,
    currentState: PlanState,
    depth: number,
  ): { valid: boolean; error?: string } {
    const conditions = conditionConfig?.conditions;
    if (!Array.isArray(conditions) || conditions.length === 0) {
      return { valid: false, error: `'conditions' must be a non-empty array` };
    }

    for (let i = 0; i < conditions.length; i++) {
      const child = conditions[i];
      if (!child || typeof child !== 'object') {
        return { valid: false, error: `conditions[${i}] must be an object` };
      }

      const childRecord = child as Record<string, unknown>;
      // Accept both the canonical 'condition_type' key and the shorter 'type' alias
      // so plan authors aren't forced to use the verbose key in nested conditions.
      const childType = childRecord.condition_type ?? childRecord.type;
      if (typeof childType !== 'string' || childType.trim() === '') {
        return { valid: false, error: `conditions[${i}] missing valid condition_type` };
      }

      const childConfigRaw = childRecord.condition_config ?? childRecord.config;
      const childConfig =
        childConfigRaw && typeof childConfigRaw === 'object'
          ? (childConfigRaw as Record<string, unknown>)
          : undefined;

      const childResult = this.validateConditionConfig(
        childType,
        childConfig,
        currentState,
        depth,
      );
      if (!childResult.valid) {
        return {
          valid: false,
          error: `conditions[${i}] invalid: ${childResult.error || 'unknown error'}`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Evaluate a single condition node against the current session state.
   *
   * Handles all 10 condition types including recursive composite conditions
   * (all_of / any_of / compound).  The depth parameter guards against
   * infinite recursion from malformed plans.
   *
   * Always call validateConditionConfig() before this method — validation is
   * kept separate so the loop can skip transitions cleanly with a warning
   * rather than relying on scattered defensive checks here.
   */
  private evaluateTransitionCondition(
    conditionType: string,
    conditionConfig: Record<string, unknown> | undefined,
    state: SessionState,
    currentState: PlanState,
    deliverables: Record<string, DeliverableValue>,
    depth = 0,
  ): boolean {
    // Safety net: validation should already catch this, but guard here too.
    if (depth > StateMachineService.MAX_CONDITION_DEPTH) {
      this.warnInvalidCondition(
        `Condition nesting too deep (depth=${depth}) for type='${conditionType}'`,
      );
      return false;
    }

    switch (conditionType) {
      case 'all_tasks_complete':
        if ((currentState.type || 'loose') === 'goal') {
          this.warnInvalidCondition(
            `'all_tasks_complete' is not supported for goal states; use 'goal_achieved' or deliverable-based conditions`,
          );
          return false;
        }
        // Delegates to the existing helper that checks required tasks & deliverables.
        return this.isCurrentStateComplete(state, currentState);
      case 'goal_achieved': {
        if ((currentState.type || 'loose') !== 'goal') {
          this.warnInvalidCondition(
            `'goal_achieved' is only supported for goal states`,
          );
          return false;
        }
        return this.isGoalAchievedValue(deliverables.__goal_achieved__?.value);
      }

      case 'turn_count_exceeded': {
        // Supports two scopes:
        //   'without_progress' (default) – turns since last deliverable was set
        //   'total'                      – total turns in the session
        const rawThreshold = conditionConfig?.turns ?? conditionConfig?.value;
        const thresholdNumber = this.toFiniteNumber(rawThreshold);
        const scope = String(conditionConfig?.scope || 'without_progress').toLowerCase();

        if (thresholdNumber === null || thresholdNumber < 0) {
          this.warnInvalidCondition(
            `'turn_count_exceeded' misconfigured: threshold must be a non-negative number (received '${String(rawThreshold)}')`,
          );
          return false;
        }

        const threshold = Math.floor(thresholdNumber);
        if (scope === 'without_progress') return state.turnsWithoutProgress >= threshold;
        if (scope === 'total') return state.totalTurns >= threshold;

        this.warnInvalidCondition(
          `'turn_count_exceeded' misconfigured: unsupported scope '${scope}'`,
        );
        return false;
      }

      case 'deliverable_value': {
        // Loose equality: strings are trimmed and compared case-insensitively.
        const key = conditionConfig?.key as string;
        const expected = conditionConfig?.value;
        const actual = deliverables[key]?.value;
        return this.areValuesEqualLoose(actual, expected);
      }

      case 'deliverable_value_in': {
        // True when the deliverable value matches any entry in the values array.
        const key = conditionConfig?.key as string;
        const expectedValues = conditionConfig?.values;
        const actual = deliverables[key]?.value;

        if (!Array.isArray(expectedValues)) {
          this.warnInvalidCondition(
            `'deliverable_value_in' misconfigured for key='${key}': 'values' must be an array`,
          );
          return false;
        }

        return expectedValues.some((expectedValue) =>
          this.areValuesEqualLoose(actual, expectedValue),
        );
      }

      case 'deliverable_value_numeric': {
        // Numeric comparison with operator aliases (gt/>/gte/>=/ etc.) and
        // an inclusive 'between' range variant.
        const numericKey = conditionConfig?.key as string | undefined;
        const rawOperator = conditionConfig?.operator as string | undefined;
        const numericActualRaw = numericKey ? deliverables[numericKey]?.value : undefined;
        const numericActual = this.toFiniteNumber(numericActualRaw);

        if (!numericKey) {
          this.warnInvalidCondition(`'deliverable_value_numeric' misconfigured: missing 'key'`);
          return false;
        }

        const operator = this.normalizeNumericOperator(rawOperator);
        if (!operator) {
          this.warnInvalidCondition(
            `'deliverable_value_numeric' misconfigured for key='${numericKey}': unsupported operator '${String(rawOperator)}'`,
          );
          return false;
        }

        if (numericActual === null) {
          this.warnInvalidCondition(
            `'deliverable_value_numeric' key='${numericKey}' has non-numeric actual value: ${JSON.stringify(numericActualRaw)}`,
          );
          return false;
        }

        if (operator === 'gt') {
          const expectedValue = this.toFiniteNumber(conditionConfig?.value);
          return expectedValue !== null && numericActual > expectedValue;
        }
        if (operator === 'gte') {
          const expectedValue = this.toFiniteNumber(conditionConfig?.value);
          return expectedValue !== null && numericActual >= expectedValue;
        }
        if (operator === 'lt') {
          const expectedValue = this.toFiniteNumber(conditionConfig?.value);
          return expectedValue !== null && numericActual < expectedValue;
        }
        if (operator === 'lte') {
          const expectedValue = this.toFiniteNumber(conditionConfig?.value);
          return expectedValue !== null && numericActual <= expectedValue;
        }
        if (operator === 'eq') {
          const expectedValue = this.toFiniteNumber(conditionConfig?.value);
          return expectedValue !== null && numericActual === expectedValue;
        }
        if (operator === 'neq') {
          const expectedValue = this.toFiniteNumber(conditionConfig?.value);
          return expectedValue !== null && numericActual !== expectedValue;
        }
        if (operator === 'between') {
          const minValue = this.toFiniteNumber(conditionConfig?.min);
          const maxValue = this.toFiniteNumber(conditionConfig?.max);
          // Default inclusive; set inclusive:false for open-interval behaviour.
          const inclusive = conditionConfig?.inclusive !== false;

          if (minValue === null || maxValue === null || minValue > maxValue) {
            this.warnInvalidCondition(
              `'deliverable_value_numeric' misconfigured for key='${numericKey}': invalid range min='${conditionConfig?.min}' max='${conditionConfig?.max}'`,
            );
            return false;
          }

          return inclusive
            ? numericActual >= minValue && numericActual <= maxValue
            : numericActual > minValue && numericActual < maxValue;
        }

        this.warnInvalidCondition(
          `'deliverable_value_numeric' misconfigured for key='${numericKey}': unsupported operator '${rawOperator}'`,
        );
        return false;
      }

      case 'deliverable_exists': {
        // Presence check only — value is irrelevant.
        const existsKey = conditionConfig?.key as string;
        return existsKey in deliverables;
      }

      // Composite conditions — delegate to evaluateCompositeCondition().
      case 'all_of':
        return this.evaluateCompositeCondition(
          'and', conditionConfig, state, currentState, deliverables, depth + 1,
        );

      case 'any_of':
        return this.evaluateCompositeCondition(
          'or', conditionConfig, state, currentState, deliverables, depth + 1,
        );

      case 'compound': {
        // 'compound' is the explicit-operator variant of all_of/any_of.
        const operator = String(conditionConfig?.operator || '').toLowerCase();
        if (operator !== 'and' && operator !== 'or') {
          this.warnInvalidCondition(`'compound' misconfigured: operator must be 'and' or 'or'`);
          return false;
        }
        return this.evaluateCompositeCondition(
          operator, conditionConfig, state, currentState, deliverables, depth + 1,
        );
      }

      default:
        this.warnInvalidCondition(`Unknown condition type: '${conditionType}'`);
        return false;
    }
  }

  /**
   * Evaluate a list of child conditions with AND or OR semantics.
   * Used by all_of, any_of, and compound condition types.
   *
   * Each child object supports both the canonical 'condition_type'/'condition_config'
   * keys and shorter 'type'/'config' aliases for easier plan authoring.
   */
  private evaluateCompositeCondition(
    operator: 'and' | 'or',
    conditionConfig: Record<string, unknown> | undefined,
    state: SessionState,
    currentState: PlanState,
    deliverables: Record<string, DeliverableValue>,
    depth: number,
  ): boolean {
    const rawConditions = conditionConfig?.conditions;
    if (!Array.isArray(rawConditions) || rawConditions.length === 0) {
      this.warnInvalidCondition(
        `Composite condition misconfigured: 'conditions' must be a non-empty array`,
      );
      return false;
    }

    const evaluateChild = (child: unknown): boolean => {
      if (!child || typeof child !== 'object') {
        this.warnInvalidCondition(
          `Composite condition has invalid child: ${JSON.stringify(child)}`,
        );
        return false;
      }

      const childRecord = child as Record<string, unknown>;
      // Accept both canonical and short-form keys (see validateCompositeConditionConfig).
      const childType = (childRecord.condition_type ?? childRecord.type) as string | undefined;
      const childConfig = (childRecord.condition_config ??
        childRecord.config) as Record<string, unknown> | undefined;

      if (!childType || typeof childType !== 'string') {
        this.warnInvalidCondition(`Composite child missing valid 'condition_type'`);
        return false;
      }

      return this.evaluateTransitionCondition(
        childType, childConfig, state, currentState, deliverables, depth,
      );
    };

    // AND: every child must be true. OR: at least one child must be true.
    return operator === 'and'
      ? rawConditions.every((child) => evaluateChild(child))
      : rawConditions.some((child) => evaluateChild(child));
  }

  // ---------------------------------------------------------------------------

  private async evaluateAndTransition(
    sessionId: string,
  ): Promise<{ transitioned: boolean; newStateId?: string; newStateTitle?: string; sessionCompleted?: boolean; farewellMessage?: string; summaryBehavior?: string }> {
    const state = await this.getState(sessionId);
    if (!state) {
      this.logger.log(`[evaluateAndTransition] No state found for session ${sessionId}`);
      return { transitioned: false };
    }

    // Normalize the plan to ensure transitions exist (fixes plans created without transitions)
    const rawPlan = state.planData as unknown as PlanData;
    const plan = this.ensureTransitions(rawPlan);
    const deliverables = state.deliverables as unknown as Record<string, DeliverableValue>;
    let currentStateId = state.currentStateId;
    let transitioned = false;
    let lastStateId: string | undefined;
    let lastStateTitle: string | undefined;
    const visitedStateIds = new Set<string>([currentStateId]);

    this.logger.log(
      `[evaluateAndTransition] Session ${sessionId}, current state: '${currentStateId}'`,
    );

    // Declare i outside the loop so we can check it afterwards to determine
    // whether the loop ran to exhaustion or exited early via break.
    let i = 0;
    for (; i < StateMachineService.MAX_TRANSITIONS_PER_TURN; i++) {
      const currentState = this.getCurrentPlanState(plan, currentStateId);
      if (!currentState) {
        this.logger.log(`[evaluateAndTransition] Current state not found in plan`);
        break;
      }

      if (!currentState.transitions || currentState.transitions.length === 0) {
        this.logger.log(
          `[evaluateAndTransition] State '${currentState.id}' has no transitions defined`,
        );
        break;
      }

      this.logger.log(
        `[evaluateAndTransition] State '${currentState.id}' has ${currentState.transitions.length} transition(s)`,
      );

      // Use ?? instead of || so that priority:0 (highest urgency) is respected.
      // With ||, 0 is falsy and would be replaced by 100, silently demoting the
      // highest-priority transition to the default bucket.
      const sortedTransitions = [...currentState.transitions].sort(
        (a, b) => (a.priority ?? 100) - (b.priority ?? 100),
      );

      // Collect per-transition evaluation details for a single decision summary log.
      const evaluated: Array<{
        target: string;
        condition: string;
        priority: number;
        matched: boolean;
      }> = [];
      // Keep only transitions that matched; winner is selected by sorted priority order.
      const matchedTransitions: typeof sortedTransitions = [];

      for (const transition of sortedTransitions) {
        let conditionMet = false;
        // ?? ensures priority:0 is kept as-is; || would treat 0 as falsy and use 100 instead.
        const priority = transition.priority ?? 100;

        this.logger.log(
          `[evaluateAndTransition] Checking transition to '${transition.target_state_id}' with condition '${transition.condition_type}'`,
        );

        // Validate the condition config before evaluation so malformed plan data
        // fails closed with a warning instead of silently returning false or throwing.
        const validation = this.validateConditionConfig(
          transition.condition_type,
          transition.condition_config,
          currentState,
        );
        if (!validation.valid) {
          this.warnInvalidCondition(
            `Skipping transition to '${transition.target_state_id}' — invalid config for '${transition.condition_type}': ${validation.error ?? 'unknown validation error'}`,
          );
          // Record the skipped transition in the decision summary so it is visible in logs.
          evaluated.push({
            target: transition.target_state_id,
            condition: transition.condition_type,
            priority,
            matched: false,
          });
          continue;
        }

        // Delegate evaluation to the standalone helper that handles all 9 condition types
        // (including composite all_of / any_of / compound).  The loop guard, cycle
        // detection, and decision summary logging remain here in the loop.
        conditionMet = this.evaluateTransitionCondition(
          transition.condition_type,
          transition.condition_config,
          state,
          currentState,
          deliverables,
        );
        this.logger.log(
          `[evaluateAndTransition] Condition '${transition.condition_type}' result: ${conditionMet}`,
        );

        evaluated.push({
          target: transition.target_state_id,
          condition: transition.condition_type,
          priority,
          matched: conditionMet,
        });

        if (conditionMet) {
          matchedTransitions.push(transition);
        }
      }

      // Summary log: which conditions were checked and which matched.
      const matchedSummary = matchedTransitions.map(t => ({
        target: t.target_state_id,
        condition: t.condition_type,
        priority: t.priority ?? 100, // ?? preserves explicit priority:0
      }));
      this.logger.log(
        `[evaluateAndTransition] Decision summary: evaluated=${JSON.stringify(evaluated)}, matched=${JSON.stringify(matchedSummary)}`,
      );

      // Deterministic winner: first matched transition after priority sort.
      const winner = matchedTransitions[0];
      let matchedTargetId: string | undefined;
      let matchedTargetTitle: string | undefined;

      if (winner) {
        if (
          matchedTransitions.length > 1 &&
          // ?? so that an explicit priority:0 is not mistaken for "no priority set".
          (matchedTransitions[0].priority ?? 100) === (matchedTransitions[1].priority ?? 100)
        ) {
          this.logger.log(
            `[evaluateAndTransition] Priority tie detected at ${winner.priority ?? 100}; winner target='${winner.target_state_id}' (stable sorted order)`,
          );
        }

        // END_STATE_ID is a reserved sentinel — not in plan.states — so skip the lookup.
        if (winner.target_state_id === END_STATE_ID) {
          matchedTargetId = END_STATE_ID;
          matchedTargetTitle = 'End';
          this.logger.log(
            `[evaluateAndTransition] Winner targets end state: condition='${winner.condition_type}', priority=${winner.priority ?? 100}`,
          );
        } else {
          const targetState = plan.states.find(s => s.id === winner.target_state_id);
          if (targetState) {
            matchedTargetId = winner.target_state_id;
            matchedTargetTitle = targetState.title || targetState.id;
            this.logger.log(
              `[evaluateAndTransition] Winner by priority: target='${matchedTargetId}', condition='${winner.condition_type}', priority=${winner.priority ?? 100}`,
            );
          } else {
            this.logger.warn(
              `[evaluateAndTransition] Target state '${winner.target_state_id}' not found in plan`,
            );
          }
        }
      }

      if (!matchedTargetId) {
        // No authored/default condition matched. Before giving up, apply the
        // last-resort safety net: if the agent has left this state stuck for too
        // many no-progress turns, force the default forward transition so the
        // conversation can always recover (#291). Falls through to the normal
        // transition-application code below (cycle guard, end-state handling, etc.).
        const stuckReleaseId = this.stuckStateReleaseTarget(plan, currentState, state);
        if (stuckReleaseId) {
          this.logger.warn(
            `[evaluateAndTransition] SAFETY NET: state '${currentState.id}' stuck for ` +
              `${state.turnsWithoutProgress} turns without progress (limit ` +
              `${StateMachineService.STUCK_STATE_TURN_LIMIT}); the agent never completed/skipped ` +
              `its tasks — force-advancing to '${stuckReleaseId}'.`,
          );
          matchedTargetId = stuckReleaseId;
          matchedTargetTitle =
            plan.states.find(s => s.id === stuckReleaseId)?.title ?? stuckReleaseId;
        } else {
          this.logger.log(`[evaluateAndTransition] No transition conditions met`);
          break;
        }
      }

      if (visitedStateIds.has(matchedTargetId)) {
        this.logger.warn(
          `[evaluateAndTransition] Transition cycle detected (${currentStateId} -> ${matchedTargetId}) for session ${sessionId}; stopping to prevent loops`,
        );
        break;
      }

      this.logger.log(
        `[evaluateAndTransition] Condition met! Transitioning from '${currentStateId}' to '${matchedTargetId}'`,
      );

      await this.prisma.sessionState.update({
        where: { sessionId },
        data: {
          currentStateId: matchedTargetId,
          turnsWithoutProgress: 0,
          lastTransitionAt: new Date(),
        },
      });

      // Reset the in-memory counter too. The loop reuses this `state` object on
      // subsequent iterations (it is read by evaluateTransitionCondition for the
      // 'without_progress' scope), and we only updated the DB above. Without this,
      // a chain of consecutive all-optional states would all see the same stale
      // turnsWithoutProgress and fire their turn fallbacks in a single pass —
      // multi-skipping instead of giving each state its own turn window (#172).
      state.turnsWithoutProgress = 0;

      this.logger.log(
        `Session ${sessionId} transitioned from ${currentStateId} to ${matchedTargetId}`,
      );

      // End state reached: mark the session CLOSING first, then return completion.
      // CLOSED is now finalized later when the agent disconnects, which prevents
      // cleanup logic from racing while farewell TTS is still in progress.
      if (matchedTargetId === END_STATE_ID) {
        const endConfig = rawPlan.metadata?.plan_builder?.canvas?.end_node_config;
        this.logger.log(`[evaluateAndTransition] Session ${sessionId} reached end state — marking CLOSING`);

        // Keep closedAt null until shutdown is confirmed and final CLOSED is written.
        await this.prisma.session.update({
          where: { id: sessionId },
          data: { status: 'CLOSING', closedAt: null },
        });

        return {
          transitioned: true,
          newStateId: END_STATE_ID,
          sessionCompleted: true,
          farewellMessage: endConfig?.farewell_message,
          summaryBehavior: endConfig?.summary_behavior,
        };
      }

      transitioned = true;
      currentStateId = matchedTargetId;
      visitedStateIds.add(currentStateId);
      lastStateId = matchedTargetId;
      lastStateTitle = matchedTargetTitle;
    }

    // If i reached the limit, the loop exhausted all allowed transitions without
    // breaking early — meaning we hit the safety cap, not a natural stopping point.
    // Every early exit (no conditions met, cycle detected, state not found) uses
    // break, so those cases will always leave i < MAX_TRANSITIONS_PER_TURN.
    const reachedMaxTransitions = i >= StateMachineService.MAX_TRANSITIONS_PER_TURN;

    if (transitioned) {
      if (reachedMaxTransitions) {
        this.logger.warn(
          `[evaluateAndTransition] Max transitions per turn (${StateMachineService.MAX_TRANSITIONS_PER_TURN}) reached for session ${sessionId}; stopping to prevent loops`,
        );
      }
      return {
        transitioned: true,
        newStateId: lastStateId,
        newStateTitle: lastStateTitle,
      };
    }

    return { transitioned: false };
  }

  /**
   * Get full state info for frontend updates
   * Returns all states with tasks, deliverables, and completion status
   */
  async getFullState(sessionId: string): Promise<FullStateInfo | null> {
    const state = await this.getState(sessionId);
    if (!state) return null;

    const plan = state.planData as unknown as PlanData;
    const deliverables = state.deliverables as unknown as Record<string, DeliverableValue>;
    const completedTasks = state.completedTasks || [];
    const skippedTasks = state.skippedTasks || [];

    // Change for non-linear transitions:
    // Build status per state using completion checks instead of positional
    // "all states before current are completed" logic.
    const states: FullStateStateInfo[] = plan.states.map(planState => {
      let stateStatus: 'pending' | 'active' | 'completed' = 'pending';
      if (planState.id === state.currentStateId) {
        stateStatus = 'active';
      } else if (this.isPlanStateComplete(state, planState)) {
        stateStatus = 'completed';
      }

      const tasks: FullStateTaskInfo[] = planState.tasks.map(task => {
        const taskDeliverables = task.deliverables || [];
        const hasDeliverables = taskDeliverables.length > 0;

        // Determine task status (#291 hybrid model). An explicit tick/skip wins;
        // otherwise a task whose required deliverables are all collected counts
        // as 'completed' even without an explicit complete_task (this is the
        // same rule isCurrentStateComplete uses to advance, so the UI badge and
        // the state machine never disagree). Partial data shows 'in_progress'.
        let taskStatus: 'pending' | 'in_progress' | 'completed' | 'skipped' = 'pending';
        if (completedTasks.includes(task.id)) {
          taskStatus = 'completed';
        } else if (skippedTasks.includes(task.id)) {
          taskStatus = 'skipped';
        } else if (this.deliverablesSatisfyTask(task, deliverables)) {
          taskStatus = 'completed';
        } else if (hasDeliverables && taskDeliverables.some(d => d.key in deliverables)) {
          // Some data collected but not all required deliverables yet.
          taskStatus = 'in_progress';
        }

        // Build deliverable info
        const deliverableInfos: FullStateDeliverableInfo[] = taskDeliverables.map(d => {
          const collected = deliverables[d.key];
          // Cascade a task skip onto its still-uncollected deliverables so the UI
          // sub-items render as 'skipped' rather than a stale 'pending' circle.
          // A collected deliverable keeps 'completed' even if the task was later
          // skipped (the data was genuinely captured).
          const deliverableStatus: 'pending' | 'completed' | 'partial' | 'skipped' = collected
            ? collected.unconfirmed
              ? 'partial'
              : 'completed'
            : taskStatus === 'skipped'
              ? 'skipped'
              : 'pending';
          return {
            key: d.key,
            description: d.description,
            type: d.type || 'string',
            required: d.required !== false,
            status: deliverableStatus,
            value: collected?.value,
            collectedAt: collected?.collectedAt,
            acceptanceCriteria: d.acceptance_criteria,
            reasoning: collected?.reasoning,
          };
        });

        return {
          id: task.id,
          description: task.description,
          instruction: task.instruction,
          required: task.required !== false,
          status: taskStatus,
          deliverables: deliverableInfos,
        };
      });

      // For goal states, prepend a synthetic task for goal-level deliverables
      if (planState.type === 'goal' && planState.goal?.deliverables?.length) {
        const taskKeys = new Set(
          planState.tasks.flatMap(t => (t.deliverables || []).map(d => d.key)),
        );

        const goalDeliverableInfos: FullStateDeliverableInfo[] = planState.goal.deliverables
          .filter(d => !taskKeys.has(d.key)) // Deduplicate with task deliverables
          .map(d => {
            const collected = deliverables[d.key];
            // Mirror the regular task skip cascade (#310): a collected goal
            // deliverable is 'completed'; once the goal state itself is complete
            // (goal achieved or abandoned), any still-uncollected goal
            // deliverable cascades to 'skipped' rather than a stale 'pending'
            // circle; otherwise it is 'pending'. Previously these only ever got
            // 'completed'/'pending', diverging from regular task deliverables.
            const deliverableStatus: 'pending' | 'completed' | 'partial' | 'skipped' = collected
              ? collected.unconfirmed
                ? 'partial'
                : 'completed'
              : stateStatus === 'completed'
                ? 'skipped'
                : 'pending';
            return {
              key: d.key,
              description: d.description,
              type: d.type || 'string',
              required: d.required !== false,
              status: deliverableStatus,
              value: collected?.value,
              collectedAt: collected?.collectedAt,
              acceptanceCriteria: d.acceptance_criteria,
              reasoning: collected?.reasoning,
              discovered: false,
            };
          });

        // Add discovered insights (only for active state)
        if (planState.id === state.currentStateId) {
          const knownKeys = new Set([
            ...taskKeys,
            ...planState.goal.deliverables.map(d => d.key),
          ]);
          for (const [key, val] of Object.entries(deliverables)) {
            if (!knownKeys.has(key) && val.discovered) {
              goalDeliverableInfos.push({
                key,
                description: key.replace(/_/g, ' '),
                type: 'string',
                required: false,
                status: 'completed',
                value: val.value,
                collectedAt: val.collectedAt,
                reasoning: val.reasoning,
                discovered: true,
              });
            }
          }
        }

        if (goalDeliverableInfos.length > 0) {
          const allRequired = goalDeliverableInfos.filter(d => d.required && !d.discovered);
          // A completed goal state means the goal was achieved — report the
          // synthetic goal task as completed even if some required deliverables
          // were skipped rather than collected (kept consistent with the
          // deliverable skip cascade above).
          const goalTaskStatus: 'pending' | 'in_progress' | 'completed' =
            stateStatus === 'completed' ? 'completed' :
            allRequired.every(d => d.status === 'completed') ? 'completed' :
            allRequired.some(d => d.status === 'completed') ? 'in_progress' : 'pending';

          tasks.unshift({
            id: '__goal_deliverables__',
            description: planState.goal.objective || 'Goal Deliverables',
            required: true,
            status: goalTaskStatus,
            deliverables: goalDeliverableInfos,
          });
        }
      }

      return {
        id: planState.id,
        title: planState.title || planState.id,
        type: planState.type || 'loose',
        status: stateStatus,
        tasks,
        goal: planState.goal,
      };
    });

    // Build collected deliverables map
    const collectedDeliverablesMap: Record<string, unknown> = {};
    for (const [key, data] of Object.entries(deliverables)) {
      collectedDeliverablesMap[key] = data.value;
    }

    const progress = await this.calculateProgress(sessionId, state);

    return {
      planId: plan.id,
      planTitle: plan.title || plan.id,
      currentStateId: state.currentStateId,
      progress,
      totalTurns: state.totalTurns,
      turnsWithoutProgress: state.turnsWithoutProgress,
      states,
      collectedDeliverables: collectedDeliverablesMap,
      // Signal to the frontend that the conversation has terminated.
      sessionCompleted: state.currentStateId === END_STATE_ID,
    };
  }
}
