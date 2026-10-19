import {
  applyTtsPlayback,
  isPinnedTtsPlayback,
  parseTtsPlaybackSetting,
  resolveTtsPlayback,
} from './tts-playback.util.js';

describe('resolveTtsPlayback', () => {
  it('keeps a mode pinned on the deployment, whatever the platform says', () => {
    expect(resolveTtsPlayback('stream', 'sentence')).toEqual({ value: 'stream', source: 'deployment' });
    expect(resolveTtsPlayback(' Sentence ', 'stream')).toEqual({ value: 'sentence', source: 'deployment' });
  });

  it('treats auto, empty or unknown on the deployment as not pinned', () => {
    // agent.yaml declares default "auto", so a deployment can carry it without
    // anyone having chosen it; it must not hide the platform default.
    for (const unpinned of ['auto', '', '  ', undefined, 'loud']) {
      expect(resolveTtsPlayback(unpinned, 'sentence')).toEqual({ value: 'sentence', source: 'platform' });
    }
  });

  it('uses the platform default, including auto, when the deployment pins nothing', () => {
    expect(resolveTtsPlayback(undefined, 'auto')).toEqual({ value: 'auto', source: 'platform' });
  });

  it('falls back to the built-in default when neither sets a mode', () => {
    expect(resolveTtsPlayback(undefined, null)).toEqual({ value: 'auto', source: 'default' });
    expect(resolveTtsPlayback('auto', undefined)).toEqual({ value: 'auto', source: 'default' });
  });
});

describe('applyTtsPlayback', () => {
  it('writes the effective mode and its source into the pod env, leaving the rest alone', () => {
    const env = { OPENAI_API_KEY: 'k', STELLA_TTS_PLAYBACK: 'auto' };
    expect(applyTtsPlayback(env, 'sentence')).toEqual({
      env: {
        OPENAI_API_KEY: 'k',
        STELLA_TTS_PLAYBACK: 'sentence',
        STELLA_TTS_PLAYBACK_SOURCE: 'platform',
      },
      resolution: { value: 'sentence', source: 'platform' },
    });
    // The input map is not mutated: callers may persist it.
    expect(env.STELLA_TTS_PLAYBACK).toBe('auto');
  });

  it('leaves a pinned deployment on its own mode', () => {
    expect(applyTtsPlayback({ STELLA_TTS_PLAYBACK: 'stream' }, 'sentence').env).toEqual({
      STELLA_TTS_PLAYBACK: 'stream',
      STELLA_TTS_PLAYBACK_SOURCE: 'deployment',
    });
  });
});

describe('parseTtsPlaybackSetting', () => {
  it('accepts the three modes and null (back to the built-in default)', () => {
    expect(parseTtsPlaybackSetting('auto')).toBe('auto');
    expect(parseTtsPlaybackSetting('stream')).toBe('stream');
    expect(parseTtsPlaybackSetting('sentence')).toBe('sentence');
    expect(parseTtsPlaybackSetting(null)).toBeNull();
  });

  it('rejects anything else', () => {
    for (const bad of ['', 'loud', 'STREAM ', 3, undefined, {}]) {
      expect(() => parseTtsPlaybackSetting(bad)).toThrow();
    }
  });
});

describe('isPinnedTtsPlayback', () => {
  it('is true only for stream and sentence', () => {
    expect(isPinnedTtsPlayback('stream')).toBe(true);
    expect(isPinnedTtsPlayback('sentence')).toBe(true);
    expect(isPinnedTtsPlayback('auto')).toBe(false);
    expect(isPinnedTtsPlayback(undefined)).toBe(false);
  });
});
