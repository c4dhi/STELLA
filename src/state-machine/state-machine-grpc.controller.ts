import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { StateMachineService, END_STATE_ID } from './state-machine.service';

/**
 * StateMachineGrpcController - gRPC endpoints for state machine operations.
 *
 * Implements the StateMachineService defined in state_machine.proto.
 * Agents call these methods to manage conversation state.
 */
@Controller()
export class StateMachineGrpcController {
  private readonly logger = new Logger(StateMachineGrpcController.name);

  constructor(private readonly stateMachineService: StateMachineService) {}

  /**
   * Initialize state machine for a session
   */
  @GrpcMethod('StateMachineService', 'Initialize')
  async initialize(request: {
    sessionId: string;
    planJson: string;
  }): Promise<{
    success: boolean;
    error?: string;
    currentStateId?: string;
  }> {
    this.logger.log(`Initialize called for session: ${request.sessionId}`);

    try {
      const plan = JSON.parse(request.planJson);
      const state = await this.stateMachineService.initializeForSession(
        request.sessionId,
        plan,
      );

      return {
        success: true,
        currentStateId: state.currentStateId,
      };
    } catch (error) {
      this.logger.error(`Initialize error: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Complete a task by ID
   */
  @GrpcMethod('StateMachineService', 'CompleteTask')
  async completeTask(request: {
    sessionId: string;
    taskId: string;
    reasoning: string;
  }): Promise<{
    success: boolean;
    error?: string;
    taskCompleted?: string;
    transitioned?: boolean;
    newStateId?: string;
    newStateTitle?: string;
    progress?: number;
    // Set when transition reached the end state. Agent should stop prompting.
    sessionCompleted?: boolean;
    farewellMessage?: string;
    summaryBehavior?: string;
  }> {
    this.logger.log(`CompleteTask called for session: ${request.sessionId}, task: ${request.taskId}`);

    const result = await this.stateMachineService.completeTask(
      request.sessionId,
      request.taskId,
      request.reasoning,
    );

    return {
      success: result.success,
      error: result.error,
      taskCompleted: result.taskCompleted,
      transitioned: result.transitioned,
      newStateId: result.newStateId,
      newStateTitle: result.newStateTitle,
      progress: result.progress,
      sessionCompleted: result.sessionCompleted,
      farewellMessage: result.farewellMessage,
      summaryBehavior: result.summaryBehavior,
    };
  }

  /**
   * Skip a single task by ID
   */
  @GrpcMethod('StateMachineService', 'SkipTask')
  async skipTask(request: {
    sessionId: string;
    taskId: string;
    reasoning: string;
  }): Promise<{
    success: boolean;
    error?: string;
    taskSkipped?: string;
    transitioned?: boolean;
    newStateId?: string;
    newStateTitle?: string;
    progress?: number;
    sessionCompleted?: boolean;
    farewellMessage?: string;
    summaryBehavior?: string;
  }> {
    this.logger.log(`SkipTask called for session: ${request.sessionId}, task: ${request.taskId}`);

    const result = await this.stateMachineService.skipTask(
      request.sessionId,
      request.taskId,
      request.reasoning,
    );

    return {
      success: result.success,
      error: result.error,
      taskSkipped: result.taskSkipped,
      transitioned: result.transitioned,
      newStateId: result.newStateId,
      newStateTitle: result.newStateTitle,
      progress: result.progress,
      sessionCompleted: result.sessionCompleted,
      farewellMessage: result.farewellMessage,
      summaryBehavior: result.summaryBehavior,
    };
  }

  /**
   * Skip the remainder of a state (mark its tasks skipped and advance)
   */
  @GrpcMethod('StateMachineService', 'SkipState')
  async skipState(request: {
    sessionId: string;
    stateId?: string;
    reasoning: string;
  }): Promise<{
    success: boolean;
    error?: string;
    stateSkipped?: string;
    tasksSkipped?: string[];
    transitioned?: boolean;
    newStateId?: string;
    newStateTitle?: string;
    progress?: number;
    sessionCompleted?: boolean;
    farewellMessage?: string;
    summaryBehavior?: string;
  }> {
    this.logger.log(`SkipState called for session: ${request.sessionId}, state: ${request.stateId || '(current)'}`);

    const result = await this.stateMachineService.skipState(
      request.sessionId,
      request.stateId,
      request.reasoning,
    );

    return {
      success: result.success,
      error: result.error,
      stateSkipped: result.stateSkipped,
      tasksSkipped: result.tasksSkipped,
      transitioned: result.transitioned,
      newStateId: result.newStateId,
      newStateTitle: result.newStateTitle,
      progress: result.progress,
      sessionCompleted: result.sessionCompleted,
      farewellMessage: result.farewellMessage,
      summaryBehavior: result.summaryBehavior,
    };
  }

  /**
   * Set a deliverable value
   */
  @GrpcMethod('StateMachineService', 'SetDeliverable')
  async setDeliverable(request: {
    sessionId: string;
    key: string;
    value: string;
    reasoning: string;
    unconfirmed?: boolean;
  }): Promise<{
    success: boolean;
    error?: string;
    taskCompleted?: string;
    transitioned?: boolean;
    newStateId?: string;
    newStateTitle?: string;
    progress?: number;
    // Set when transition reached the end state. Agent should stop prompting.
    sessionCompleted?: boolean;
    farewellMessage?: string;
    summaryBehavior?: string;
  }> {
    this.logger.log(`SetDeliverable called for session: ${request.sessionId}, key: ${request.key}`);

    // Parse the JSON value
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(request.value);
    } catch {
      // If not valid JSON, treat as string
      parsedValue = request.value;
    }

    const result = await this.stateMachineService.setDeliverable(
      request.sessionId,
      request.key,
      parsedValue,
      request.reasoning,
      request.unconfirmed ?? false,
    );

    return {
      success: result.success,
      error: result.error,
      taskCompleted: result.taskCompleted,
      transitioned: result.transitioned,
      newStateId: result.newStateId,
      newStateTitle: result.newStateTitle,
      progress: result.progress,
      sessionCompleted: result.sessionCompleted,
      farewellMessage: result.farewellMessage,
      summaryBehavior: result.summaryBehavior,
    };
  }

  /**
   * Get current state info
   */
  @GrpcMethod('StateMachineService', 'GetCurrentState')
  async getCurrentState(request: {
    sessionId: string;
  }): Promise<{
    success: boolean;
    error?: string;
    stateId?: string;
    stateTitle?: string;
    stateType?: string;
    progress?: number;
    turnsWithoutProgress?: number;
    totalTurns?: number;
    goalObjective?: string;
    goalContext?: string;
    goalDepthGuidance?: string;
    goalBoundaries?: string;
    goalSuccessDescription?: string;
    // Set when the session has reached the end state.
    sessionCompleted?: boolean;
  }> {
    this.logger.debug(`GetCurrentState called for session: ${request.sessionId}`);

    // Check raw DB state before calling getCurrentState so we can distinguish
    // "session completed" (currentStateId === __end__) from "not initialized" (no state row).
    const rawState = await this.stateMachineService.getState(request.sessionId);
    if (!rawState) {
      return { success: false, error: 'State machine not initialized for this session' };
    }

    if (rawState.currentStateId === END_STATE_ID) {
      // Conversation terminated — agent should stop prompting.
      return { success: true, sessionCompleted: true, stateId: END_STATE_ID };
    }

    const state = await this.stateMachineService.getCurrentState(request.sessionId);
    if (!state) {
      return { success: false, error: 'State machine not initialized for this session' };
    }

    return {
      success: true,
      stateId: state.stateId,
      stateTitle: state.stateTitle,
      stateType: state.stateType,
      progress: state.progress,
      turnsWithoutProgress: state.turnsWithoutProgress,
      totalTurns: state.totalTurns,
      goalObjective: state.goal?.objective,
      goalContext: state.goal?.context,
      goalDepthGuidance: state.goal?.depth_guidance,
      goalBoundaries: state.goal?.boundaries,
      goalSuccessDescription: state.goal?.success_description,
    };
  }

  /**
   * Get pending tasks in current state
   * Returns tasks filtered by mode:
   * - LOOSE: All pending tasks
   * - STRICT: Current task + next task as preview
   */
  @GrpcMethod('StateMachineService', 'GetPendingTasks')
  async getPendingTasks(request: {
    sessionId: string;
  }): Promise<{
    success: boolean;
    error?: string;
    tasks?: Array<{
      id: string;
      description: string;
      instruction?: string;
      required: boolean;
      hasDeliverables: boolean;
      deliverableKeys: string[];
      isPreview?: boolean;
      isGoal?: boolean;
    }>;
  }> {
    this.logger.debug(`GetPendingTasks called for session: ${request.sessionId}`);

    try {
      const tasks = await this.stateMachineService.getPendingTasks(request.sessionId);

      return {
        success: true,
        tasks: tasks.map(t => ({
          id: t.id,
          description: t.description,
          instruction: t.instruction,
          required: t.required,
          hasDeliverables: t.hasDeliverables,
          deliverableKeys: t.deliverableKeys,
          isPreview: t.isPreview,
          isGoal: t.isGoal,
        })),
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get pending deliverables in current state
   */
  @GrpcMethod('StateMachineService', 'GetPendingDeliverables')
  async getPendingDeliverables(request: {
    sessionId: string;
  }): Promise<{
    success: boolean;
    error?: string;
    deliverables?: Array<{
      key: string;
      description: string;
      type: string;
      required: boolean;
      acceptanceCriteria?: string;
      taskId: string;
    }>;
  }> {
    this.logger.debug(`GetPendingDeliverables called for session: ${request.sessionId}`);

    try {
      const deliverables = await this.stateMachineService.getPendingDeliverables(
        request.sessionId,
      );

      return {
        success: true,
        deliverables: deliverables.map(d => ({
          key: d.key,
          description: d.description,
          type: d.type,
          required: d.required,
          acceptanceCriteria: d.acceptanceCriteria,
          taskId: d.taskId,
        })),
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Increment turn counter
   */
  @GrpcMethod('StateMachineService', 'IncrementTurn')
  async incrementTurn(request: {
    sessionId: string;
  }): Promise<{
    success: boolean;
    error?: string;
    turnsWithoutProgress?: number;
  }> {
    this.logger.debug(`IncrementTurn called for session: ${request.sessionId}`);

    try {
      // incrementTurn now also re-evaluates transitions (turn_count_exceeded can
      // fire here, #172). The transition is reflected on the next GetFullState the
      // agent fetches, so the gRPC response only needs to carry the counter.
      const { turnsWithoutProgress } = await this.stateMachineService.incrementTurn(
        request.sessionId,
      );

      return {
        success: true,
        turnsWithoutProgress,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get all collected deliverables
   */
  @GrpcMethod('StateMachineService', 'GetCollectedDeliverables')
  async getCollectedDeliverables(request: {
    sessionId: string;
  }): Promise<{
    success: boolean;
    error?: string;
    deliverables?: Array<{
      key: string;
      value: string;
    }>;
  }> {
    this.logger.debug(`GetCollectedDeliverables called for session: ${request.sessionId}`);

    try {
      const deliverables = await this.stateMachineService.getCollectedDeliverables(
        request.sessionId,
      );

      return {
        success: true,
        deliverables: Object.entries(deliverables).map(([key, value]) => ({
          key,
          value: JSON.stringify(value),
        })),
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get full state machine state (for frontend updates)
   */
  @GrpcMethod('StateMachineService', 'GetFullState')
  async getFullState(request: {
    sessionId: string;
  }): Promise<{
    success: boolean;
    error?: string;
    planId?: string;
    planTitle?: string;
    currentStateId?: string;
    progress?: number;
    totalTurns?: number;
    turnsWithoutProgress?: number;
    states?: Array<{
      id: string;
      title: string;
      type: string;
      status: string;
      tasks: Array<{
        id: string;
        description: string;
        instruction?: string;
        required: boolean;
        status: string;
        deliverables: Array<{
          key: string;
          description: string;
          type: string;
          required: boolean;
          status: string;
          value?: string;
          collectedAt?: string;
          acceptanceCriteria?: string;
          reasoning?: string;
        }>;
      }>;
    }>;
    collectedDeliverables?: Record<string, string>;
  }> {
    this.logger.debug(`GetFullState called for session: ${request.sessionId}`);

    try {
      const fullState = await this.stateMachineService.getFullState(request.sessionId);

      if (!fullState) {
        return {
          success: false,
          error: 'State machine not initialized for this session',
        };
      }

      // Convert to proto-compatible format
      const states = fullState.states.map(state => ({
        id: state.id,
        title: state.title,
        type: state.type,
        status: state.status,
        goalObjective: state.goal?.objective,
        goalContext: state.goal?.context,
        goalDepthGuidance: state.goal?.depth_guidance,
        goalBoundaries: state.goal?.boundaries,
        goalSuccessDescription: state.goal?.success_description,
        tasks: state.tasks.map(task => ({
          id: task.id,
          description: task.description,
          instruction: task.instruction,
          required: task.required,
          status: task.status,
          deliverables: task.deliverables.map(d => ({
            key: d.key,
            description: d.description,
            type: d.type,
            required: d.required,
            status: d.status,
            value: d.value !== undefined ? JSON.stringify(d.value) : undefined,
            collectedAt: d.collectedAt,
            acceptanceCriteria: d.acceptanceCriteria,
            reasoning: d.reasoning,
            discovered: d.discovered || false,
          })),
        })),
      }));

      // Convert collected deliverables to JSON strings
      const collectedDeliverables: Record<string, string> = {};
      for (const [key, value] of Object.entries(fullState.collectedDeliverables)) {
        collectedDeliverables[key] = JSON.stringify(value);
      }

      return {
        success: true,
        planId: fullState.planId,
        planTitle: fullState.planTitle,
        currentStateId: fullState.currentStateId,
        progress: fullState.progress,
        totalTurns: fullState.totalTurns,
        turnsWithoutProgress: fullState.turnsWithoutProgress,
        states,
        collectedDeliverables,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
