/**
 * The sleep machine (#face-sleep).
 *
 * Pure for the same reason `stepBusy` is: every input is internal and the only
 * visible output is a face holding still, which looks the same whether she is
 * asleep, gaze-locked, or wedged. The failure that matters here is not a wrong
 * animation — it is a face that goes dark on someone and never comes back.
 */
import { describe, it, expect } from 'vitest'
import {
  stepSleep,
  initialSleepState,
  isYawningAt,
  SLEEP_AFTER_MS,
  WAKE_MS,
  YAWN_FRACTION,
  type SleepInput,
  type SleepState,
} from './useSleepState'

const T0 = 1_000_000

const input = (over: Partial<SleepInput> = {}): SleepInput => ({
  isPresent: false,
  isBusy: false,
  cameraActive: true,
  wakeRequested: false,
  sleepRequested: false,
  force: false,
  sleepAfterMs: SLEEP_AFTER_MS,
  ...over,
})

/** Run the machine forward, stepping every `stepMs`. */
const run = (state: SleepState, over: Partial<SleepInput>, forMs: number, stepMs = 200) => {
  let s = state
  for (let t = stepMs; t <= forMs; t += stepMs) s = stepSleep(s, input(over), T0 + t)
  return s
}

describe('falling asleep', () => {
  it('nods off once nobody has been visible for the timeout', () => {
    const s = run(initialSleepState(T0), {}, SLEEP_AFTER_MS + 400)
    expect(s.phase).toBe('asleep')
  })

  it('stays awake as long as someone is in front of the camera', () => {
    const s = run(initialSleepState(T0), { isPresent: true }, SLEEP_AFTER_MS * 3)
    expect(s.phase).toBe('awake')
  })

  it('does not doze off mid-conversation just because the camera lost the face', () => {
    // Bad light, an off-angle head, a hand over the lens — detection drops all
    // the time, and going to sleep on someone who is actively talking is the
    // single worst thing this feature could do.
    const s = run(initialSleepState(T0), { isPresent: false, isBusy: true }, SLEEP_AFTER_MS * 2)
    expect(s.phase).toBe('awake')
  })

  it('never sleeps when there is no working camera', () => {
    // Otherwise every machine without webcam permission gets a face that dies
    // 30 seconds after load, and those users have no idea a tap revives it.
    const s = run(initialSleepState(T0), { cameraActive: false }, SLEEP_AFTER_MS * 4)
    expect(s.phase).toBe('awake')
  })

  it('gives a returning camera a full countdown rather than a stale one', () => {
    // The bug this rules out: treat the camera as a guard on the TRANSITION and
    // the timer keeps running while the camera is off, so the moment it comes
    // back it finds a minute-old timestamp and sleeps on the spot.
    const dark = run(initialSleepState(T0), { cameraActive: false }, SLEEP_AFTER_MS * 2)
    const back = stepSleep(dark, input(), T0 + SLEEP_AFTER_MS * 2 + 200)
    expect(back.phase).toBe('awake')

    // ...and then sleeps normally once the timeout has actually elapsed.
    let s = back
    for (let t = 400; t <= SLEEP_AFTER_MS + 400; t += 200) {
      s = stepSleep(s, input(), T0 + SLEEP_AFTER_MS * 2 + t)
    }
    expect(s.phase).toBe('asleep')
  })

  it('honours a shortened timeout, so the preview can be iterated on', () => {
    const s = run(initialSleepState(T0), { sleepAfterMs: 3000 }, 3400)
    expect(s.phase).toBe('asleep')
  })

  it('ignores presence and the camera under force', () => {
    const s = run(
      initialSleepState(T0),
      { force: true, isPresent: true, cameraActive: false, sleepAfterMs: 3000 },
      3400
    )
    expect(s.phase).toBe('asleep')
  })
})

