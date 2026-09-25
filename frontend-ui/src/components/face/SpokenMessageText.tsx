/**
 * SpokenMessageText (#241)
 *
 * Renders a chat message's text, applying the word-by-word teleprompter
 * highlight when this message is the one currently being spoken (or one that a
 * barge-in froze mid-way). Shared by the organizer chat (`MessageBubble`) and
 * the participant chat (`ParticipantChatPanel`) so both surfaces highlight
 * identically. Non-agent messages and inactive bubbles render as plain text.
 *
 * `cues` is what separates the two surfaces (#face-emotions): pass it and the
 * emotion tags are put back into the text for display, which the admin board
 * wants and participant-facing surfaces must never do. The cursor is mapped
 * into the annotated text's coordinates along with it — the offsets index the
 * stripped reply, so a highlight left unmapped would trail the voice by the
 * combined length of every tag ahead of it.
 */
import React, { useMemo } from 'react'
import SpokenText from './SpokenText'
import { annotateWithCues, type DisplayCue } from '../../lib/emotionAnnotation'

interface SpokenMessageTextProps {
  text: string
  /** This message's id (matched against the active/frozen transcript). */
  messageId: string
  /** Only agent/assistant messages receive the spoken highlight. */
  isAgent: boolean
  /** Live cursor + bindings from `useTeleprompter`. */
  spokenChar?: number
  spokenTranscriptId?: string
  frozenSpoken?: Record<string, number>
  /** Emotion cues for THIS message. Supplying them shows the tags inline. */
  cues?: DisplayCue[]
}

const SpokenMessageText: React.FC<SpokenMessageTextProps> = ({
  text,
  messageId,
  isAgent,
  spokenChar = 0,
  spokenTranscriptId,
  frozenSpoken,
  cues,
}) => {
  const annotated = useMemo(
    () => (isAgent && cues?.length ? annotateWithCues(text, cues) : null),
    [isAgent, cues, text]
  )
  const shown = annotated?.text ?? text
  const at = (cursor: number) => annotated?.mapCursor(cursor) ?? cursor

  if (isAgent && messageId === spokenTranscriptId) {
    return <SpokenText text={shown} spokenChar={at(spokenChar)} />
  }
  const frozen = isAgent ? frozenSpoken?.[messageId] : undefined
  if (frozen != null) {
    return <SpokenText text={shown} spokenChar={at(frozen)} />
  }
  return <>{shown}</>
}

export default SpokenMessageText
