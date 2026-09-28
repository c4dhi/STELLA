import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * One finished run of the load test (scripts/load-test/load_test.py), as it
 * posts itself. Field names match the script's JSON output exactly, because
 * the ValidationPipe rejects anything not listed here.
 */
export class RecordCapacityDto {
  @IsDateString()
  measuredAt: string;

  @IsString()
  @MaxLength(200)
  gpuName: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  gpuMemoryMb?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  sttProvider?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ttsProvider?: string;

  /** Which deployment was measured, e.g. "development" or "production". */
  @IsString()
  @MaxLength(100)
  environment: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  gitRevision?: string;

  /** Highest simultaneous session count that kept the voice fluent. */
  @IsInt()
  @Min(0)
  maxSessions: number;

  /** Why the next level failed; empty when the top level passed. */
  @IsArray()
  @IsString({ each: true })
  limitedBy: string[];

  /** True when even the highest level tried passed, so the real limit is higher. */
  @IsBoolean()
  reachedTopLevel: boolean;

  @IsInt()
  @Min(1)
  durationSeconds: number;

  @IsObject()
  criteria: Record<string, unknown>;

  @IsArray()
  @IsObject({ each: true })
  levels: Record<string, unknown>[];
}
