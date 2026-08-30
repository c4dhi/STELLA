/**
 * useTeleprompter (#241)
 *
 * The single, transport-agnostic source of truth for the word-by-word speech
 * highlight ("teleprompter"). It owns a wall-clock segment schedule and a
 * requestAnimationFrame loop that derive a character cursor from the audio
 * playhead, so words light up in time with what the user actually hears.
 *
 * Both surfaces use this same hook so they behave identically:
 *   - the organizer session chat (ChatView), and
 *   - the participant chat (ParticipantSessionView / ParticipantChatPanel).
 *
 * Each screen only differs in how it feeds events in (different transports):
 *   - call {@link Teleprompter.applyProgress} for every `agent_speech_progress`
 *     envelope, and
 *   - call {@link Teleprompter.noteAgentText} for every `agent_text` update,
 * then render with {@link Teleprompter.spokenChar} / `spokenTranscriptId` /
 * `frozenSpoken` (see `SpokenMessageText`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSpeechProgress, AgentEmotionCue } from '../lib/types'

export type { AgentSpeechProgress, AgentEmotionCue }

// The speech-progress data event reaches the client ahead of the audio it
// describes (the audio waits in the browser's jitter buffer before it is
// heard). Delay the word cursor by this much so the highlight lands with the
// sound rather than racing it.
//
// This constant IS the highlight's trail: simulating this scheduler against
// real SDK envelopes, the median lag behind the voice tracks it almost exactly
// (150 -> 150ms, 60 -> 64ms, 0 -> 7ms), because everything else — segment
// tiling and the SDK's own delay_ms — is already calibrated. It was 150ms,
// which read as visibly trailing.
//
// It cannot go to zero: the simulation models the server-side output source
// draining, but not the browser's own jitter buffer, so 0 would let the
// highlight lead the voice — and reading words before they are spoken is far
// worse than reading them slightly late. 60ms keeps a margin.
const TELEPROMPTER_CLIENT_LAG_MS = 60

// How far the chained schedule may run ahead of the SDK's own estimate of when
// the playhead becomes audible before we stop chaining and rebase onto it.
//
// Segments are chained so they never overlap, which means a segment that ends
// slightly late pushes every later one late too. Over a long reply — now made
// of many short progress ticks rather than one segment per sentence — that
// slop would accumulate and the highlight would drift permanently behind the
// voice. The SDK's `delay_ms` is a fresh measurement of the output queue on
// every tick, so a large disagreement means the chain has drifted, not that the
// SDK has buffered ahead. Generous enough to leave genuine lookahead alone.
const TELEPROMPTER_REBASE_TOLERANCE_MS = 600

/** A span of speech scheduled on the wall clock (performance.now() ms). */
interface Segment {
  charStart: number
  charEnd: number
  startAt: number
  endAt: number
}

/**
 * Where a progress tick lands on the timeline.
 *
 * Pure so the arithmetic — the part that decides whether the highlight reads as
 * in sync — is testable without a DOM or an animation frame.
 *
 * `rebase` means the chained schedule had drifted more than the tolerance ahead
 * of the SDK's fresh `delay_ms`, so the caller must drop not-yet-started
 * segments and restart from `startAt` instead of continuing the chain.
 */
export function planSegment(input: {
  now: number
  delayMs: number
  durationMs: number
  scheduledUntil: number
}): { startAt: number; endAt: number; rebase: boolean } {
  const { now, delayMs, durationMs, scheduledUntil } = input
  // When this tick's audio becomes audible: now + the SDK's buffered lead + the
  // client jitter-buffer lag.
  const audibleAt = now + delayMs + TELEPROMPTER_CLIENT_LAG_MS
  const rebase = scheduledUntil - audibleAt > TELEPROMPTER_REBASE_TOLERANCE_MS
  // Normally chain onto the previous segment so segments never overlap; on
  // drift, trust the fresh measurement instead.
  const startAt = rebase ? audibleAt : Math.max(audibleAt, scheduledUntil)
  return { startAt, endAt: startAt + Math.max(1, durationMs), rebase }
}

