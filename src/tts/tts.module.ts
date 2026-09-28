import { Module } from '@nestjs/common';
import { TtsController } from './tts.controller.js';
import { TtsService } from './tts.service.js';

@Module({
  controllers: [TtsController],
  providers: [TtsService],
  exports: [TtsService],
})
export class TtsModule {}
