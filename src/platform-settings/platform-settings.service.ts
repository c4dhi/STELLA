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
import { MCP_ENABLED_SETTING_KEY, parseMcpEnabledSetting, parseStoredMcpEnabled } from './mcp-enabled.util.js';

// Every MCP request checks the switch, so it is cached. With several backend
// replicas a change reaches the others within this window.
const MCP_ENABLED_CACHE_MS = 30_000;

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
  // Whether AI clients may reach /mcp (#772). Off unless an admin turns it on.
  mcpEnabled: boolean;
}

/**
 * Platform-wide defaults a system admin sets in Settings → Platform Defaults:
 * the TTS playback mode (#89) and the MCP switch (#772).
 */
@Injectable()
export class PlatformSettingsService {
  private readonly logger = new Logger(PlatformSettingsService.name);
  private mcpEnabledCache: { value: boolean; expiresAt: number } | null = null;

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
      mcpEnabled: await this.isMcpEnabled(),
    };
  }

  /** Whether /mcp is open. A failed read counts as off: the switch fails closed. */
  async isMcpEnabled(): Promise<boolean> {
    if (this.mcpEnabledCache && this.mcpEnabledCache.expiresAt > Date.now()) {
      return this.mcpEnabledCache.value;
    }
    let value = false;
    try {
      const row = await this.prisma.platformSetting.findUnique({ where: { key: MCP_ENABLED_SETTING_KEY } });
      value = parseStoredMcpEnabled(row?.value);
    } catch (error) {
      this.logger.warn(`Could not read ${MCP_ENABLED_SETTING_KEY}, treating MCP as off: ${error.message}`);
      return false;
    }
    this.mcpEnabledCache = { value, expiresAt: Date.now() + MCP_ENABLED_CACHE_MS };
    return value;
  }

  async setMcpEnabled(raw: unknown, userId: string): Promise<PlatformSettingsView> {
    const enabled = parseMcpEnabledSetting(raw);
    const value = String(enabled);
    await this.prisma.platformSetting.upsert({
      where: { key: MCP_ENABLED_SETTING_KEY },
      create: { key: MCP_ENABLED_SETTING_KEY, value, updatedById: userId },
      update: { value, updatedById: userId },
    });
    this.mcpEnabledCache = null;
    this.logger.log(`Platform setting ${MCP_ENABLED_SETTING_KEY} set to ${value} by ${userId}`);
    return this.getView();
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
