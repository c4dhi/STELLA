import { Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import * as grpc from '@grpc/grpc-js';
import { v4 as uuid } from 'uuid';
import {
  AgentInput,
  AgentOutput,
  AgentHealthStatus,
  InputType,
  OutputType,
  AgentState,
} from './agent.types.js';

/**
 * Manages a single agent's bidirectional gRPC stream.
 * Handles sending inputs to agent and receiving outputs.
 */
export class AgentSessionStream extends EventEmitter {
  private readonly logger = new Logger(AgentSessionStream.name);
  private pendingHealthChecks = new Map<
    string,
    {
      resolve: (status: AgentHealthStatus) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private outputListeners = new Set<(output: AgentOutput) => void>();
  private _connected = true;

  constructor(
    readonly sessionId: string,
    private readonly call: grpc.ServerDuplexStream<any, any>,
  ) {
    super();

    // Handle stream end
    this.call.on('end', () => {
      this._connected = false;
      this.emit('end');
      this.cleanup();
    });

    this.call.on('error', (err: Error) => {
      this.logger.error(`Stream error for session ${sessionId}: ${err.message}`);
      this._connected = false;
      this.emit('error', err);
      this.cleanup();
    });
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Send input message to agent.
   */
  sendInput(input: AgentInput): void {
    if (!this._connected) {
      this.logger.warn(`Cannot send input - stream not connected for session ${this.sessionId}`);
      return;
    }

    // Convert to proto format (snake_case)
    const protoInput: any = {
      session_id: input.sessionId,
      type: input.type,
      text: input.text || '',
      history: input.history?.map((turn) => ({
        role: turn.role,
        content: turn.content,
      })) || [],
      metadata: input.metadata || {},
      timestamp_ms: input.timestampMs,
    };

    if (input.healthCheck) {
      protoInput.health_check = {
        request_id: input.healthCheck.requestId,
      };
    }

    this.call.write(protoInput);
  }

  /**
   * Send text input to agent.
   */
  sendText(text: string, history?: { role: string; content: string }[]): void {
    this.sendInput({
      sessionId: this.sessionId,
      type: InputType.TEXT,
      text,
      history,
      timestampMs: Date.now(),
    });
  }

  /**
   * Send interrupt signal to agent.
   */
  sendInterrupt(reason: string): void {
    this.sendInput({
      sessionId: this.sessionId,
      type: InputType.INTERRUPT,
      metadata: { reason },
      timestampMs: Date.now(),
    });
  }

  /**
   * Send session start to agent.
   */
  sendSessionStart(config: Record<string, string>): void {
    this.sendInput({
      sessionId: this.sessionId,
      type: InputType.SESSION_START,
      metadata: config,
      timestampMs: Date.now(),
    });
  }

  /**
   * Send session end to agent.
   */
  sendSessionEnd(): void {
    this.sendInput({
      sessionId: this.sessionId,
      type: InputType.SESSION_END,
      timestampMs: Date.now(),
    });
  }

  /**
   * Request health check with response correlation.
   */
  async requestHealthCheck(timeoutMs = 5000): Promise<AgentHealthStatus> {
    const requestId = uuid();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingHealthChecks.delete(requestId);
        reject(new Error('Health check timeout'));
      }, timeoutMs);

      this.pendingHealthChecks.set(requestId, { resolve, reject, timeout });

      this.sendInput({
        sessionId: this.sessionId,
        type: InputType.HEALTH_CHECK,
        healthCheck: { requestId },
        timestampMs: Date.now(),
      });
    });
  }

  /**
   * Handle output from agent (called by AgentServerService).
   */
  handleOutput(protoOutput: any): void {
    const output = this.protoToAgentOutput(protoOutput);

    // Handle health status responses
    if (output.type === OutputType.HEALTH_STATUS && output.healthStatus) {
      const requestId = output.healthStatus.requestId;
      const pending = this.pendingHealthChecks.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(output.healthStatus);
        this.pendingHealthChecks.delete(requestId);
      }
      return;
    }

    // Notify listeners of text/status outputs
    this.outputListeners.forEach((listener) => listener(output));
    this.emit('output', output);
  }

  /**
   * Subscribe to agent outputs (text chunks, status, etc.).
   */
  onOutput(listener: (output: AgentOutput) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  /**
   * End the stream gracefully.
   */
  end(): void {
    if (this._connected) {
      this.call.end();
      this._connected = false;
    }
  }

  /**
   * Convert proto output to AgentOutput type.
   */
  private protoToAgentOutput(proto: any): AgentOutput {
    const output: AgentOutput = {
      sessionId: proto.session_id,
      type: proto.type,
      content: proto.content || '',
      isFinal: proto.is_final || false,
      transcriptId: proto.transcript_id,
      statusSubtype: proto.status_subtype,
      metadataSubtype: proto.metadata_subtype,
      metadata: proto.metadata || {},
      timestampMs: Number(proto.timestamp_ms || Date.now()),
    };

    // Parse health status if present
    if (proto.health_status) {
      output.healthStatus = {
        requestId: proto.health_status.request_id,
        state: this.parseAgentState(proto.health_status.state),
        sessionId: proto.health_status.session_id,
        agentType: proto.health_status.agent_type,
        agentVersion: proto.health_status.agent_version,
        uptimeSeconds: Number(proto.health_status.uptime_seconds || 0),
        messagesProcessed: proto.health_status.messages_processed || 0,
        lastError: proto.health_status.last_error,
        metadata: proto.health_status.metadata,
      };
    }

    return output;
  }

  /**
   * Parse proto AgentState enum to string.
   */
  private parseAgentState(protoState: number): AgentState {
    const stateMap: Record<number, AgentState> = {
      0: AgentState.UNKNOWN,
      1: AgentState.INITIALIZING,
      2: AgentState.READY,
      3: AgentState.PROCESSING,
      4: AgentState.INTERRUPTED,
      5: AgentState.ERROR,
      6: AgentState.SHUTTING_DOWN,
    };
    return stateMap[protoState] || AgentState.UNKNOWN;
  }

  /**
   * Clean up resources.
   */
  private cleanup(): void {
    // Reject all pending health checks
    for (const [requestId, pending] of this.pendingHealthChecks) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Stream disconnected'));
    }
    this.pendingHealthChecks.clear();
    this.outputListeners.clear();
  }
}
