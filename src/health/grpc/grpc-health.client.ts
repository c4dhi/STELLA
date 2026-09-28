import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveProtoDir(): string {
  if (process.env.PROTO_PATH) return process.env.PROTO_PATH;
  const docker = join(__dirname, '../../../proto');
  const local = join(__dirname, '../../../../proto');
  return existsSync(join(docker, 'stt.proto')) ? docker : local;
}

function buildClient(
  protoFile: 'stt.proto' | 'tts.proto',
  pkg: 'stt' | 'tts',
  service: 'SpeechToText' | 'TextToSpeech',
  address: string,
): grpc.Client {
  const protoPath = join(resolveProtoDir(), protoFile);
  const def = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(def) as Record<string, any>;
  const ServiceCtor = loaded[pkg][service];
  return new ServiceCtor(address, grpc.credentials.createInsecure()) as grpc.Client;
}

function callHealth(client: grpc.Client, deadlineMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = new Date(Date.now() + deadlineMs);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      (client as any).HealthCheck(
        {},
        { deadline },
        (err: grpc.ServiceError | null, res?: { healthy: boolean }) => {
          if (err || !res) return finish(false);
          finish(Boolean(res.healthy));
        },
      );
    } catch {
      return finish(false);
    }
    setTimeout(() => finish(false), deadlineMs + 100).unref();
  });
}

export async function checkSttHealth(address: string, timeoutMs = 1500): Promise<boolean> {
  const client = buildClient('stt.proto', 'stt', 'SpeechToText', address);
  try {
    return await callHealth(client, timeoutMs);
  } finally {
    client.close();
  }
}

export async function checkTtsHealth(address: string, timeoutMs = 1500): Promise<boolean> {
  const client = buildClient('tts.proto', 'tts', 'TextToSpeech', address);
  try {
    return await callHealth(client, timeoutMs);
  } finally {
    client.close();
  }
}
