import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { LiveKitModule } from '../livekit/livekit.module.js';
import { MessageRecorderService } from './message-recorder.service.js';
import { RoomMonitorService } from './room-monitor.service.js';

@Module({
  imports: [PrismaModule, LiveKitModule],
  providers: [MessageRecorderService, RoomMonitorService],
  exports: [MessageRecorderService, RoomMonitorService],
})
export class MessageRecorderModule {}
