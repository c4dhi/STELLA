import type { ParticipantMessage } from './ParticipantSessionView'

export interface IncomingAgentReply {
  transcriptId: string
  text: string
  isFinal: boolean
  agentName?: string
}

/**
 * Add or update an agent reply in the message list.
 *
 * A reply cut off mid-stream (barge-in, disconnect) never gets its own
 * `is_final` chunk, so without this its message would stay `isStreaming`
 * forever and the "… is writing…" indicator would never clear (#1065). The
 * latest point we know for sure it's over is when a newer agent reply starts,
 * so starting one clears `isStreaming` on any earlier one still carrying it.
 */
export function applyAgentReply(
  prev: ParticipantMessage[],
  incoming: IncomingAgentReply,
): ParticipantMessage[] {
  const existingIdx = prev.findIndex(m => m.id === incoming.transcriptId)
  if (existingIdx >= 0) {
    const updated = [...prev]
    updated[existingIdx] = {
      ...updated[existingIdx],
      text: incoming.text,
      isStreaming: !incoming.isFinal,
    }
    return updated
  }

  return [
    ...prev.map(m => (m.role === 'assistant' && m.isStreaming ? { ...m, isStreaming: false } : m)),
    {
      id: incoming.transcriptId,
      role: 'assistant',
      text: incoming.text,
      timestamp: new Date(),
      isStreaming: !incoming.isFinal,
      speakerName: incoming.agentName,
    },
  ]
}
