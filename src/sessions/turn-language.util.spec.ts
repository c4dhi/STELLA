import { jest } from '@jest/globals';
import { attachTurnLanguage, pickTurnLanguage } from './turn-language.util.js';

const spoken = {
  transcript_id: 'whisper_1',
  detected_language: 'de',
  language_confidence: 0.973,
  duration_s: 1.83,
  word_count: 4,
  resolved_language: 'de',
  redecoded: false,
};

function fakePrisma(rows: Array<{ id: string; metadata: any }>, appearAfter = 0) {
  let calls = 0;
  const updates: Array<{ id: string; metadata: any }> = [];
  const prisma = {
    message: {
      findFirst: jest.fn(async (args: any) => {
        calls += 1;
        if (calls <= appearAfter) return null;
        const ors = args.where.OR as any[];
        return (
          rows.find((r) =>
            ors.some((o) => {
              const path: string[] = o.metadata.path;
              let v: any = r.metadata;
              for (const k of path) v = v?.[k];
              return v === o.metadata.equals;
            }),
          ) ?? null
        );
      }),
      update: jest.fn(async (args: any) => {
        updates.push({ id: args.where.id, metadata: args.data.metadata });
        return {};
      }),
    },
  };
  return { prisma, updates };
}

const noSleep = async () => {};

describe('pickTurnLanguage', () => {
  it('keeps exactly the language fields, never text', () => {
    expect(pickTurnLanguage({ ...spoken, text: 'Ich gehe', correlation_id: 'c' })).toEqual({
      detected_language: 'de',
      language_confidence: 0.973,
      duration_s: 1.83,
      word_count: 4,
      resolved_language: 'de',
      redecoded: false,
    });
  });
});

describe('attachTurnLanguage', () => {
  it('merges the record into the spoken turn that has its transcript id', async () => {
    const { prisma, updates } = fakePrisma([
      { id: 'm1', metadata: { envelope: { type: 'transcript', data: { transcript_id: 'whisper_1' } }, speaker_name: 'P' } },
    ]);
    const result = await attachTurnLanguage(prisma as any, 's1', spoken, { sleep: noSleep });
    expect(result).toEqual({ success: true, stored: true, messageId: 'm1', messageType: 'turn_language' });
    expect(updates).toEqual([{
      id: 'm1',
      metadata: {
        envelope: { type: 'transcript', data: { transcript_id: 'whisper_1' } },
        speaker_name: 'P',
        language: pickTurnLanguage(spoken),
      },
    }]);
  });

  it('finds a typed turn by the frontend correlation id', async () => {
    const { prisma, updates } = fakePrisma([
      { id: 'm2', metadata: { envelope: { type: 'user_text', data: { text: 'x', correlation_id: 'corr-1' } } } },
    ]);
    const typed = { transcript_id: 'uuid-1', correlation_id: 'corr-1', detected_language: null,
      language_confidence: null, duration_s: null, word_count: 1, resolved_language: 'de', redecoded: false };
    await attachTurnLanguage(prisma as any, 's1', typed, { sleep: noSleep });
    expect(updates[0].id).toBe('m2');
    expect(updates[0].metadata.language.detected_language).toBeNull();
  });

  it('waits for a transcript that is stored a moment later', async () => {
    const { prisma, updates } = fakePrisma(
      [{ id: 'm3', metadata: { envelope: { data: { transcript_id: 'whisper_1' } } } }],
      2,
    );
    await attachTurnLanguage(prisma as any, 's1', spoken, { sleep: noSleep });
    expect(prisma.message.findFirst).toHaveBeenCalledTimes(3);
    expect(updates).toHaveLength(1);
  });

  it('gives up without adding a row when the turn never shows up', async () => {
    const { prisma, updates } = fakePrisma([]);
    const result = await attachTurnLanguage(prisma as any, 's1', spoken, { sleep: noSleep, attempts: 3 });
    expect(result).toMatchObject({ success: true, stored: false, reason: 'turn_not_found' });
    expect(prisma.message.findFirst).toHaveBeenCalledTimes(3);
    expect(updates).toEqual([]);
  });

  it('ignores a record with no ids', async () => {
    const { prisma } = fakePrisma([]);
    const result = await attachTurnLanguage(prisma as any, 's1', { word_count: 1 }, { sleep: noSleep });
    expect(result).toMatchObject({ stored: false, reason: 'no_turn_id' });
    expect(prisma.message.findFirst).not.toHaveBeenCalled();
  });

  it('only looks at user transcripts and typed messages of this session', async () => {
    const { prisma } = fakePrisma([]);
    await attachTurnLanguage(prisma as any, 's1', spoken, { sleep: noSleep, attempts: 1 });
    const where = (prisma.message.findFirst.mock.calls[0][0] as any).where;
    expect(where.sessionId).toBe('s1');
    expect(where.messageType).toEqual({ in: ['transcript', 'transcript_chunk', 'user_text'] });
  });
});
