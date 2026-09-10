export class StageLatencyDto {
  stage: string;
  count: number;
  mean_ms: number;
  p5_ms: number;
  p25_ms: number;
  p50_ms: number;
  p75_ms: number;
  p95_ms: number;
  min_ms: number;
  max_ms: number;
  stddev_ms: number;
}

export class OutlierStageDto {
  stage: string;
  sessionMean_ms: number;
  globalP50_ms: number;
}

export class OutlierSessionDto {
  sessionId: string;
  sessionName: string;
  createdAt: string;
  outlierStages: OutlierStageDto[];
}

export class MetricsSummaryDto {
  planCompletion: {
    totalSessions: number;
    completedPlans: number;
    avgCompletionRate: number;
  } | null;
  safetyRouting: {
    totalTurns: number;
    safeTurns: number;
    unsafeTurns: number;
    interceptionRate: number;
  } | null;
  stateTransitions: {
    totalTransitions: number;
    expectedTransitions: number;
    accuracy: number;
  } | null;
  bridgeGeneration: {
    totalBridges: number;
    avgBridgeDuration_ms: number;
  } | null;
  bridgeDuration: {
    count: number;
    avg_ms: number;
  } | null;
  ttfr: {
    count: number;
    avg_ms: number;
  } | null;
  /**
   * STT decode diagnostics. Null unless the STT service is running with
   * STT_DECODE_DIAGNOSTICS enabled — this is investigation instrumentation,
   * not a metric every deployment produces.
   */
  sttDecode: {
    totalTurns: number;
    avgSilenceFraction: number | null;
    avgNoSpeechWorst: number | null;
    avgLogprobWorst: number | null;
    shadowTurns: number;
    shadowAgreementRate: number | null;
    avgShadowEarlier_ms: number | null;
    partialTurns: number;
    partialAgreementRate: number | null;
  } | null;
}

export class AgentMetricsResponseDto {
  agentSlug: string;
  projectId: string;
  dateRange: { from: string; to: string };
  totalSessions: number;
  totalTurns: number;
  stages: StageLatencyDto[];
  outlierSessions: OutlierSessionDto[];
  summary: MetricsSummaryDto;
}

export class StageDataPointDto {
  sessionId: string;
  sessionName: string;
  avg_timing_ms: number;
  count: number;
  timestamp: string;
}

export class SessionStagePointDto {
  stage: string;
  timing_ms: number;
  timestamp: string;
}

export class SessionAnalyticsResponseDto {
  sessionId: string;
  totalTurns: number;
  stages: StageLatencyDto[];
  summary: MetricsSummaryDto;
  rawPoints: SessionStagePointDto[];
}

export class PlanCompletionSessionDto {
  sessionId: string;
  sessionName: string;
  completionRate: number;
  reachedEnd: boolean;
  timestamp: string;
}
