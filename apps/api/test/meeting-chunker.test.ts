import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/documents/chunker.js';
import {
  chunkTranscript,
  MEETING_MAX_GAP_MS,
  MEETING_MAX_TOKENS,
  splitSpeech,
} from '../src/meetings/chunker.js';
import type { Turn } from '../src/meetings/transcript.js';

const turn = (speaker: string, startMs: number, text: string): Turn => ({ speaker, startMs, text });

const SHORT: Turn[] = [
  turn('Alice', 5000, 'Morning everyone.'),
  turn('Bob', 15_000, 'The build is green.'),
  turn('Carol', 30_000, 'I will update the changelog.'),
];

const MAX_CHARS = (tokens: number) => tokens * 4;

describe('chunkTranscript: a short meeting', () => {
  it('makes one chunk with a line per turn, the speakers and the time range', () => {
    const chunks = chunkTranscript(SHORT, { endMs: 40_000 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({
      startMs: 5000,
      endMs: 40_000,
      speakers: ['Alice', 'Bob', 'Carol'],
      content: [
        '[00:00:05] Alice: Morning everyone.',
        '[00:00:15] Bob: The build is green.',
        '[00:00:30] Carol: I will update the changelog.',
      ].join('\n'),
      tokenCount: expect.any(Number),
    });
    expect(chunks[0]!.tokenCount).toBe(estimateTokens(chunks[0]!.content));
  });

  it('puts the title, and the date when it is known, above the lines', () => {
    expect(chunkTranscript(SHORT, { title: 'Release sync' })[0]!.content.split('\n')[0]).toBe(
      'Meeting: Release sync',
    );
    expect(
      chunkTranscript(SHORT, { title: 'Release sync', heldOn: '2026-10-01' })[0]!.content.split(
        '\n',
      )[0],
    ).toBe('Meeting: Release sync (2026-10-01)');
  });

  it('leaves out the date when there is no title to attach it to', () => {
    expect(chunkTranscript(SHORT, { heldOn: '2026-10-01' })[0]!.content).not.toContain('2026');
  });

  it('writes the time with hours', () => {
    const chunks = chunkTranscript([
      turn('Alice', 3_723_000, 'Late.'),
      turn('Bob', 3_724_000, 'Yes.'),
    ]);

    expect(chunks[0]!.content).toContain('[01:02:03] Alice: Late.');
  });

  it('lists each speaker once, in the order they first speak', () => {
    const chunks = chunkTranscript([
      turn('Bob', 1000, 'a'),
      turn('Alice', 2000, 'b'),
      turn('Bob', 3000, 'c'),
      turn('Alice', 4000, 'd'),
    ]);

    expect(chunks[0]!.speakers).toEqual(['Bob', 'Alice']);
  });

  it('returns nothing for no turns, and skips turns without words', () => {
    expect(chunkTranscript([])).toEqual([]);
    expect(chunkTranscript([turn('Alice', 1000, '   '), turn('Bob', 2000, '')])).toEqual([]);

    const chunks = chunkTranscript([
      turn('Alice', 1000, 'Hi.'),
      turn('Bob', 2000, ' '),
      turn('Carol', 3000, 'Yo.'),
    ]);
    expect(chunks[0]!.speakers).toEqual(['Alice', 'Carol']);
  });

  it('collapses whitespace inside a turn', () => {
    expect(chunkTranscript([turn('Alice', 1000, 'a \n  b\t c')])[0]!.content).toBe(
      '[00:00:01] Alice: a b c',
    );
  });
});

describe('chunkTranscript: where a turn ends', () => {
  it('runs a chunk up to the start of the next turn', () => {
    const chunks = chunkTranscript(
      [
        turn('Alice', 0, 'x'.repeat(30)),
        turn('Bob', 10_000, 'y'.repeat(30)),
        turn('Carol', 25_000, 'z'.repeat(30)),
      ],
      { maxTokens: 12 },
    );

    expect(chunks.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 10_000],
      [10_000, 25_000],
      [25_000, 25_000],
    ]);
  });

  it('does not stretch over a long silence', () => {
    const chunks = chunkTranscript([turn('Alice', 0, 'Hi.'), turn('Bob', 10 * 60_000, 'Hello.')], {
      endMs: 10 * 60_000 + 5000,
    });

    expect(chunks[0]!.endMs).toBe(MEETING_MAX_GAP_MS);
  });

  it('ends the last turn at the end of the meeting when that is known, and at its start otherwise', () => {
    expect(chunkTranscript(SHORT, { endMs: 90_000 })[0]!.endMs).toBe(90_000);
    expect(chunkTranscript(SHORT, { endMs: 60_000 })[0]!.endMs).toBe(60_000);
    expect(chunkTranscript(SHORT)[0]!.endMs).toBe(30_000);
  });

  it('never ends before it starts, even when times go backwards', () => {
    const chunks = chunkTranscript([
      turn('Alice', 20_000, 'One.'),
      turn('Bob', 10_000, 'Two.'),
      turn('Carol', 30_000, 'Three.'),
    ]);

    expect(chunks[0]!.startMs).toBe(10_000);
    expect(chunks[0]!.endMs).toBeGreaterThanOrEqual(chunks[0]!.startMs);
    expect(chunks[0]!.endMs).toBe(30_000);
  });
});

