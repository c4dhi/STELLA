import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/filters/http-exception.filter.js';
import * as express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    bodyParser: false, // Disable default body parser so we can handle webhooks specially
  });

  // Use JSON parser for all routes except webhooks
  app.use((req, res, next) => {
    if (req.path === '/webhooks/livekit') {
      // For LiveKit webhooks, use text parser to get raw JWT token
      express.text({ type: '*/*' })(req, res, next);
    } else {
      // For all other routes, use JSON parser
      express.json()(req, res, next);
    }
  });
  app.use(express.urlencoded({ extended: true }));

  // Determine proto path
  // In Docker: __dirname is /app/dist/src, proto files are at /app/dist/proto (../proto)
  // In local dev: __dirname is <project>/dist/src, proto files are at <project>/proto (../../proto)
  // Use PROTO_PATH env var if set, otherwise check for Docker path first, then local path
  const dockerProtoPath = join(__dirname, '../proto');
  const localProtoPath = join(__dirname, '../../proto');
  const protoDir =
    process.env.PROTO_PATH ||
    (existsSync(join(dockerProtoPath, 'agent.proto'))
      ? dockerProtoPath
      : localProtoPath);

  // Add gRPC microservice for agent connections and state machine
  // Both services run on the same port - gRPC multiplexes by package name
  const grpcPort = process.env.GRPC_PORT || '50051';
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: ['stella.agent.v1', 'stella.statemachine.v1'],
      protoPath: [
        join(protoDir, 'agent.proto'),
        join(protoDir, 'state_machine.proto'),
      ],
      url: `0.0.0.0:${grpcPort}`,
    },
  });
  logger.log(`🔌 gRPC server configured on port ${grpcPort} (AgentService + StateMachineService)`);

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Global exception filter
  app.useGlobalFilters(new AllExceptionsFilter());

  // No API prefix - all routes are at root level (/, /auth/*, /projects/*, etc.)
  // Internal routes (/internal/*) are at root level alongside public routes
  const nodeEnv = process.env.NODE_ENV || 'development';
  logger.log(`🔧 API prefix disabled - all routes at root level`);

  // Configure CORS.
  // CORS_ORIGIN is normally derived from PUBLIC_FRONTEND_URL by the deploy
  // scripts (single source of truth), but we still parse it defensively here:
  // a comma-separated list is allowed so multiple frontend origins can be
  // permitted without code changes. Passing an array makes the cors middleware
  // reflect the matching request origin (a fixed string would always echo that
  // one value regardless of who asked — the footgun behind the old bug).
  const isDevelopment = nodeEnv === 'development';
  const allowedOrigins = (process.env.CORS_ORIGIN || process.env.PUBLIC_FRONTEND_URL || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const corsOrigin = isDevelopment
    ? true
    : allowedOrigins.length > 1
      ? allowedOrigins
      : (allowedOrigins[0] ?? false);
  app.enableCors({
    origin: corsOrigin,
    credentials: true,
  });
  logger.log(`🌐 CORS enabled for: ${isDevelopment ? '* (development)' : allowedOrigins.join(', ') || '(none)'}`);

  const port = process.env.PORT || 3000;

  // Start all microservices (gRPC)
  await app.startAllMicroservices();

  await app.listen(port, '0.0.0.0');

  const baseUrl = `http://localhost:${port}`;

  logger.log(`🚀 Session Management Server running on http://0.0.0.0:${port}`);
  logger.log(`📦 Environment: ${nodeEnv}`);
  logger.log(`📊 Health check: ${baseUrl}/health`);
  logger.log(`📁 Projects API: ${baseUrl}/projects`);
  logger.log(`📱 Network info: http://localhost:${port}/network-info`);
  logger.log(`🔒 Internal APIs: http://localhost:${port}/internal/* (no prefix)`);
}

bootstrap();