describe('a commanded sleep — the agent\'s [sleep] tag (#face-sleep)', () => {
  it('goes under at once rather than waiting out the countdown', () => {
    // "Go to sleep" means now. Falling back on the 30s idle timer would leave
    // her awake and staring for half a minute after being told to rest.
    const s = stepSleep(initialSleepState(T0), input({ sleepRequested: true }), T0 + 200)
    expect(s.phase).toBe('asleep')
  })

  it('ignores someone standing right in front of the camera', () => {
    // Presence is what BLOCKS the idle timer, and it must not block this: being
    // asked to sleep by the person watching is the normal case, not a conflict.
    const s = stepSleep(
      initialSleepState(T0),
      input({ sleepRequested: true, isPresent: true }),
      T0 + 200
    )
    expect(s.phase).toBe('asleep')
  })

  it('survives being asked while she is still waking up', () => {
    // A request that arrives mid-wake has to keep until she can act on it. The
    // first version cleared the latch on every phase that was not 'awake',
    // which included 'waking' — so being asked to sleep just after being woken
    // did nothing at all, and no log anywhere would have said so.
    const woke: SleepState = { phase: 'waking', lastPresenceAt: T0, wakingSince: T0 }
    const mid = stepSleep(woke, input({ sleepRequested: true }), T0 + 200)
    expect(mid.phase).toBe('waking')
    const done = stepSleep(mid, input({ sleepRequested: true }), T0 + WAKE_MS)
    expect(done.phase).toBe('awake')
    expect(stepSleep(done, input({ sleepRequested: true }), T0 + WAKE_MS + 200).phase).toBe(
      'asleep'
    )
  })

  it('waits for her own voice to finish first', () => {
    // The tag sits at the END of the reply, so the cursor reaches it while she
    // is still speaking. Acting immediately would shut her eyes mid-goodbye.
    const speaking = stepSleep(
      initialSleepState(T0),
      input({ sleepRequested: true, isBusy: true }),
      T0 + 200
    )
    expect(speaking.phase).toBe('awake')

    const quiet = stepSleep(speaking, input({ sleepRequested: true }), T0 + 400)
    expect(quiet.phase).toBe('asleep')
  })
})

describe('waking', () => {
  const asleep = (): SleepState => run(initialSleepState(T0), {}, SLEEP_AFTER_MS + 400)

  it('wakes on a tap', () => {
    const s = stepSleep(asleep(), input({ wakeRequested: true }), T0 + 60_000)
    expect(s.phase).toBe('waking')
  })

  it('wakes on speech, because talking with the eyes shut is worse than never sleeping', () => {
    const s = stepSleep(asleep(), input({ isBusy: true }), T0 + 60_000)
    expect(s.phase).toBe('waking')
  })

  it('cannot wake on detection — the camera is off, which is why touch exists', () => {
    // Not an oversight being pinned: it is the reason the whole wake path is
    // built around a tap. If this ever starts passing, the camera is still on
    // while she is "asleep" and the feature is not doing its job.
    const s = stepSleep(asleep(), input({ isPresent: true }), T0 + 60_000)
    expect(s.phase).toBe('asleep')
  })

  it('holds the wake for its full duration, whatever the inputs do', () => {
    // The animation is covering the camera restart. Cutting it short on a stray
    // detection is exactly the blank stare it exists to prevent.
    const woke = stepSleep(asleep(), input({ wakeRequested: true }), T0 + 60_000)
    const mid = stepSleep(woke, input({ isPresent: true }), T0 + 60_000 + WAKE_MS - 100)
    expect(mid.phase).toBe('waking')
    const done = stepSleep(mid, input({ isPresent: true }), T0 + 60_000 + WAKE_MS)
    expect(done.phase).toBe('awake')
  })

  it('grants a fresh countdown after waking rather than inheriting the old one', () => {
    const woke = stepSleep(asleep(), input({ wakeRequested: true }), T0 + 60_000)
    const done = stepSleep(woke, input(), T0 + 60_000 + WAKE_MS)
    expect(done.phase).toBe('awake')
    // Nearly a full timeout later she is still up; only past it does she sleep.
    const nearly = run(done, {}, SLEEP_AFTER_MS - 1000)
    expect(nearly.phase).toBe('awake')
  })

  it('closes the mouth before the eyes come open', () => {
    // A wide-eyed face with a hanging jaw reads as shock, not as waking up.
    const woke = stepSleep(asleep(), input({ wakeRequested: true }), T0 + 60_000)
    expect(isYawningAt(woke, T0 + 60_000)).toBe(true)
    expect(isYawningAt(woke, T0 + 60_000 + WAKE_MS * YAWN_FRACTION + 1)).toBe(false)
  })
})
