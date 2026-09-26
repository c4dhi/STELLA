import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RecordCapacityDto } from '../dto/capacity.dto';

export interface CapacityMeasurementView {
  id: string;
  measuredAt: string;
  gpuName: string;
  gpuMemoryMb: number | null;
  environment: string;
  sttProvider: string | null;
  ttsProvider: string | null;
  gitRevision: string | null;
  maxSessions: number;
  limitedBy: string[];
  reachedTopLevel: boolean;
  durationSeconds: number;
  criteria: Record<string, unknown>;
  levels: Record<string, unknown>[];
}

/**
 * Measured voice capacity: how many simultaneous conversations one server's GPU
 * carried before speech recognition or the voice slowed or stuttered.
 *
 * The numbers come from the load test script, run against a real server. They
 * are never derived here: a number in code is not a limit until it has been
 * shown to cap something (handbook: surface-hard-limits).
 */
@Injectable()
export class CapacityService {
  constructor(private readonly prisma: PrismaService) {}

  async record(dto: RecordCapacityDto): Promise<CapacityMeasurementView> {
    const row = await this.prisma.capacityMeasurement.create({
      data: {
        measuredAt: new Date(dto.measuredAt),
        gpuName: dto.gpuName,
        gpuMemoryMb: dto.gpuMemoryMb ?? null,
        environment: dto.environment,
        sttProvider: dto.sttProvider || null,
        ttsProvider: dto.ttsProvider || null,
        gitRevision: dto.gitRevision || null,
        maxSessions: dto.maxSessions,
        limitedBy: dto.limitedBy,
        reachedTopLevel: dto.reachedTopLevel,
        durationSeconds: dto.durationSeconds,
        criteria: dto.criteria as object,
        levels: dto.levels as object[],
      },
    });
    return this.toView(row);
  }

  /**
   * The newest measurement for each environment + GPU pair. A server whose GPU
   * was swapped shows both: the old number is not the new hardware's.
   */
  async latest(): Promise<CapacityMeasurementView[]> {
    const rows = await this.prisma.capacityMeasurement.findMany({
      orderBy: { measuredAt: 'desc' },
    });
    const seen = new Set<string>();
    const out: CapacityMeasurementView[] = [];
    for (const row of rows) {
      const key = `${row.environment}\u0000${row.gpuName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(this.toView(row));
    }
    return out;
  }

  private toView(row: any): CapacityMeasurementView {
    return {
      id: row.id,
      measuredAt: row.measuredAt.toISOString(),
      gpuName: row.gpuName,
      gpuMemoryMb: row.gpuMemoryMb,
      environment: row.environment,
      sttProvider: row.sttProvider,
      ttsProvider: row.ttsProvider,
      gitRevision: row.gitRevision,
      maxSessions: row.maxSessions,
      limitedBy: row.limitedBy,
      reachedTopLevel: row.reachedTopLevel,
      durationSeconds: row.durationSeconds,
      criteria: row.criteria as Record<string, unknown>,
      levels: row.levels as Record<string, unknown>[],
    };
  }
}
