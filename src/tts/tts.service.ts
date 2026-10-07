import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetchTtsCapabilities, TtsCapabilities } from './grpc/tts-capabilities.client.js';

const DEFAULT_TTS_ADDRESS = 'tts-service:50052';
const CAPABILITIES_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 2500;

// Returned when the tts-service is unreachable: a safe, empty catalog so the
// deploy UI degrades to "voice selection unavailable" instead of erroring.
const UNAVAILABLE: TtsCapabilities = {
  provider: 'unavailable',
  voices: [],
  languages: [],
  defaultVoice: '',
  supportsVoiceSelection: false,
};

@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);
  private cached: { value: TtsCapabilities; at: number } | null = null;
  private inflight: Promise<TtsCapabilities> | null = null;

  constructor(private readonly config: ConfigService) {}

  /**
   * Capabilities of the active TTS provider, cached briefly. The catalog only
   * changes on a tts-service redeploy, so a short TTL keeps the deploy UI
   * snappy without hammering the gRPC service.
   */
  async getCapabilities(): Promise<TtsCapabilities> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < CAPABILITIES_TTL_MS) {
      return this.cached.value;
    }
    if (this.inflight) return this.inflight;

    const address = this.config.get<string>('TTS_SERVICE_ADDRESS') ?? DEFAULT_TTS_ADDRESS;
    this.inflight = fetchTtsCapabilities(address, FETCH_TIMEOUT_MS)
      .then((value) => {
        this.cached = { value, at: Date.now() };
        return value;
      })
      .catch((err) => {
        this.logger.warn(`TTS capabilities fetch failed (${address}): ${(err as Error).message}`);
        // Serve a stale value if we have one; otherwise the empty catalog.
        return this.cached?.value ?? UNAVAILABLE;
      })
      .finally(() => {
        this.inflight = null;
      });

    return this.inflight;
  }
}
