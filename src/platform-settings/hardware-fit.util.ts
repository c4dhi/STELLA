/**
 * How well the voice fits this server, under its real concurrent load (#93).
 *
 * Scored from what agents publish per sentence (`tts_sentence_speed`: synthesis
 * time / audio length, the RTF) and the one-off `auto` switch to sentence by
 * sentence (`tts_playback_switch`). Sessions share the GPU, so every sentence is
 * grouped by how many sessions were in conversation when it was spoken, and each
 * group gets its own colour. Thresholds: Felix approved the mockup, 21 Oct 2026.
 */

export type FitColour = 'green' | 'yellow' | 'red';

export const HARDWARE_FIT = {
  windowDays: 14,
  /** No reading at all below this. */
  minSentences: 200,
  minSessions: 3,
  /** A group of sessions-at-once gets its own colour only from here. */
  bucketMinSentences: 50,
  bucketMinSessions: 2,
  /** RTF at the 90th percentile: the slowest 10% of sentences decide. */
  percentile: 90,
  greenRtf: 0.8,
  greenMaxSwitchedShare: 0.05,
  yellowRtf: 1.5,
  /** A session counts as "at once" with any activity this close either side. */
  concurrencyWindowMs: 60_000,
} as const;

export interface SpeedSample {
  sessionId: string;
  at: number;
  rtf: number;
}

export interface SessionMoment {
  sessionId: string;
  at: number;
}

export interface LoadTestSummary {
  maxSessions: number;
  reachedTopLevel: boolean;
  gpuName: string;
  ttsProvider: string | null;
}

export interface HardwareFitInput {
  speeds: SpeedSample[];
  switches: SessionMoment[];
  /** Any other analytics a session published: it was in conversation then. */
  activity: SessionMoment[];
  loadTest: LoadTestSummary | null;
}

export interface HardwareFitBucket {
  sessions: number;
  sentences: number;
  rtfP90: number | null;
  switchedShare: number | null;
  /** null: too little data for a colour. */
  colour: FitColour | null;
  source: 'live' | 'load test';
}

export interface HardwareFit {
  /** The reading at the usual load; null when there is too little data. */
  colour: FitColour | null;
  usualSessions: number | null;
  ttsModel: string | null;
  gpu: string | null;
  windowDays: number;
  /** Highest session count each colour holds for; null = never reached. */
  greenUpTo: number | null;
  yellowUpTo: number | null;
  /** Lowest session count read as red; null = none seen or estimated. */
  redFrom: number | null;
  buckets: HardwareFitBucket[];
  sentencesSeen: number;
  sentencesNeeded: number;
}

const RANK: Record<FitColour, number> = { green: 0, yellow: 1, red: 2 };

