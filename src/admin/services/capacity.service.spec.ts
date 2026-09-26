import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CapacityService } from './capacity.service';
import { RecordCapacityDto } from '../dto/capacity.dto';

const payload = {
  measuredAt: '2026-09-26T12:00:00+00:00',
  gpuName: 'Tesla T4',
  gpuMemoryMb: 15360,
  sttProvider: 'whisper',
  ttsProvider: 'qwen3',
  environment: 'development',
  gitRevision: 'abc1234',
  maxSessions: 4,
  limitedBy: ['speech recognition final p95 2100 ms vs 600 ms alone (limit +1000 ms)'],
  reachedTopLevel: false,
  durationSeconds: 60,
  criteria: { stt_final_slack_ms: 1000 },
  levels: [{ sessions: 1 }, { sessions: 2 }],
};

function row(over: Record<string, unknown>) {
  return {
    id: 'id',
    createdAt: new Date(),
    gpuMemoryMb: null,
    sttProvider: null,
    ttsProvider: null,
    gitRevision: null,
    limitedBy: [],
    reachedTopLevel: false,
    durationSeconds: 60,
    criteria: {},
    levels: [],
    ...over,
  };
}

describe('RecordCapacityDto', () => {
  it('accepts exactly what the load test script posts', async () => {
    const errors = await validate(plainToInstance(RecordCapacityDto, payload), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors).toEqual([]);
  });

  it('rejects a result with no GPU name or a negative capacity', async () => {
    const errors = await validate(
      plainToInstance(RecordCapacityDto, { ...payload, gpuName: undefined, maxSessions: -1 }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors.map((e) => e.property).sort()).toEqual(['gpuName', 'maxSessions']);
  });
});

describe('CapacityService', () => {
  it('stores a run and returns it with ISO dates', async () => {
    const create = jest.fn().mockImplementation(({ data }) =>
      Promise.resolve(row({ ...data, id: 'new' })),
    );
    const service = new CapacityService({ capacityMeasurement: { create } } as any);
    const view = await service.record(plainToInstance(RecordCapacityDto, payload));
    expect(create.mock.calls[0][0].data.maxSessions).toBe(4);
    expect(view.id).toBe('new');
    expect(view.measuredAt).toBe('2026-09-26T12:00:00.000Z');
    expect(view.gpuName).toBe('Tesla T4');
  });

  it('keeps only the newest run for each environment and GPU', async () => {
    const findMany = jest.fn().mockResolvedValue([
      row({ id: 'new', gpuName: 'Tesla T4', environment: 'development', maxSessions: 5, measuredAt: new Date('2026-09-26') }),
      row({ id: 'old', gpuName: 'Tesla T4', environment: 'development', maxSessions: 3, measuredAt: new Date('2026-09-01') }),
      row({ id: 'prod', gpuName: 'NVIDIA L4', environment: 'production', maxSessions: 9, measuredAt: new Date('2026-09-20') }),
    ]);
    const service = new CapacityService({ capacityMeasurement: { findMany } } as any);
    const latest = await service.latest();
    expect(latest.map((m) => m.id)).toEqual(['new', 'prod']);
    expect(findMany.mock.calls[0][0].orderBy).toEqual({ measuredAt: 'desc' });
  });
});