describe('chunkTranscript: splitting a long meeting', () => {
  const talk = Array.from({ length: 40 }, (_, i) =>
    turn(i % 2 ? 'Bob' : 'Alice', i * 10_000, `Point number ${i} about the plan.`),
  );

  it('keeps every chunk within the size limit', () => {
    const chunks = chunkTranscript(talk, { maxTokens: 60 });

    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHARS(60));
  });

  it('starts each chunk with the last turn of the one before', () => {
    const chunks = chunkTranscript(talk, { maxTokens: 60 });

    for (let i = 1; i < chunks.length; i++) {
      const previousLines = chunks[i - 1]!.content.split('\n');
      const firstOfNext = chunks[i]!.content.split('\n')[0]!;
      expect(firstOfNext).toBe(previousLines.at(-1));
    }
  });

  it('counts the repeated turn in the time range of the chunk that repeats it', () => {
    const chunks = chunkTranscript(talk, { maxTokens: 60 });

    const lastOfFirst = chunks[0]!.content.split('\n').at(-1)!;
    const repeated = talk.find((t) => lastOfFirst.endsWith(t.text))!;

    expect(chunks[1]!.startMs).toBe(repeated.startMs);
    expect(chunks[1]!.startMs).toBeLessThan(chunks[0]!.endMs);
  });

  it('closes the chunk at a pause and does not repeat anything across it', () => {
    const chunks = chunkTranscript([
      turn('Alice', 0, 'Before the break.'),
      turn('Bob', 30_000, 'Still before.'),
      turn('Carol', 30_000 + MEETING_MAX_GAP_MS + 1, 'After the break.'),
      turn('Alice', 30_000 + MEETING_MAX_GAP_MS + 10_000, 'Still after.'),
    ]);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.speakers).toEqual(['Alice', 'Bob']);
    expect(chunks[1]!.speakers).toEqual(['Carol', 'Alice']);
    expect(chunks[1]!.content).not.toContain('Still before');
  });

  it('does not treat a gap of exactly the limit as a pause', () => {
    const chunks = chunkTranscript([
      turn('Alice', 0, 'One.'),
      turn('Bob', MEETING_MAX_GAP_MS, 'Two.'),
    ]);

    expect(chunks).toHaveLength(1);
  });

  it('does not repeat a turn that is large compared with the chunk', () => {
    const big = 'a'.repeat(100);
    const chunks = chunkTranscript(
      [
        turn('Alice', 0, big),
        turn('Bob', 1000, 'b'.repeat(100)),
        turn('Carol', 2000, 'c'.repeat(100)),
      ],
      {
        maxTokens: 50,
      },
    );

    expect(chunks).toHaveLength(3);
    expect(chunks[1]!.speakers).toEqual(['Bob']);
  });

  it('never repeats a turn when it would leave no room for the new one', () => {
    const chunks = chunkTranscript(
      [turn('Alice', 0, 'a'.repeat(50)), turn('Bob', 1000, 'b'.repeat(130))],
      {
        maxTokens: 50,
      },
    );

    expect(chunks.map((c) => c.speakers)).toEqual([['Alice'], ['Bob']]);
  });

  it('has a default size that holds several turns', () => {
    const chunks = chunkTranscript(talk);

    expect(MEETING_MAX_TOKENS).toBe(225);
    expect(chunks.length).toBeLessThan(talk.length / 3);
    for (const chunk of chunks)
      expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHARS(MEETING_MAX_TOKENS));
  });

  it('counts the title against the size limit', () => {
    const chunks = chunkTranscript(talk, {
      maxTokens: 60,
      title: 'A rather long meeting title',
      heldOn: '2026-10-01',
    });

    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHARS(60));
    for (const chunk of chunks)
      expect(chunk.content.startsWith('Meeting: A rather long meeting title')).toBe(true);
  });
});

