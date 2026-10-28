import { BadRequestException } from '@nestjs/common';

/**
 * How Stella plays synthesized speech (agent env STELLA_TTS_PLAYBACK, read once
 * per pipeline by the SDK; see agents/stella-ai-agent-sdk/.../audio/pipeline.py).
 */
export const TTS_PLAYBACK_ENV = 'STELLA_TTS_PLAYBACK';
/** Tells the agent where the mode came from, so its log can say so. */
export const TTS_PLAYBACK_SOURCE_ENV = 'STELLA_TTS_PLAYBACK_SOURCE';
/** PlatformSetting key holding the admin default. */
export const TTS_PLAYBACK_SETTING_KEY = 'ttsPlayback';

export const TTS_PLAYBACK_MODES = ['auto', 'stream', 'sentence'] as const;
export type TtsPlaybackMode = (typeof TTS_PLAYBACK_MODES)[number];
export type TtsPlaybackSource = 'deployment' | 'platform' | 'default';

export interface TtsPlaybackResolution {
  value: TtsPlaybackMode;
  source: TtsPlaybackSource;
}

function normalize(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase();
}

/**
 * Only `stream` and `sentence` pin a deployment. `auto` does not: agent.yaml
 * declares `default: "auto"`, so a template or deployment can carry it without
 * its owner having chosen anything, and it must not hide the platform default.
 */
export function isPinnedTtsPlayback(raw: string | null | undefined): boolean {
  const value = normalize(raw);
  return value === 'stream' || value === 'sentence';
}

/**
 * Precedence: a mode pinned on the deployment, then the platform default set by
 * a system admin, then the built-in default (`auto`).
 */
export function resolveTtsPlayback(
  deploymentValue: string | null | undefined,
  platformValue: string | null | undefined,
): TtsPlaybackResolution {
  if (isPinnedTtsPlayback(deploymentValue)) {
    return { value: normalize(deploymentValue) as TtsPlaybackMode, source: 'deployment' };
  }
  const platform = normalize(platformValue);
  if ((TTS_PLAYBACK_MODES as readonly string[]).includes(platform)) {
    return { value: platform as TtsPlaybackMode, source: 'platform' };
  }
  return { value: 'auto', source: 'default' };
}

/**
 * Return a copy of a resolved pod env map with the effective playback mode and
 * its source written in. Called at every pod creation (deploy, restart, wake),
 * so a change to the platform default reaches the next session and never a
 * running one.
 */
export function applyTtsPlayback(
  env: Record<string, string>,
  platformValue: string | null | undefined,
): { env: Record<string, string>; resolution: TtsPlaybackResolution } {
  const resolution = resolveTtsPlayback(env[TTS_PLAYBACK_ENV], platformValue);
  return {
    env: {
      ...env,
      [TTS_PLAYBACK_ENV]: resolution.value,
      [TTS_PLAYBACK_SOURCE_ENV]: resolution.source,
    },
    resolution,
  };
}

/** Validate an admin write: one of the three modes, or null to clear it. */
export function parseTtsPlaybackSetting(raw: unknown): TtsPlaybackMode | null {
  if (raw === null) return null;
  if (typeof raw === 'string' && (TTS_PLAYBACK_MODES as readonly string[]).includes(raw)) {
    return raw as TtsPlaybackMode;
  }
  throw new BadRequestException(
    `ttsPlayback must be one of ${TTS_PLAYBACK_MODES.join(', ')}, or null`,
  );
}
