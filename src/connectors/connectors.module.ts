import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { EnvVarTemplatesModule } from '../env-var-templates/env-var-templates.module.js';
import { ConnectorAuditService } from './connector-audit.service.js';
import { ConnectorGatewayService } from './connector-gateway.service.js';
import { ConnectorsGrpcController } from './connectors-grpc.controller.js';
import { ConnectorsController } from './connectors.controller.js';
import { ConnectorsService } from './connectors.service.js';
import { McpClientService } from './mcp-client.service.js';

/**
 * Connectors: STELLA as an MCP client of outside servers, per user. REST for
 * Settings, gRPC ConnectorService for agents. Unrelated to src/mcp (STELLA as
 * an MCP server).
 */
@Module({
  imports: [PrismaModule, EnvVarTemplatesModule],
  controllers: [ConnectorsController, ConnectorsGrpcController],
  providers: [McpClientService, ConnectorAuditService, ConnectorsService, ConnectorGatewayService],
  exports: [ConnectorsService],
})
export class ConnectorsModule {}
