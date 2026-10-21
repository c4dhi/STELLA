import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../env-var-templates/encryption.service.js';
import {
  TTS_PLAYBACK_ENV,
  TTS_PLAYBACK_SETTING_KEY,
  TtsPlaybackMode,
  applyTtsPlayback,
  isPinnedTtsPlayback,
  parseTtsPlaybackSetting,
} from './tts-playback.util.js';
import { HARDWARE_FIT, HardwareFit, scoreHardwareFit } from './hardware-fit.util.js';

export interface PinnedDeployment {
  name: string;
  project: string;
  mode: TtsPlaybackMode;
}

export interface PlatformSettingsView {
  // null = never set: the built-in default (auto) applies.
  ttsPlayback: TtsPlaybackMode | null;
  updatedAt: string | null;
  updatedBy: string | null;
  // Deployments that set their own mode and so ignore the default.
  pinnedDeployments: PinnedDeployment[];
  // How well the voice fits this server under its concurrent load (#93);
  // null only when it could not be read.
  hardwareFit: HardwareFit | null;
}

const SPEED_STAGE = 'tts_sentence_speed';
const SWITCH_STAGE = 'tts_playback_switch';

/**
 * Platform-wide defaults a system admin sets in Settings → Platform Defaults.
 * Today that is only the TTS playback mode (#89).
 */
