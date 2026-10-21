import {
  HARDWARE_FIT,
  HardwareFitInput,
  SpeedSample,
  colourFor,
  concurrencyAt,
  scoreHardwareFit,
} from './hardware-fit.util.js';

const T0 = Date.parse('2026-10-20T10:00:00Z');
const MIN = 60_000;

/**
 * `n` sentences per session, every session talking over the same stretch of
 * time, so each sentence sees all `sessions` at once.
 */
function overlapping(sessions: number, perSession: number, rtf: number, start = T0): SpeedSample[] {
  const out: SpeedSample[] = [];
  for (let s = 0; s < sessions; s++) {
    for (let i = 0; i < perSession; i++) {
      out.push({ sessionId: `${start}-s${s}`, at: start + i * 5_000, rtf });
    }
  }
  return out;
}

function input(partial: Partial<HardwareFitInput>): HardwareFitInput {
  return { speeds: [], switches: [], activity: [], loadTest: null, ...partial };
}

describe('colourFor', () => {
  it('is green at 0.8 or faster with fewer than 5% switched', () => {
    expect(colourFor(0.8, 0)).toBe('green');
    expect(colourFor(0.5, 0.049)).toBe('green');
  });

  it('is yellow when slower than 0.8, or when 5% or more switched', () => {
    expect(colourFor(0.81, 0)).toBe('yellow');
    expect(colourFor(0.5, 0.05)).toBe('yellow');
    expect(colourFor(1.5, 0)).toBe('yellow');
  });

  it('is red slower than 1.5, whatever switched', () => {
    expect(colourFor(1.51, 0)).toBe('red');
    expect(colourFor(3, 1)).toBe('red');
  });
});

describe('concurrencyAt', () => {
  const activity = new Map<string, number[]>([
    ['a', [T0, T0 + 10 * MIN]],
    ['b', [T0 + 30_000]],
    ['c', [T0 + 3 * MIN]],
  ]);

  it('counts sessions with any activity within a minute either side', () => {
    expect(concurrencyAt(activity, T0)).toBe(2); // a and b
    expect(concurrencyAt(activity, T0 + 2 * MIN)).toBe(1); // c, only just
    expect(concurrencyAt(activity, T0 + 10 * MIN)).toBe(1); // a again
  });

  it('never reads below one: the sentence itself is a session talking', () => {
    expect(concurrencyAt(activity, T0 + 6 * MIN)).toBe(1);
  });
});

