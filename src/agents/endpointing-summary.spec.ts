import { AgentsService } from './agents.service.js';

/**
 * The endpointing rollup (#92): the end-of-speech gap from `stt_end`, and how
 * often a pause was rescued or a turn was cut off (`pause_rescued`,
 * `user_resumed_after_final`). A flat switch over the same analytics rows as
 * every other stage.
 */
function summarize(events: Array<Record<string, unknown>>) {
  const service = Object.create(AgentsService.prototype) as any;
  return service.computeMetricsSummary(
    events.map((data) => ({ sessionId: 's1', metadata: { envelope: { type: 'analytics', data } } })),
  );
}

describe('endpointing summary', () => {
  it('averages the end-of-speech gap and counts the endpointing signals', () => {
    const summary = summarize([
      { stage: 'stt_end', turn_id: 'a', elapsed_ms: 0, trailing_silence_ms: 1100, decode_ms: 300, speech_ms: 2000 },
      { stage: 'stt_end', turn_id: 'b', elapsed_ms: 0, trailing_silence_ms: 1120, decode_ms: 500, speech_ms: 900 },
      { stage: 'stt_end', turn_id: 'c', elapsed_ms: 0 },
      { stage: 'pause_rescued', turn_id: 'a', elapsed_ms: 0, pause_ms: 700, into_window_ms: 200 },
      { stage: 'pause_rescued', turn_id: 'a', elapsed_ms: 0, pause_ms: 900, into_window_ms: 400 },
      { stage: 'user_resumed_after_final', turn_id: 'b', elapsed_ms: 800, since_final_ms: 800, pause_ms: 2200, agent_speaking: true },
    ]);

    expect(summary.endpointing).toEqual({
      totalTurns: 3,
      gapTurns: 2,
      avgTrailingSilence_ms: 1110,
      avgDecode_ms: 400,
      avgEndOfSpeechGap_ms: 1510,
      pausesRescued: 2,
      turnsWithRescuedPause: 1,
      avgRescuedPause_ms: 800,
      avgRescuedIntoWindow_ms: 300,
      resumedAfterFinal: 1,
      resumedWhileAgentSpeaking: 1,
      avgResumedSinceFinal_ms: 800,
    });
  });

  it('is null when no turn reported anything', () => {
    expect(summarize([{ stage: 'bridge_tts_first_byte', turn_id: 'a', elapsed_ms: 500 }]).endpointing).toBeNull();
  });
});