@Injectable()
export class PlatformSettingsService {
  private readonly logger = new Logger(PlatformSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  async getTtsPlayback(): Promise<TtsPlaybackMode | null> {
    const row = await this.prisma.platformSetting.findUnique({
      where: { key: TTS_PLAYBACK_SETTING_KEY },
    });
    if (!row) return null;
    try {
      return parseTtsPlaybackSetting(row.value);
    } catch {
      this.logger.warn(`Ignoring invalid stored ${TTS_PLAYBACK_SETTING_KEY}=${JSON.stringify(row.value)}`);
      return null;
    }
  }

  async getView(): Promise<PlatformSettingsView> {
    const row = await this.prisma.platformSetting.findUnique({
      where: { key: TTS_PLAYBACK_SETTING_KEY },
      include: { updatedBy: { select: { name: true, email: true } } },
    });
    return {
      ttsPlayback: row ? await this.getTtsPlayback() : null,
      updatedAt: row ? row.updatedAt.toISOString() : null,
      updatedBy: row?.updatedBy ? row.updatedBy.name || row.updatedBy.email : null,
      pinnedDeployments: await this.listPinnedDeployments(),
      hardwareFit: await this.getHardwareFit().catch(error => {
        this.logger.warn(`Could not score the hardware fit: ${error.message}`);
        return null;
      }),
    };
  }

  /**
   * Score the voice against this server from the last two weeks of sessions:
   * every sentence's speed and every `auto` switch the agents published, plus
   * all other analytics as the sign a session was in conversation. The newest
   * load test fills in session counts the live data has not reached.
   */
  async getHardwareFit(now: Date = new Date()): Promise<HardwareFit> {
    const since = new Date(now.getTime() - HARDWARE_FIT.windowDays * 24 * 3600 * 1000);
    const analytics = { messageType: 'analytics', timestamp: { gte: since } };
    const stage = (name: string) => ({ metadata: { path: ['envelope', 'data', 'stage'], equals: name } });

    const [measured, activity, loadTest] = await Promise.all([
      this.prisma.message.findMany({
        where: { ...analytics, OR: [stage(SPEED_STAGE), stage(SWITCH_STAGE)] },
        select: { sessionId: true, timestamp: true, metadata: true },
      }),
      this.prisma.message.findMany({
        where: analytics,
        select: { sessionId: true, timestamp: true },
      }),
      this.prisma.capacityMeasurement.findFirst({
        orderBy: { measuredAt: 'desc' },
        select: { maxSessions: true, reachedTopLevel: true, gpuName: true, ttsProvider: true },
      }),
    ]);

    const speeds: { sessionId: string; at: number; rtf: number }[] = [];
    const switches: { sessionId: string; at: number }[] = [];
    for (const row of measured) {
      const data = (row.metadata as any)?.envelope?.data;
      const at = row.timestamp.getTime();
      if (data?.stage === SPEED_STAGE && typeof data.rtf === 'number' && Number.isFinite(data.rtf)) {
        speeds.push({ sessionId: row.sessionId, at, rtf: data.rtf });
      } else if (data?.stage === SWITCH_STAGE) {
        switches.push({ sessionId: row.sessionId, at });
      }
    }
    return scoreHardwareFit({
      speeds,
      switches,
      activity: activity.map(row => ({ sessionId: row.sessionId, at: row.timestamp.getTime() })),
      loadTest,
    });
  }

  /** Set the default (null clears it, back to the built-in default). */
  async setTtsPlayback(raw: unknown, userId: string): Promise<PlatformSettingsView> {
    const value = parseTtsPlaybackSetting(raw);
    if (value === null) {
      await this.prisma.platformSetting.deleteMany({ where: { key: TTS_PLAYBACK_SETTING_KEY } });
    } else {
      await this.prisma.platformSetting.upsert({
        where: { key: TTS_PLAYBACK_SETTING_KEY },
        create: { key: TTS_PLAYBACK_SETTING_KEY, value, updatedById: userId },
        update: { value, updatedById: userId },
      });
    }
    this.logger.log(`Platform default ${TTS_PLAYBACK_SETTING_KEY} set to ${value ?? '(built-in default)'} by ${userId}`);
    return this.getView();
  }

  /**
   * Write the effective playback mode into a resolved pod env map. Called at
   * every pod creation (deploy, restart, wake), never on a running pod. A
   * failed settings read must not stop an agent from starting, so it falls
   * back to the deployment's own value or the built-in default.
   */
  async applyToPodEnv(env: Record<string, string>, agentId: string): Promise<Record<string, string>> {
    let platform: TtsPlaybackMode | null = null;
    try {
      platform = await this.getTtsPlayback();
    } catch (error) {
      this.logger.warn(`Could not read platform ${TTS_PLAYBACK_SETTING_KEY} for agent ${agentId}: ${error.message}`);
    }
    const { env: out, resolution } = applyTtsPlayback(env, platform);
    this.logger.log(`Agent ${agentId}: TTS playback ${resolution.value} (from ${resolution.source})`);
    return out;
  }

  /**
   * Deployments that pin stream/sentence and so keep their mode whatever the
   * default says: public projects (each new participant spawns from their
   * stored setup) and agents in sessions still open (they respawn on wake).
   * Only the mode leaves this method; no other env value is returned.
   */
  async listPinnedDeployments(): Promise<PinnedDeployment[]> {
    const templateCache = new Map<string, Record<string, string>>();
    const templateVars = async (id: string | null | undefined) => {
      if (!id) return {};
      if (!templateCache.has(id)) {
        const template = await this.prisma.envVarTemplate.findUnique({ where: { id }, select: { variables: true } });
        templateCache.set(id, template ? this.safeDecrypt(template.variables) : {});
      }
      return templateCache.get(id)!;
    };
    const pinned: PinnedDeployment[] = [];
    const add = (name: string, project: string, vars: Record<string, string>) => {
      const raw = vars[TTS_PLAYBACK_ENV];
      if (isPinnedTtsPlayback(raw)) {
        pinned.push({ name, project, mode: raw.trim().toLowerCase() as TtsPlaybackMode });
      }
    };

    const publicProjects = await this.prisma.project.findMany({
      where: { isPublic: true, publicEnabled: true },
      select: { name: true, publicAgentConfig: true, publicAgentType: { select: { name: true } } },
    });
    for (const project of publicProjects) {
      const config = (project.publicAgentConfig ?? {}) as {
        name?: string;
        envVarTemplateId?: string;
        envVars?: Record<string, string>;
      };
      const vars = { ...(await templateVars(config.envVarTemplateId)), ...(config.envVars ?? {}) };
      add(config.name || project.publicAgentType?.name || 'Public agent', project.name, vars);
    }

    const agents = await this.prisma.agentInstance.findMany({
      where: { session: { status: 'ACTIVE' } },
      select: {
        name: true,
        envVarTemplateId: true,
        manualEnvVarsEncrypted: true,
        session: { select: { project: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    for (const agent of agents) {
      const manual = agent.manualEnvVarsEncrypted ? this.safeDecrypt(agent.manualEnvVarsEncrypted) : {};
      const vars = { ...(await templateVars(agent.envVarTemplateId)), ...manual };
      add(agent.name, agent.session.project.name, vars);
    }
    return pinned;
  }

  private safeDecrypt(encrypted: string): Record<string, string> {
    try {
      return this.encryption.decrypt(encrypted);
    } catch {
      return {};
    }
  }
}
