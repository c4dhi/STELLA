import { IsArray, IsIn, IsObject, IsOptional, IsString } from 'class-validator';

/** The logger methods a monitoring log may use; anything else is a 400 (#145). */
export const MONITORING_LOG_LEVELS = ['log', 'debug', 'warn', 'error'] as const;
export type MonitoringLogLevel = (typeof MONITORING_LOG_LEVELS)[number];

/** `POST /internal/monitoring/logs`, sent by the message recorder. */
export class MonitoringLogDto {
  @IsIn(MONITORING_LOG_LEVELS)
  level!: MonitoringLogLevel;

  @IsString()
  message!: string;

  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}

/** `POST /internal/monitoring/status`, sent by the message recorder. */
export class MonitoringStatusDto {
  @IsArray()
  @IsString({ each: true })
  connectedSessions!: string[];
}
