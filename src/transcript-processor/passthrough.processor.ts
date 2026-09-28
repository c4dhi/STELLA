import { Injectable, Logger } from '@nestjs/common';
import {
  TranscriptProcessor,
  TranscriptProcessorResult,
} from './transcript-processor.interface.js';

/**
 * PassthroughProcessor - Testing/Demo Implementation
 *
 * Simply passes the transcript through to TTS for narration.
 * This allows testing the full audio pipeline (STT → TTS) without
 * requiring the Agent SDK to be integrated.
 *
 * Flow: User speaks → STT → "Hello world" → PassthroughProcessor → TTS → "Hello world"
 *
 * Replace with AgentProcessor when ready to integrate the Agent SDK:
 * Flow: User speaks → STT → "Hello world" → AgentProcessor → Agent response → TTS
 */
@Injectable()
export class PassthroughProcessor implements TranscriptProcessor {
  private readonly logger = new Logger(PassthroughProcessor.name);

  async process(
    transcript: string,
    sessionId: string,
    participantId: string,
  ): Promise<TranscriptProcessorResult> {
    this.logger.debug(
      `Passthrough: "${transcript}" (session=${sessionId}, participant=${participantId})`,
    );

    // Simply pass through the transcript for TTS narration
    return {
      text: transcript,
      shouldSpeak: true,
      metadata: {
        processor: 'passthrough',
        originalTranscript: transcript,
      },
    };
  }
}
