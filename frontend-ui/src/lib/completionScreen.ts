/**
 * When the participant's "Session complete" screen appears.
 *
 * The agent signals completion right after its last message, often while that
 * message is still being spoken or has only just appeared. The screen waits
 * until the agent has stopped speaking and the message has stopped streaming,
 * then leaves time to read it: about a quarter second per word, at least 3 and
 * at most 10 seconds. A hard cap keeps a stuck speaking state from hiding the
 * screen for good.
 */
export const COMPLETION_READ_MIN_MS = 3000
export const COMPLETION_READ_MAX_MS = 10000
export const COMPLETION_READ_MS_PER_WORD = 250
/** Longest the screen waits after the completion signal, whatever happens. */
export const COMPLETION_SCREEN_CAP_MS = 25000

export function completionReadingTimeMs(lastAgentMessage: string | undefined): number {
  const words = (lastAgentMessage ?? '').trim().split(/\s+/).filter(Boolean).length
  return Math.min(COMPLETION_READ_MAX_MS, Math.max(COMPLETION_READ_MIN_MS, words * COMPLETION_READ_MS_PER_WORD))
}
