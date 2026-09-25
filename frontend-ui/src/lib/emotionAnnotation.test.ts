/**
 * Putting emotion tags back for the admin board (#face-emotions).
 *
 * The offsets index the STRIPPED text, so every case here is really about one
 * thing: whether the reconstruction and the teleprompter cursor still agree
 * about where in the sentence we are.
 */
import { describe, it, expect } from 'vitest'
import { annotateWithCues } from './emotionAnnotation'

describe('annotateWithCues', () => {
  it('leaves an untagged reply exactly as it was', () => {
    const { text, mapCursor } = annotateWithCues('Hello there.', [])
    expect(text).toBe('Hello there.')
    expect(mapCursor(5)).toBe(5)
  })

  it('puts each tag back where the model wrote it', () => {
    const { text } = annotateWithCues('Hi there. Good to see you.', [
      { char: 0, tag: 'happy' },
      { char: 10, tag: 'nod' },
    ])
    expect(text).toBe('[happy]Hi there. [nod]Good to see you.')
  })

  it('round-trips: stripping the markers again gives the original', () => {
    const original = 'Hi there. Good to see you.'
    const { text } = annotateWithCues(original, [
      { char: 0, tag: 'happy' },
      { char: 10, tag: 'nod' },
      { char: 26, tag: 'neutral' },
    ])
    expect(text.replace(/\[[a-z_]+\]/g, '')).toBe(original)
  })

  it('keeps the highlight on the same word it was on', () => {
    // The whole reason mapCursor exists. Without it the highlight lags by the
    // combined length of every tag ahead of the cursor, which on a tagged reply
    // is most of a word.
    const original = 'Hi there. Good to see you.'
    const cues = [
      { char: 0, tag: 'happy' },
      { char: 10, tag: 'nod' },
    ]
    const { text, mapCursor } = annotateWithCues(original, cues)
    for (let cursor = 0; cursor <= original.length; cursor++) {
      const spokenPlain = original.slice(0, cursor)
      const spokenAnnotated = text.slice(0, mapCursor(cursor)).replace(/\[[a-z_]+\]/g, '')
      expect(spokenAnnotated).toBe(spokenPlain)
    }
  })

  it('counts a tag sitting exactly on the cursor as already behind it', () => {
    // A tag is written BEFORE the words it belongs to, so a highlight that has
    // reached that word must have passed the tag — otherwise the marker sits
    // un-highlighted in the middle of a lit sentence.
    const { mapCursor } = annotateWithCues('Hi there.', [{ char: 0, tag: 'happy' }])
    expect(mapCursor(0)).toBe('[happy]'.length)
  })

  it('sorts cues rather than trusting their order', () => {
    // They come off the wire, and one out-of-order entry would splice a tag
    // into the middle of a word.
    const { text } = annotateWithCues('Hi there. Good to see you.', [
      { char: 10, tag: 'nod' },
      { char: 0, tag: 'happy' },
    ])
    expect(text).toBe('[happy]Hi there. [nod]Good to see you.')
  })

  it('survives a cue that points past the end of the text', () => {
    // The agent and the client deploy separately; a disagreement about the
    // reply must not corrupt the reply.
    const { text } = annotateWithCues('Hi.', [{ char: 99, tag: 'neutral' }])
    expect(text).toBe('Hi.[neutral]')
  })

  it('places two cues at the same offset without losing either', () => {
    const { text } = annotateWithCues('Hi there.', [
      { char: 0, tag: 'happy' },
      { char: 0, tag: 'brow_flash' },
    ])
    expect(text.replace(/\[[a-z_]+\]/g, '')).toBe('Hi there.')
    expect(text).toContain('[happy]')
    expect(text).toContain('[brow_flash]')
  })
})
