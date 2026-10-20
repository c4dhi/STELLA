import { Prisma, PrismaClient } from '@prisma/client';

/**
 * A user turn's language signal (#91), published by the agent as a
 * `turn_language` envelope once it has resolved the turn. It is merged into
 * that turn's stored transcript message as `metadata.language` rather than
 * stored as a row of its own, and carries no transcript text.
 */
const TURN_LANGUAGE_FIELDS = [
  'detected_language',
  'language_confidence',
  'duration_s',
  'word_count',
  'resolved_language',
  'redecoded',
] as const;

export function pickTurnLanguage(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of TURN_LANGUAGE_FIELDS) {
    out[key] = data[key] ?? null;
  }
  return out;
}

export interface AttachTurnLanguageOptions {
  // The agent publishes the record after the transcript, but the recorder
  // stores both concurrently, so the transcript row can land a moment later.
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function attachTurnLanguage(
  prisma: Pick<PrismaClient, 'message'>,
  sessionId: string,
  data: Record<string, any>,
  { attempts = 5, delayMs = 400, sleep = defaultSleep }: AttachTurnLanguageOptions = {},
) {
  const transcriptId = typeof data?.transcript_id === 'string' ? data.transcript_id : undefined;
  const correlationId = typeof data?.correlation_id === 'string' ? data.correlation_id : undefined;
  if (!transcriptId && !correlationId) {
    return { success: true, stored: false, reason: 'no_turn_id' };
  }

  // A spoken turn is the agent's transcript envelope (data.transcript_id); a
  // typed one is the frontend's user_text envelope (data.correlation_id).
  const match: Prisma.MessageWhereInput[] = [];
  if (transcriptId) {
    match.push({ metadata: { path: ['envelope', 'data', 'transcript_id'], equals: transcriptId } });
  }
  if (correlationId) {
    match.push({ metadata: { path: ['envelope', 'data', 'correlation_id'], equals: correlationId } });
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const target = await prisma.message.findFirst({
      where: {
        sessionId,
        messageType: { in: ['transcript', 'transcript_chunk', 'user_text'] },
        OR: match,
      },
      orderBy: { timestamp: 'desc' },
      select: { id: true, metadata: true },
    });
    if (target) {
      const metadata = {
        ...((target.metadata as Record<string, unknown>) ?? {}),
        language: pickTurnLanguage(data),
      };
      await prisma.message.update({
        where: { id: target.id },
        data: { metadata: metadata as Prisma.InputJsonValue },
      });
      return { success: true, stored: true, messageId: target.id, messageType: 'turn_language' };
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  return { success: true, stored: false, reason: 'turn_not_found' };
}