/**
 * Which expression the face should be wearing at ``cursor`` (#face-emotions).
 *
 * Last expression cue at or before the cursor wins, which is exactly the
 * "holds until the next tag" rule. Null before the first one, so a reply that
 * opens without a tag starts from rest rather than inheriting the last turn's
 * mood.
 *
 * Pure for the same reason planSegment is: this decides what the user sees, and
 * it is far easier to state as a table of cursor positions than to observe on a
 * running face.
 */
/**
 * How long after the agent's scheduled audio runs out before the face relaxes,
 * and how often that is checked.
 *
 * Generous on purpose. Nothing is waiting on this: the expression is correct
 * right up until it fires, and firing late costs a held expression for another
 * fraction of a second. Firing EARLY costs a face that goes blank mid-reply,
 * so the asymmetry is all in one direction.
 */
const EXPRESSION_HOLD_MS = 900
const EXPRESSION_POLL_MS = 200

export function activeExpressionAt(
  cues: AgentEmotionCue[],
  cursor: number
): string | null {
  let active: string | null = null
  for (const cue of cues) {
    if (cue.kind !== 'expression') continue
    if (cue.char > cursor) break // cues are ordered; nothing later can apply
    active = cue.tag
  }
  return active
}

/**
 * Gesture cues the cursor has just passed over, in order.
 *
 * Half-open ``(from, to]`` so each gesture fires exactly once as the cursor
 * sweeps: a frame boundary landing on a cue must not replay it, and a cue at
 * offset 0 must still fire on the first frame (call with ``from = -1``).
 */
export function gesturesCrossed(
  cues: AgentEmotionCue[],
  from: number,
  to: number
): string[] {
  return crossed(cues, 'gesture', from, to)
}

/**
 * State cues the cursor has just passed over (#face-sleep).
 *
 * Same half-open sweep as a gesture, because the timing requirement is the
 * same: fire once, on the word it was written under. What differs is entirely
 * downstream — a gesture plays and hands the face back, a state changes it and
 * leaves it changed.
 */
export function statesCrossed(
  cues: AgentEmotionCue[],
  from: number,
  to: number
): string[] {
  return crossed(cues, 'state', from, to)
}

function crossed(
  cues: AgentEmotionCue[],
  kind: string,
  from: number,
  to: number
): string[] {
  if (to <= from) return []
  return cues
    .filter(c => c.kind === kind && c.char > from && c.char <= to)
    .map(c => c.tag)
}

export interface Teleprompter {
  /** Absolute char offset spoken so far; drives the highlight. */
  spokenChar: number
  /** Transcript currently being spoken — its bubble gets the live highlight. */
  spokenTranscriptId: string
  /** Transcripts frozen by a committed barge-in → keep a partial highlight. */
  frozenSpoken: Record<string, number>
  /** Full text of the transcript currently being spoken (dim backdrop for overlays). */
  spokenText: string
  /** Apply an `agent_speech_progress` envelope. */
  applyProgress: (data: AgentSpeechProgress) => void
  /** Record the latest `agent_text` for a transcript (binds + dims ahead of voice). */
  noteAgentText: (transcriptId: string, text: string) => void
  /** Record the emotion cues for a transcript (#face-emotions). Full list each time. */
  noteEmotionCues: (transcriptId: string, cues: AgentEmotionCue[]) => void
  /** Expression the cursor has reached; holds until the next cue or turn end. */
  faceExpression: string | null
  /** One-shot gesture the cursor just crossed. The seq re-fires a repeated tag. */
  faceGesture: { tag: string; seq: number } | null
  /**
   * State command the cursor just crossed (#face-sleep).
   *
   * Deliberately NOT cleared by `resetCues` the way an expression is: a state
   * outlives the reply that asked for it, which is the entire difference
   * between the two. The seq is what makes it fire, so a stale value sitting
   * here after the turn ends does nothing.
   */
  faceState: { tag: string; seq: number } | null
  /**
   * Emotion cues per transcript, for surfaces that DISPLAY them (#face-emotions).
   *
   * Only the admin board uses this. Participant-facing text stays stripped —
   * the tags are stage directions for the face, and narrating them at a
   * participant is the failure the whole stripping mechanism exists to prevent.
   */
  cuesByTranscript: Record<string, AgentEmotionCue[]>
  /**
   * Drop the visible spoken backdrop so a finished/interrupted agent turn stops
   * lingering on screen (e.g. once the user has finalized their reply). The
   * transcript binding and any frozen highlight are left intact, so a genuine
   * barge-in that the agent resumes is restored unchanged by {@link applyProgress}.
   */
  clearSpoken: () => void
}

