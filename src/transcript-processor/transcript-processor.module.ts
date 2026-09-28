import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TRANSCRIPT_PROCESSOR } from './transcript-processor.interface.js';
import { PassthroughProcessor } from './passthrough.processor.js';

/**
 * TranscriptProcessorModule
 *
 * Provides the TranscriptProcessor for the voice AI pipeline.
 *
 * To swap implementations:
 *
 * Option 1: Direct change
 * ```typescript
 * useClass: AgentProcessor, // Instead of PassthroughProcessor
 * ```
 *
 * Option 2: Config-driven factory (uncomment below)
 * ```typescript
 * useFactory: (configService: ConfigService) => {
 *   const mode = configService.get('PROCESSOR_MODE', 'passthrough');
 *   if (mode === 'agent') {
 *     return new AgentProcessor(agentSdk);
 *   }
 *   return new PassthroughProcessor();
 * },
 * inject: [ConfigService],
 * ```
 */
@Module({
  imports: [ConfigModule],
  providers: [
    PassthroughProcessor,
    {
      provide: TRANSCRIPT_PROCESSOR,
      useClass: PassthroughProcessor, // Swap to AgentProcessor when ready
    },
  ],
  exports: [TRANSCRIPT_PROCESSOR],
})
export class TranscriptProcessorModule {}