describe('chunkTranscript: one very long turn', () => {
  const sentence = 'We should move the launch to November because the vendor is late.';
  const monologue = turn('Alice', 65_000, Array.from({ length: 20 }, () => sentence).join(' '));

  it('is cut into pieces that each say who is speaking and when', () => {
    const chunks = chunkTranscript([monologue, turn('Bob', 95_000, 'Agreed.')], { maxTokens: 60 });

    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      for (const line of chunk.content.split('\n')) {
        expect(line).toMatch(/^\[00:(?:01:05|01:35)\] (?:Alice|Bob): \S/);
      }
      expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHARS(60));
    }
  });

  it('cuts at the end of a sentence when it can', () => {
    const chunks = chunkTranscript([monologue], { maxTokens: 60 });

    for (const chunk of chunks) {
      for (const line of chunk.content.split('\n')) expect(line.endsWith('late.')).toBe(true);
    }
  });

  it('keeps every word of the turn, in order', () => {
    const chunks = chunkTranscript([monologue], { maxTokens: 60 });
    const text = chunks
      .flatMap((c) => c.content.split('\n'))
      .map((line) => line.replace(/^\[[\d:]+\] Alice: /, ''))
      .join(' ');

    expect(text.replace(/\s+/g, ' ')).toBe(monologue.text);
  });

  it('cuts between words when a sentence is longer than a chunk', () => {
    const run = turn('Alice', 1000, Array.from({ length: 80 }, (_, i) => `word${i}`).join(' '));
    const chunks = chunkTranscript([run], { maxTokens: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    const words = chunks.flatMap((c) => c.content.replace(/\[[\d:]+\] Alice: /g, '').split(/\s+/));
    expect(words).toEqual(Array.from({ length: 80 }, (_, i) => `word${i}`));
  });

  it('cuts text with no spaces at all, without splitting an emoji', () => {
    const chunks = chunkTranscript(
      [turn('Alice', 1000, `a${'😀'.repeat(300)}`), turn('Bob', 2000, 'ok')],
      { maxTokens: 50 },
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHARS(50));
      expect(chunk.content).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
      expect(chunk.content).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
    }
  });
});

describe('splitSpeech', () => {
  it('returns short text whole', () => {
    expect(splitSpeech('Hello there.', 100)).toEqual(['Hello there.']);
  });

  it('packs sentences up to the limit', () => {
    expect(splitSpeech('One. Two. Three. Four.', 12)).toEqual(['One. Two.', 'Three. Four.']);
  });

  it('treats ! ? and … as sentence ends', () => {
    expect(splitSpeech('Really? Yes! Maybe… Sure.', 14)).toEqual(['Really? Yes!', 'Maybe… Sure.']);
  });

  it('does not cut after an abbreviation-like dot with no space after it', () => {
    expect(splitSpeech('See v1.2.3 now. Then go.', 16)).toEqual(['See v1.2.3 now.', 'Then go.']);
  });

  it('falls back to words, then to characters', () => {
    expect(splitSpeech('aaa bbb ccc ddd', 7)).toEqual(['aaa bbb', 'ccc ddd']);
    expect(splitSpeech('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });
});
