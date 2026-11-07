/**
 * The screen<->agent channel in the session history. Pure, shared by the live
 * recorder path (SessionsService.storeRecordedMessage) and the room monitor.
 */

export const CLIENT_CHANNEL_MESSAGE_TYPES = ['client_event', 'client_event_reply', 'agent_command'] as const;

export interface ClientChannelRecord {
  content: string;
  messageType: string;
  role: 'system';
  status: 'final';
  metadata: Record<string, unknown>;
}

/**
 * How a client channel envelope is stored: a short readable line plus the
 * envelope's data. Role 'system', so it never counts as an agent message.
 */
export function clientChannelRecord(
  envelope: { type: string; data?: unknown },
  participantId: string,
): ClientChannelRecord | null {
  if (!(CLIENT_CHANNEL_MESSAGE_TYPES as readonly string[]).includes(envelope.type)) return null;
  const data = (envelope.data && typeof envelope.data === 'object' ? envelope.data : {}) as Record<string, unknown>;
  const name = String(data.event ?? data.command ?? '');
  if (!name) return null;
  const content =
    envelope.type === 'client_event'
      ? `Screen event: ${name}`
      : envelope.type === 'agent_command'
        ? `Agent command: ${name}`
        : `Reply to ${name}: ${data.ok ? 'ok' : `error: ${String(data.error ?? 'failed')}`}`;
  return {
    content,
    messageType: envelope.type,
    role: 'system',
    status: 'final',
    metadata: { ...data, participant_id: participantId },
  };
}
