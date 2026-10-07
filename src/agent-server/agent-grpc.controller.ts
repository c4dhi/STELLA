import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod, GrpcStreamMethod } from '@nestjs/microservices';
import * as grpc from '@grpc/grpc-js';
import { AgentServerService } from './agent-server.service.js';
import { Observable, Subject } from 'rxjs';

/**
 * AgentGrpcController - Exposes gRPC endpoints for agent connections.
 *
 * Implements the AgentService defined in agent.proto:
 * - RegisterAgent: Agent joins a session
 * - AgentStream: Bidirectional communication stream
 * - SendInterrupt: Fast interrupt for barge-in
 * - EndSession: Agent signals session end
 * - HealthCheck: Simple health check
 */
@Controller()
export class AgentGrpcController {
  private readonly logger = new Logger(AgentGrpcController.name);

  constructor(private readonly agentServerService: AgentServerService) {}

  /**
   * RegisterAgent - Agent calls this to join a session.
   */
  @GrpcMethod('AgentService', 'RegisterAgent')
  async registerAgent(request: any): Promise<any> {
    // NestJS gRPC uses camelCase for field names (agentType, not agent_type)
    this.logger.log(`RegisterAgent called: ${request.agentType}`);

    const response = await this.agentServerService.handleRegisterAgent({
      agentType: request.agentType,
      agentVersion: request.agentVersion,
      capabilities: request.capabilities || {},
    });

    return {
      success: response.success,
      sessionId: response.sessionId,
      message: response.message,
      config: response.config,
    };
  }

  /**
   * AgentStream - Bidirectional stream for agent communication.
   * Agent sends AgentOutputProto, receives AgentInputProto.
   */
  @GrpcStreamMethod('AgentService', 'AgentStream')
  agentStream(messages: Observable<any>): Observable<any> {
    this.logger.log('AgentStream started');

    const subject = new Subject<any>();

    // This creates a pseudo-duplex stream using RxJS observables
    // NestJS gRPC doesn't natively support duplex streams, so we use a workaround
    let sessionId: string | null = null;

    messages.subscribe({
      next: async (message) => {
        try {
          sessionId = message.session_id;
          this.logger.debug(`AgentStream message received for session: ${sessionId}`);

          // Forward to service for handling
          // The service will emit events that the orchestrator listens to
          // For now, we acknowledge receipt
        } catch (error) {
          this.logger.error(`AgentStream error: ${error.message}`);
        }
      },
      error: (err) => {
        this.logger.error(`AgentStream error: ${err.message}`);
        subject.error(err);
      },
      complete: () => {
        this.logger.log(`AgentStream completed for session: ${sessionId}`);
        subject.complete();
      },
    });

    return subject.asObservable();
  }

  /**
   * SendInterrupt - Fast path for barge-in interrupts.
   */
  @GrpcMethod('AgentService', 'SendInterrupt')
  async sendInterrupt(request: any): Promise<any> {
    // NestJS gRPC uses camelCase for field names
    this.logger.log(`SendInterrupt called for session: ${request.sessionId}`);

    const result = await this.agentServerService.sendInterrupt(
      request.sessionId,
      request.reason,
    );

    return {
      success: result.success,
      wasProcessing: result.wasProcessing,
    };
  }

  /**
   * EndSession - Agent signals session end.
   */
  @GrpcMethod('AgentService', 'EndSession')
  async endSession(request: any): Promise<any> {
    // NestJS gRPC uses camelCase for field names
    this.logger.log(`EndSession called for session: ${request.sessionId}`);

    await this.agentServerService.sendSessionEnd(request.sessionId);

    return {
      success: true,
      finalData: {},
    };
  }

  /**
   * HealthCheck - Simple health check endpoint.
   */
  @GrpcMethod('AgentService', 'HealthCheck')
  async healthCheck(): Promise<any> {
    const connectedSessions = this.agentServerService.getConnectedSessions();

    return {
      healthy: true,
      agentType: 'session-management-server',
      agentVersion: '1.0.0',
      sessionId: connectedSessions.length > 0 ? connectedSessions[0] : '',
    };
  }
}
