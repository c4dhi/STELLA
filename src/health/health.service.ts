import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { LiveKitService } from '../livekit/livekit.service.js';
import { checkSttHealth, checkTtsHealth } from './grpc/grpc-health.client.js';
import {
  ComponentId,
  ComponentStatus,
  PublicHealthComponent,
  PublicHealthResponse,
} from './dto/public-health.dto.js';

const PER_CHECK_TIMEOUT_MS = 1500;
const DEFAULT_CACHE_TTL_MS = 15_000;

type CheckOutcome = 'ok' | 'timeout' | 'error';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly cacheTtlMs: number;
  private cached: { result: PublicHealthResponse; computedAt: number } | null = null;
  private inflight: Promise<PublicHealthResponse> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly livekit: LiveKitService,
  ) {
    const ttl = Number(this.config.get('PUBLIC_HEALTH_TTL_MS'));
    this.cacheTtlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_CACHE_TTL_MS;
  }

  async getPublicHealth(): Promise<PublicHealthResponse> {
    const now = Date.now();
    if (this.cached && now - this.cached.computedAt < this.cacheTtlMs) {
      return this.cached.result;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.compute()
      .then((result) => {
        this.cached = { result, computedAt: Date.now() };
        return result;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async compute(): Promise<PublicHealthResponse> {
    const [database, realtime, stt, tts] = await Promise.all([
      this.timed(() => this.checkDatabase()),
      this.timed(() => this.checkRealtime()),
      this.timed(() => this.checkStt()),
      this.timed(() => this.checkTts()),
    ]);

    const components: PublicHealthComponent[] = [
      this.toComponent('api', 'ok'),
      this.toComponent('database', database),
      this.toComponent('realtime', realtime),
      this.toComponent('stt', stt),
      this.toComponent('tts', tts),
    ];

    return {
      status: this.aggregate(components),
      components,
      generatedAt: this.nowSeconds(),
    };
  }

  private async timed(fn: () => Promise<boolean>): Promise<CheckOutcome> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), PER_CHECK_TIMEOUT_MS);
        timer.unref?.();
      });
      const work = fn().then(
        (ok) => (ok ? ('ok' as const) : ('error' as const)),
        () => 'error' as const,
      );
      const result = await Promise.race([work, timeout]);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async checkDatabase(): Promise<boolean> {
    await this.prisma.$queryRaw`SELECT 1`;
    return true;
  }

  private async checkRealtime(): Promise<boolean> {
    const url = this.livekit.getServerUrl();
    const httpUrl = url.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PER_CHECK_TIMEOUT_MS - 100);
      try {
        const res = await fetch(httpUrl, { method: 'GET', signal: controller.signal });
        return res.status > 0 && res.status < 600;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  private async checkStt(): Promise<boolean> {
    const addr = this.config.get<string>('STT_SERVICE_ADDRESS') ?? 'stt-service:50051';
    return checkSttHealth(addr, PER_CHECK_TIMEOUT_MS);
  }

  private async checkTts(): Promise<boolean> {
    const addr = this.config.get<string>('TTS_SERVICE_ADDRESS') ?? 'tts-service:50052';
    return checkTtsHealth(addr, PER_CHECK_TIMEOUT_MS);
  }

  private toComponent(id: ComponentId, outcome: CheckOutcome): PublicHealthComponent {
    let status: ComponentStatus;
    if (outcome === 'ok') status = 'operational';
    else if (outcome === 'timeout') status = 'degraded';
    else status = 'down';
    return { id, status, lastCheckedAt: this.nowSeconds() };
  }

  private aggregate(components: PublicHealthComponent[]): ComponentStatus {
    if (components.some((c) => c.status === 'down')) return 'down';
    if (components.some((c) => c.status === 'degraded')) return 'degraded';
    return 'operational';
  }

  private nowSeconds(): string {
    const d = new Date();
    d.setMilliseconds(0);
    return d.toISOString();
  }
}