describe('scoreHardwareFit', () => {
  it('gives no reading below 200 sentences', () => {
    const fit = scoreHardwareFit(input({ speeds: overlapping(3, 66, 0.5) })); // 198
    expect(fit.colour).toBeNull();
    expect(fit.sentencesSeen).toBe(198);
    expect(fit.sentencesNeeded).toBe(HARDWARE_FIT.minSentences);
  });

  it('gives no reading from fewer than 3 sessions, however many sentences', () => {
    const fit = scoreHardwareFit(input({ speeds: overlapping(2, 150, 0.5) }));
    expect(fit.colour).toBeNull();
  });

  it('reads dev as expected: Qwen3 on a T4 at 0.92–1.33 is yellow', () => {
    const speeds = overlapping(3, 80, 0.92).map((s, i) => ({ ...s, rtf: 0.92 + (i % 10) * 0.045 }));
    const fit = scoreHardwareFit(input({ speeds }));
    expect(fit.colour).toBe('yellow');
    expect(fit.usualSessions).toBe(3);
    expect(fit.yellowUpTo).toBe(3);
    expect(fit.greenUpTo).toBeNull();
  });

  it('uses the slowest 10%: a fast median does not hide a slow tail', () => {
    const speeds = overlapping(4, 60, 0.4).map((s, i) => (i % 5 === 0 ? { ...s, rtf: 1.2 } : s));
    const fit = scoreHardwareFit(input({ speeds }));
    expect(fit.colour).toBe('yellow');
    expect(fit.buckets.find(b => b.sessions === 4)!.rtfP90).toBeCloseTo(1.2);
  });

  it('a fast server where sessions switched anyway is yellow, not green', () => {
    const speeds = overlapping(4, 60, 0.5);
    const switches = [{ sessionId: speeds[0].sessionId, at: speeds[0].at }];
    const fit = scoreHardwareFit(input({ speeds, switches }));
    expect(fit.buckets.find(b => b.sessions === 4)!.switchedShare).toBe(0.25);
    expect(fit.colour).toBe('yellow');
  });

  it('groups sentences by sessions at once, and says how far each colour holds', () => {
    const speeds = [
      ...overlapping(1, 60, 0.5, T0),
      ...overlapping(1, 60, 0.6, T0 + 60 * MIN),
      ...overlapping(2, 30, 0.9, T0 + 120 * MIN),
      ...overlapping(3, 20, 1.8, T0 + 180 * MIN),
    ];
    const fit = scoreHardwareFit(input({ speeds }));
    expect(fit.buckets.map(b => [b.sessions, b.colour])).toEqual([
      [1, 'green'],
      [2, 'yellow'],
      [3, 'red'],
    ]);
    expect(fit.greenUpTo).toBe(1);
    expect(fit.yellowUpTo).toBe(2);
    expect(fit.redFrom).toBe(3);
  });

  it('takes the headline from the usual load', () => {
    const speeds = [
      ...overlapping(1, 150, 0.5, T0),
      ...overlapping(1, 150, 0.5, T0 + 60 * MIN),
      ...overlapping(3, 20, 1.8, T0 + 120 * MIN),
    ];
    const fit = scoreHardwareFit(input({ speeds }));
    expect(fit.usualSessions).toBe(1);
    expect(fit.colour).toBe('green');
  });

  it('gives a group its own colour only from 50 sentences across 2 sessions', () => {
    const speeds = [
      ...overlapping(1, 100, 0.5, T0),
      ...overlapping(1, 100, 0.5, T0 + 60 * MIN),
      ...overlapping(1, 10, 0.5, T0 + 120 * MIN),
      ...overlapping(2, 24, 1.8, T0 + 180 * MIN), // 48 sentences: too few
    ];
    const fit = scoreHardwareFit(input({ speeds }));
    const two = fit.buckets.find(b => b.sessions === 2)!;
    expect(two.sentences).toBe(48);
    expect(two.colour).toBeNull();
    expect(fit.redFrom).toBeNull();
  });

  it('counts sessions that were talking but are not in the speed data', () => {
    // Two sessions of sentences, while a third was active alongside them.
    const speeds = [...overlapping(2, 60, 0.5, T0), ...overlapping(1, 100, 0.5, T0 + 60 * MIN)];
    const activity = [0, 2, 4].map(m => ({ sessionId: 'listener', at: T0 + m * MIN }));
    const fit = scoreHardwareFit(input({ speeds, activity }));
    expect(fit.buckets.map(b => [b.sessions, b.sentences])).toEqual([[1, 100], [2, 0], [3, 120]]);
  });

  describe('where live data is missing, the last load test', () => {
    // Every sentence at 3 sessions at once: groups 1, 2 and 4+ have no live data.
    const live = () => overlapping(3, 80, 0.6);

    it('fills the levels it passed with the measured colour, then red past its limit', () => {
      const fit = scoreHardwareFit(input({
        speeds: live(),
        loadTest: { maxSessions: 4, reachedTopLevel: false, gpuName: 'Tesla T4', ttsProvider: 'qwen3' },
      }));
      expect(fit.buckets.map(b => [b.sessions, b.colour, b.source])).toEqual([
        [1, 'green', 'load test'],
        [2, 'green', 'load test'],
        [3, 'green', 'live'],
        [4, 'green', 'load test'],
        [5, 'red', 'load test'],
      ]);
      expect(fit.greenUpTo).toBe(4);
      expect(fit.redFrom).toBe(5);
      expect(fit.gpu).toBe('Tesla T4');
      expect(fit.ttsModel).toBe('qwen3');
    });

    it('marks nothing red when the test passed its top level', () => {
      const fit = scoreHardwareFit(input({
        speeds: live(),
        loadTest: { maxSessions: 3, reachedTopLevel: true, gpuName: 'L4', ttsProvider: null },
      }));
      expect(fit.buckets).toHaveLength(3);
      expect(fit.redFrom).toBeNull();
    });

    it('never paints red below a level that live data shows working', () => {
      const fit = scoreHardwareFit(input({
        speeds: live(),
        loadTest: { maxSessions: 1, reachedTopLevel: false, gpuName: 'T4', ttsProvider: null },
      }));
      expect(fit.buckets.map(b => [b.sessions, b.colour, b.source])).toEqual([
        [1, 'green', 'load test'],
        [2, null, 'live'],
        [3, 'green', 'live'],
      ]);
      expect(fit.redFrom).toBeNull();
    });

    it('is not used before there is a reading at all', () => {
      const fit = scoreHardwareFit(input({
        speeds: overlapping(1, 20, 0.5),
        loadTest: { maxSessions: 4, reachedTopLevel: false, gpuName: 'T4', ttsProvider: null },
      }));
      expect(fit.colour).toBeNull();
      expect(fit.buckets.every(b => b.source === 'live')).toBe(true);
      expect(fit.gpu).toBe('T4');
    });
  });
});
