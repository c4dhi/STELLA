import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Thin gRPC client for the tts-service `GetCapabilities` RPC.
 *
 * Mirrors the resolution + insecure-channel pattern in
 * `health/grpc/grpc-health.client.ts` (the only other place NestJS talks to
 * the tts-service). Kept self-contained so the TTS module doesn't depend on
 * the health module's internals.
 */

function resolveProtoDir(): string {
  if (process.env.PROTO_PATH) return process.env.PROTO_PATH;
  const docker = join(__dirname, '../../../proto');
  const local = join(__dirname, '../../../../proto');
  return existsSync(join(docker, 'tts.proto')) ? docker : local;
}

// Shape returned by proto-loader (keepCase: true → snake_case preserved).
interface RawVoiceInfo {
  id: string;
  display_name: string;
  languages: string[];
  default_language: string;
}
interface RawCapabilitiesResponse {
  provider: string;
  voices: RawVoiceInfo[];
  languages: string[];
  default_voice: string;
  supports_voice_selection: boolean;
}

export interface TtsVoiceInfo {
  id: string;
  displayName: string;
  languages: string[];
  defaultLanguage: string;
}
export interface TtsCapabilities {
  provider: string;
  voices: TtsVoiceInfo[];
  languages: string[];
  defaultVoice: string;
  supportsVoiceSelection: boolean;
}

function buildClient(address: string): grpc.Client {
  const protoPath = join(resolveProtoDir(), 'tts.proto');
  const def = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(def) as Record<string, any>;
  const ServiceCtor = loaded.tts.TextToSpeech;
  return new ServiceCtor(address, grpc.credentials.createInsecure()) as grpc.Client;
}

function normalize(res: RawCapabilitiesResponse): TtsCapabilities {
  return {
    provider: res.provider ?? '',
    voices: (res.voices ?? []).map((v) => ({
      id: v.id,
      displayName: v.display_name || v.id,
      languages: v.languages ?? [],
      defaultLanguage: v.default_language ?? '',
    })),
    languages: res.languages ?? [],
    defaultVoice: res.default_voice ?? '',
    supportsVoiceSelection: Boolean(res.supports_voice_selection),
  };
}

export function fetchTtsCapabilities(address: string, timeoutMs = 2500): Promise<TtsCapabilities> {
  const client = buildClient(address);
  return new Promise<TtsCapabilities>((resolve, reject) => {
    const deadline = new Date(Date.now() + timeoutMs);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      client.close();
      fn();
    };
    try {
      (client as any).GetCapabilities(
        {},
        { deadline },
        (err: grpc.ServiceError | null, res?: RawCapabilitiesResponse) => {
          if (err || !res) return finish(() => reject(err ?? new Error('empty capabilities response')));
          finish(() => resolve(normalize(res)));
        },
      );
    } catch (e) {
      return finish(() => reject(e as Error));
    }
    setTimeout(() => finish(() => reject(new Error('GetCapabilities timed out'))), timeoutMs + 100).unref();
  });
}