export function useTeleprompter(): Teleprompter {
  const [spokenChar, setSpokenChar] = useState(0)
  const [spokenTranscriptId, setSpokenTranscriptId] = useState('')
  const [frozenSpoken, setFrozenSpoken] = useState<Record<string, number>>({})
  const [spokenText, setSpokenText] = useState('')
  // Emotion tags (#face-emotions). Cues arrive on their own envelope and are
  // resolved against the SAME cursor that drives the word highlight, so the
  // face changes on the word the tag was written before — not when the packet
  // happened to arrive.
  const [faceExpression, setFaceExpression] = useState<string | null>(null)
  const [faceGesture, setFaceGesture] = useState<{ tag: string; seq: number } | null>(null)
  const [faceState, setFaceState] = useState<{ tag: string; seq: number } | null>(null)
  const cuesByTranscriptRef = useRef<Map<string, AgentEmotionCue[]>>(new Map())
  // The same cues as state, for rendering rather than for the cursor loop. The
  // ref is read every frame and must not cause renders; this changes a handful
  // of times a turn and is only read by the admin board.
  const [cuesByTranscript, setCuesByTranscript] = useState<Record<string, AgentEmotionCue[]>>({})
  // Cursor position the cues were last resolved at. -1, not 0, so a cue sitting
  // at offset 0 still fires on the first frame.
  const cueCursorRef = useRef(-1)
  const expressionRef = useRef<string | null>(null)

  // The SDK pushes audio ahead of actual playout, so speech-progress events
  // arrive earlier than the audio is heard — sometimes a whole sentence at
  // once. Rather than apply them immediately, we SCHEDULE each spoken sentence
  // as a segment on a wall-clock timeline ([startAt, endAt) in performance.now()
  // ms), chained so segments never overlap. A single rAF derives the cursor
  // from the clock, so it tracks the audio the user hears.
  const segmentsRef = useRef<Segment[]>([])
  const scheduledUntilRef = useRef(0) // wall-clock ms the schedule reaches
  const frozenRef = useRef(false) // barge-in froze the cursor; hold position
  const rafRef = useRef<number | null>(null)
  // Flips true the first time a progress envelope arrives (teleprompter live
  // this session). Until then agent bubbles render normally, so a TTS-off
  // session is never left permanently dimmed.
  const activeRef = useRef(false)
  // The transcript the cursor is currently bound to — the single source of
  // truth for "which turn are we on". Both event feeds funnel new-turn
  // detection through beginTranscript() keyed on this, so the faster agent_text
  // stream can never reset a turn whose highlight is already advancing.
  const transcriptIdRef = useRef('')
  const textByTranscriptRef = useRef<Map<string, string>>(new Map())
  const prefersReducedMotionRef = useRef(
    typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  )

  // Advance the emotion cues to `cursor`: adopt the expression in force there,
  // and fire any gesture the cursor has just swept past. Called from the frame
  // loop and from every path that moves the cursor without one (reduced motion,
  // and a TTS-off session where there is no audio to track).
  const syncCues = useCallback((cursor: number) => {
    const cues = cuesByTranscriptRef.current.get(transcriptIdRef.current)
    if (!cues || cues.length === 0) return
    const previous = cueCursorRef.current
    if (cursor <= previous) return
    cueCursorRef.current = cursor

    const expression = activeExpressionAt(cues, cursor)
    if (expression !== expressionRef.current) {
      expressionRef.current = expression
      setFaceExpression(expression)
    }
    for (const tag of gesturesCrossed(cues, previous, cursor)) {
      setFaceGesture(prev => ({ tag, seq: (prev?.seq ?? 0) + 1 }))
    }
    for (const tag of statesCrossed(cues, previous, cursor)) {
      setFaceState(prev => ({ tag, seq: (prev?.seq ?? 0) + 1 }))
    }
  }, [])

  // Rewind the cue cursor for a new turn. Position only — this says nothing
  // about what the face is currently doing.
  const rewindCues = useCallback(() => {
    cueCursorRef.current = -1
  }, [])

  /**
   * Let the current expression fall back to rest, WITHOUT moving the cursor.
   *
   * Separate from a full reset because rewinding the cursor would let every
   * gesture in the reply fire a second time as it swept forward again.
   */
  const relaxExpression = useCallback(() => {
    if (expressionRef.current !== null) {
      expressionRef.current = null
      setFaceExpression(null)
    }
  }, [])

  /**
   * End the current expression and rewind, for a turn that is over outright.
   *
   * An expression ends on exactly three things: the next expression cue, a
   * committed barge-in, and the agent finishing what it was saying. The first
   * is `activeExpressionAt`; the last is the watchdog below.
   *
   * A NEW MESSAGE APPEARING is deliberately not on that list. It used to be,
   * and it is a different moment from the previous reply ending: the face held
   * its last expression through the silence and through the user's whole turn,
   * and only snapped back when the agent next opened its mouth.
   */
  const resetCues = useCallback(() => {
    rewindCues()
    relaxExpression()
  }, [rewindCues, relaxExpression])

  // Word-cursor loop: derive the lit char offset from the scheduled segments
  // against the wall clock. Held when frozen; self-cancels once the last
  // segment has finished.
  const tick = useCallback(() => {
    if (frozenRef.current) {
      rafRef.current = null
      return
    }
    const segs = segmentsRef.current
    if (segs.length === 0) {
      rafRef.current = null
      return
    }
    const now = performance.now()
    let cursor = segs[0].charStart
    for (const s of segs) {
      if (now >= s.endAt) {
        cursor = s.charEnd // segment fully spoken
      } else if (now >= s.startAt) {
        cursor = s.charStart + ((now - s.startAt) / (s.endAt - s.startAt)) * (s.charEnd - s.charStart)
        break
      } else {
        break // future segment — hold at the previous segment's end
      }
    }
    setSpokenChar(cursor)
    syncCues(cursor)

    const last = segs[segs.length - 1]
    rafRef.current = now < last.endAt ? requestAnimationFrame(tick) : null
  }, [syncCues])

  const ensureLoop = useCallback(() => {
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(tick)
    }
  }, [tick])

  // Reset the schedule (new turn, or a fresh dimmed block after interruption).
  const resetSchedule = useCallback(() => {
    segmentsRef.current = []
    scheduledUntilRef.current = 0
    frozenRef.current = false
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const clearFrozen = useCallback((transcriptId: string) => {
    setFrozenSpoken(prev => {
      if (prev[transcriptId] == null) return prev
      const next = { ...prev }
      delete next[transcriptId]
      return next
    })
  }, [])

  // Bind the highlight to a transcript, resetting the schedule for a fresh turn.
  // The ONLY place a turn boundary resets the cursor, and idempotent per
  // transcript id: a second call for the turn in progress is a no-op. That lets
  // both event feeds call it freely without clobbering an advancing highlight.
  const beginTranscript = useCallback(
    (transcriptId: string) => {
      if (!transcriptId || transcriptIdRef.current === transcriptId) return
      transcriptIdRef.current = transcriptId
      resetSchedule()
      // Position only — the previous reply ended its own expression when the
      // agent stopped speaking (see the watchdog below).
      //
      // The exception is a session with TTS off. There is no audio, so there is
      // no moment at which the agent "finishes speaking" and the watchdog never
      // runs; a new message really is the only boundary that exists in that
      // mode, so there it goes back to being the one that resets.
      rewindCues()
      if (!activeRef.current) relaxExpression()
      setSpokenTranscriptId(transcriptId)
      setSpokenChar(0)
      setSpokenText(textByTranscriptRef.current.get(transcriptId) ?? '')
    },
    [resetSchedule, rewindCues, relaxExpression]
  )

  const noteAgentText = useCallback(
    (transcriptId: string, text: string) => {
      if (!transcriptId) return
      textByTranscriptRef.current.set(transcriptId, text)
      // Once live, bind each new reply on its first chunk so it renders dimmed
      // ahead of the voice and lights up as the audio catches up.
      if (!activeRef.current) {
        // No audio this session — see noteEmotionCues.
        if (transcriptId === transcriptIdRef.current) syncCues(text.length)
        return
      }
      beginTranscript(transcriptId)
      setSpokenText(text)
    },
    [beginTranscript, syncCues]
  )

  const noteEmotionCues = useCallback(
    (transcriptId: string, cues: AgentEmotionCue[]) => {
      if (!transcriptId) return
      // The envelope carries the full list for its transcript, so replacing is
      // always right and a dropped packet heals on the next one.
      const ordered = [...cues].sort((a, b) => a.char - b.char)
      cuesByTranscriptRef.current.set(transcriptId, ordered)
      setCuesByTranscript(prev => ({ ...prev, [transcriptId]: ordered }))
      // With TTS off there is no audio to track and no cursor will ever move,
      // so nothing past offset 0 would ever fire. Fall back to the text itself:
      // published text IS the progress in that mode.
      if (!activeRef.current && transcriptId === transcriptIdRef.current) {
        const text = textByTranscriptRef.current.get(transcriptId)
        if (text) syncCues(text.length)
      }
    },
    [syncCues]
  )

  const applyProgress = useCallback(
    (data: AgentSpeechProgress) => {
      const transcriptId = data.transcript_id || ''
      const charEnd = data.char_end ?? 0
      // How far THIS segment runs. Mid-sentence ticks stop short of the
      // sentence end because the rest is not synthesized yet; falling back to
      // charEnd keeps older SDKs working (they only ever send whole sentences).
      const target = data.target_char ?? charEnd
      const spoken = data.spoken_char ?? 0
      const state = data.state || 'speaking'

      // The teleprompter is live this session — agent bubbles may dim/highlight.
      activeRef.current = true
      // Bind this turn (no-op if already bound). Normally agent_text begins it
      // first; this is the fallback if a progress event is seen before any text.
      beginTranscript(transcriptId)
      const full = textByTranscriptRef.current.get(transcriptId)
      if (full != null) setSpokenText(full)

      if (state === 'speaking') {
        clearFrozen(transcriptId)
        // Resuming after a rejected (unuseful) barge-in: the cursor was frozen
        // at the playhead by the preceding 'interrupted'. Unfreeze so it
        // continues on the SAME message from where it stopped, over the
        // remaining audio. Harmless for a fresh sentence (already unfrozen).
        frozenRef.current = false
        if (prefersReducedMotionRef.current) {
          setSpokenChar(target) // no animation — step straight to this tick's target
          syncCues(target)
          return
        }
        const now = performance.now()
        const { startAt, endAt, rebase } = planSegment({
          now,
          delayMs: data.delay_ms ?? 0,
          durationMs: data.duration_ms ?? 0,
          scheduledUntil: scheduledUntilRef.current,
        })
        if (rebase) segmentsRef.current = segmentsRef.current.filter(s => s.startAt <= now)
        segmentsRef.current.push({ charStart: spoken, charEnd: target, startAt, endAt })
        scheduledUntilRef.current = endAt
        ensureLoop()
      } else if (state === 'spoken') {
        // The schedule normally carries the cursor to the end on its own.
        clearFrozen(transcriptId)
        // Safety net. A sentence the SDK reports as fully spoken must end fully
        // lit — if the schedule falls even slightly short, the bubble sits
        // permanently half-highlighted, which is how a scheduling bug shows up
        // to a reader. Extending the last segment's target costs nothing when
        // the schedule was already correct (it is a no-op) and converts any
        // future arithmetic error into slight timing imprecision instead of a
        // stuck highlight.
        const last = segmentsRef.current[segmentsRef.current.length - 1]
        if (last && last.charEnd < charEnd) {
          last.charEnd = charEnd
          ensureLoop()
        }
      } else if (state === 'interrupted') {
        // Freeze exactly where the audio stopped, drop pending segments, and
        // remember the point so the bubble keeps its partial highlight.
        resetSchedule()
        // A committed barge-in ends the message, so the expression it was
        // wearing ends with it rather than outliving the turn.
        resetCues()
        frozenRef.current = true
        setSpokenChar(spoken)
        setFrozenSpoken(prev => ({ ...prev, [transcriptId]: spoken }))
      }
    },
    [beginTranscript, clearFrozen, ensureLoop, resetSchedule, resetCues, syncCues]
  )

  /**
   * End the expression once the agent has actually stopped talking.
   *
   * ── Why the audio SCHEDULE and not `isRemoteSpeaking` ──────────────────────
   *
   * The obvious signal is "no agent sound is playing", but the flag that says
   * so is an RMS threshold tuned to drive the mouth, and it dips below the line
   * between syllables — several times a sentence. Debouncing it enough to
   * survive that starts to approach the length of a real gap between sentences,
   * and a debounce that short would relax the face in the middle of a reply.
   *
   * `scheduledUntil` has neither problem. It is the wall-clock time the audio
   * scheduled so far runs to, and it extends every time another sentence is
   * scheduled — so throughout a reply it sits in the FUTURE, syllable gaps and
   * all, and only falls behind the clock once the agent has genuinely run out
   * of things to say.
   *
   * The hold on top is not a debounce, then, but a deliberate beat: a face that
   * drops its expression on the exact final syllable reads as a switch being
   * flipped. Holding it a moment and then letting it relax is what a person
   * does.
   *
   * Guarded on `activeRef` because with TTS off nothing is ever scheduled, so
   * `scheduledUntil` is permanently in the past and this would fire the instant
   * an expression was adopted. That mode resets on the next message instead —
   * see beginTranscript.
   */
  useEffect(() => {
    if (faceExpression === null) return
    const id = setInterval(() => {
      if (!activeRef.current || frozenRef.current) return
      if (performance.now() > scheduledUntilRef.current + EXPRESSION_HOLD_MS) {
        relaxExpression()
      }
    }, EXPRESSION_POLL_MS)
    return () => clearInterval(id)
  }, [faceExpression, relaxExpression])

  // Clear the dim backdrop without disturbing the turn binding or frozen
  // highlight. Called when the heard turn is over and its text must not linger
  // (a finalized user message awaiting the next agent reply). Deliberately a
  // no-op while the agent is actively speaking (live cursor, not frozen) so we
  // never blank a sentence mid-flight; a frozen barge-in IS cleared, and if the
  // agent resumes that same message applyProgress restores spokenText from
  // textByTranscriptRef, so the interrupted → resume path is preserved.
  const clearSpoken = useCallback(() => {
    if (rafRef.current != null && !frozenRef.current) return
    setSpokenText('')
  }, [])

  // Cancel any pending animation frame on unmount.
  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    },
    []
  )

  return {
    spokenChar,
    spokenTranscriptId,
    frozenSpoken,
    spokenText,
    applyProgress,
    noteAgentText,
    noteEmotionCues,
    faceExpression,
    faceGesture,
    faceState,
    cuesByTranscript,
    clearSpoken,
  }
}
