import { Module } from '@nestjs/common';
import { LiveKitService } from './livekit.service.js';
import { LiveKitController } from './livekit.controller.js';

@Module({
  controllers: [LiveKitController],
  providers: [LiveKitService],
  exports: [LiveKitService],
})
export class LiveKitModule {}