export function colourFor(rtfP90: number, switchedShare: number): FitColour {
  if (rtfP90 > HARDWARE_FIT.yellowRtf) return 'red';
  if (rtfP90 <= HARDWARE_FIT.greenRtf && switchedShare < HARDWARE_FIT.greenMaxSwitchedShare) return 'green';
  return 'yellow';
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** First index in an ascending list whose value is >= x. */
function lowerBound(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Sessions in conversation at `at`: those with any activity within the window
 * either side. At least one, since whatever is asking was itself speaking.
 */
export function concurrencyAt(activity: Map<string, number[]>, at: number): number {
  const w = HARDWARE_FIT.concurrencyWindowMs;
  let n = 0;
  for (const times of activity.values()) {
    const i = lowerBound(times, at - w);
    if (i < times.length && times[i] <= at + w) n++;
  }
  return Math.max(1, n);
}

export function scoreHardwareFit(input: HardwareFitInput): HardwareFit {
  const activity = new Map<string, number[]>();
  for (const m of [...input.speeds, ...input.switches, ...input.activity]) {
    const list = activity.get(m.sessionId) ?? [];
    list.push(m.at);
    activity.set(m.sessionId, list);
  }
  for (const list of activity.values()) list.sort((a, b) => a - b);

  type Group = { rtfs: number[]; sessions: Set<string>; switched: Set<string> };
  const groups = new Map<number, Group>();
  const group = (n: number) => {
    if (!groups.has(n)) groups.set(n, { rtfs: [], sessions: new Set(), switched: new Set() });
    return groups.get(n)!;
  };
  const levels: number[] = [];
  for (const s of input.speeds) {
    const n = concurrencyAt(activity, s.at);
    levels.push(n);
    const g = group(n);
    g.rtfs.push(s.rtf);
    g.sessions.add(s.sessionId);
  }
  for (const sw of input.switches) group(concurrencyAt(activity, sw.at)).switched.add(sw.sessionId);

  const speakingSessions = new Set(input.speeds.map(s => s.sessionId));
  const enough =
    input.speeds.length >= HARDWARE_FIT.minSentences && speakingSessions.size >= HARDWARE_FIT.minSessions;

  const maxLive = Math.max(0, ...[...groups.entries()].filter(([, g]) => g.rtfs.length > 0).map(([n]) => n));
  const buckets: HardwareFitBucket[] = [];
  for (let n = 1; n <= maxLive; n++) {
    const g = groups.get(n);
    const sentences = g?.rtfs.length ?? 0;
    if (!g || sentences === 0) {
      buckets.push({ sessions: n, sentences: 0, rtfP90: null, switchedShare: null, colour: null, source: 'live' });
      continue;
    }
    const rtfP90 = percentile(g.rtfs.slice().sort((a, b) => a - b), HARDWARE_FIT.percentile);
    const switchedShare = [...g.switched].filter(id => g.sessions.has(id)).length / g.sessions.size;
    const counts =
      enough && sentences >= HARDWARE_FIT.bucketMinSentences && g.sessions.size >= HARDWARE_FIT.bucketMinSessions;
    buckets.push({
      sessions: n,
      sentences,
      rtfP90,
      switchedShare,
      colour: counts ? colourFor(rtfP90, switchedShare) : null,
      source: 'live',
    });
  }

  let usualSessions: number | null = null;
  let colour: FitColour | null = null;
  if (enough) {
    const sortedLevels = levels.slice().sort((a, b) => a - b);
    usualSessions = sortedLevels[Math.floor((sortedLevels.length - 1) / 2)];
    const usual = buckets[usualSessions - 1];
    if (usual?.colour) {
      colour = usual.colour;
    } else {
      // The usual group alone is too thin: read all sentences together.
      const all = input.speeds.map(s => s.rtf).sort((a, b) => a - b);
      const switched = new Set(input.switches.map(s => s.sessionId).filter(id => speakingSessions.has(id)));
      colour = colourFor(percentile(all, HARDWARE_FIT.percentile), switched.size / speakingSessions.size);
    }
    if (input.loadTest) fillFromLoadTest(buckets, input.loadTest);
  }

  // How far each colour holds: walk up the session counts, never improving.
  let worst: FitColour | null = null;
  let greenUpTo: number | null = null;
  let yellowUpTo: number | null = null;
  let redFrom: number | null = null;
  for (const b of buckets) {
    if (!b.colour) continue;
    if (!worst || RANK[b.colour] > RANK[worst]) worst = b.colour;
    if (worst === 'green') greenUpTo = b.sessions;
    if (worst !== 'red') yellowUpTo = b.sessions;
    else if (redFrom === null) redFrom = b.sessions;
  }

  return {
    colour,
    usualSessions,
    ttsModel: input.loadTest?.ttsProvider ?? null,
    gpu: input.loadTest?.gpuName ?? null,
    windowDays: HARDWARE_FIT.windowDays,
    greenUpTo,
    yellowUpTo,
    redFrom,
    buckets,
    sentencesSeen: input.speeds.length,
    sentencesNeeded: HARDWARE_FIT.minSentences,
  };
}

/**
 * Levels the load test passed take a live group's colour: the nearest one above
 * them (more load is never faster, so a gap takes the worse side), or the
 * highest one, above all of them. One past its limit is red, unless live data
 * already reaches that far. Live colours always win.
 */
function fillFromLoadTest(buckets: HardwareFitBucket[], test: LoadTestSummary): void {
  const live = buckets.filter(b => b.colour);
  if (live.length === 0) return;
  const maxLive = buckets.length;
  const top = Math.max(maxLive, test.maxSessions + (test.reachedTopLevel ? 0 : 1));
  for (let n = 1; n <= top; n++) {
    const existing = buckets[n - 1];
    if (existing?.colour) continue;
    let colour: FitColour | null = null;
    if (n <= test.maxSessions) {
      colour = (live.find(b => b.sessions > n) ?? live[live.length - 1]).colour;
    } else if (n === test.maxSessions + 1 && !test.reachedTopLevel && n > maxLive) {
      colour = 'red';
    }
    const filled: HardwareFitBucket = colour
      ? { sessions: n, sentences: existing?.sentences ?? 0, rtfP90: existing?.rtfP90 ?? null,
          switchedShare: existing?.switchedShare ?? null, colour, source: 'load test' }
      : existing ?? { sessions: n, sentences: 0, rtfP90: null, switchedShare: null, colour: null, source: 'live' };
    buckets[n - 1] = filled;
  }
}
