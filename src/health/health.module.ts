import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { MediaTestService } from './media-test.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { LiveKitModule } from '../livekit/livekit.module.js';

@Module({
  imports: [PrismaModule, LiveKitModule],
  controllers: [HealthController],
  providers: [HealthService, MediaTestService],
})
export class HealthModule {}
