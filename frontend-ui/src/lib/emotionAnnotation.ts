/**
 * Re-inserting emotion tags for display (#face-emotions).
 *
 * The agent strips `[tags]` out of its reply before anything sees the text —
 * they must never be spoken and never reach a participant — and publishes the
 * cues alongside as offsets into the STRIPPED text. That is the right default,
 * but it leaves an operator watching the admin board with no way to tell
 * whether the model tagged a reply at all, which is the one question you
 * actually want answered while tuning this.
 *
 * So the admin board puts them back, from the cues. Reconstructing rather than
 * transmitting a second copy of the text is what keeps this honest: the raw
 * reply never goes on the wire, and the only thing participants receive is the
 * cue list they already needed in order to animate the face at all.
 *
 * The catch is the teleprompter. Its word cursor is an offset into the stripped
 * text, so inserting characters ahead of it would slide the highlight out of
 * step with the voice by the combined length of every tag. Hence `mapCursor`:
 * the annotated text is never handed out without the means to move a cursor
 * into its coordinate space.
 */

export interface DisplayCue {
  char: number
  tag: string
}

export interface AnnotatedText {
  /** The reply with `[tag]` markers put back where the model wrote them. */
  text: string
  /** Move an offset from stripped coordinates into annotated ones. */
  mapCursor: (cursor: number) => number
}

/**
 * Put the tags back.
 *
 * Cues are sorted defensively rather than assumed ordered: they arrive off the
 * wire, a later packet replaces an earlier one wholesale, and one out-of-order
 * entry would splice a tag into the middle of a word.
 */
export function annotateWithCues(text: string, cues: DisplayCue[]): AnnotatedText {
  if (!cues || cues.length === 0) {
    return { text, mapCursor: (c) => c }
  }

  const ordered = [...cues].sort((a, b) => a.char - b.char)
  const pieces: string[] = []
  // Parallel arrays of "at this stripped offset, this much has been inserted
  // before it" — everything mapCursor needs, built once here rather than
  // recomputed per frame while the cursor sweeps.
  const boundaries: number[] = []
  const shifts: number[] = []

  let read = 0
  let inserted = 0
  for (const cue of ordered) {
    // A cue past the end (or before the start) of the text it indexes means the
    // two halves disagreed about the reply. Clamping keeps the text intact and
    // the tag visible rather than dropping either.
    const at = Math.max(0, Math.min(text.length, cue.char))
    if (at > read) {
      pieces.push(text.slice(read, at))
      read = at
    }
    const marker = `[${cue.tag}]`
    pieces.push(marker)
    inserted += marker.length
    boundaries.push(at)
    shifts.push(inserted)
  }
  pieces.push(text.slice(read))

  const mapCursor = (cursor: number): number => {
    // Everything inserted at an offset at or before the cursor sits behind it.
    // A tag sitting exactly ON the cursor counts: it was written before the
    // word it belongs to, so the highlight should not stop short of it.
    let shift = 0
    for (let i = 0; i < boundaries.length; i++) {
      if (boundaries[i] > cursor) break
      shift = shifts[i]
    }
    return cursor + shift
  }

  return { text: pieces.join(''), mapCursor }
}
