import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { TtsCapabilities } from './grpc/tts-capabilities.client.js';

// Real ES module namespace objects are frozen, so `jest.spyOn(client, 'fetchTtsCapabilities')`
// can't reassign the export under native ESM. Mock the module before importing the service
// under test, per Jest's documented ESM mocking pattern.
const fetchTtsCapabilities = jest.fn<
  (address: string, timeoutMs: number) => Promise<TtsCapabilities>
>();
jest.unstable_mockModule('./grpc/tts-capabilities.client.js', () => ({
  fetchTtsCapabilities,
}));

const { TtsService } = await import('./tts.service.js');

describe('TtsService', () => {
  const caps: TtsCapabilities = {
    provider: 'qwen3',
    voices: [{ id: 'stella', displayName: 'Stella', languages: ['en', 'de'], defaultLanguage: 'en' }],
    languages: ['en', 'de', 'fr'],
    defaultVoice: 'stella',
    supportsVoiceSelection: false,
  };

  const makeService = () => {
    const config = { get: jest.fn().mockReturnValue('tts-service:50052') } as unknown as ConfigService;
    return new TtsService(config);
  };

  afterEach(() => fetchTtsCapabilities.mockReset());

  it('fetches capabilities from the gRPC client', async () => {
    fetchTtsCapabilities.mockResolvedValue(caps);
    const service = makeService();

    await expect(service.getCapabilities()).resolves.toEqual(caps);
    expect(fetchTtsCapabilities).toHaveBeenCalledTimes(1);
  });

  it('caches the result and does not refetch within the TTL', async () => {
    fetchTtsCapabilities.mockResolvedValue(caps);
    const service = makeService();

    await service.getCapabilities();
    await service.getCapabilities();

    expect(fetchTtsCapabilities).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent fetches into a single in-flight call', async () => {
    fetchTtsCapabilities.mockResolvedValue(caps);
    const service = makeService();

    const [a, b] = await Promise.all([service.getCapabilities(), service.getCapabilities()]);

    expect(a).toEqual(caps);
    expect(b).toEqual(caps);
    expect(fetchTtsCapabilities).toHaveBeenCalledTimes(1);
  });

  it('returns a safe empty catalog when the tts-service is unreachable', async () => {
    fetchTtsCapabilities.mockRejectedValue(new Error('unreachable'));
    const service = makeService();

    const result = await service.getCapabilities();

    expect(result.voices).toEqual([]);
    expect(result.supportsVoiceSelection).toBe(false);
    expect(result.provider).toBe('unavailable');
  });
});
