import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/documents/chunker.js';
import { chunkTranscript } from '../src/meetings/chunker.js';
import { formatTimestamp } from '../src/meetings/timestamp.js';
import type { Turn } from '../src/meetings/transcript.js';
import { seededRandom } from './helpers/chunk-invariants.js';

const SPEAKERS = ['Alice', 'Bob', 'Carol Jones', 'Dr. Smith', 'Оксана'];
const WORDS = [
  'we',
  'should',
  'ship',
  'the',
  'release',
  'on',
  'friday',
  'maybe',
  'budget',
  'plan',
  'ok',
  'yes',
  'no',
  'pricing',
  'launch',
  'vendor',
  'late',
  'because',
  'migration',
  'owner',
];
const TITLE = 'Sync';
const HELD_ON = '2026-10-01';

function randomTurns(random: () => number): Turn[] {
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;
  const count = 1 + Math.floor(random() * 60);
  let startMs = 0;
  return Array.from({ length: count }, () => {
    startMs += Math.floor(random() * (random() < 0.1 ? 400_000 : 30_000)) + 1000;
    const words = random() < 0.1 ? 150 + Math.floor(random() * 300) : 1 + Math.floor(random() * 30);
    const sentences: string[] = [];
    for (let i = 0; i < words; i++) {
      const word = pick(WORDS);
      sentences.push(i % 9 === 8 ? `${word}.` : word);
    }
    return { speaker: pick(SPEAKERS), startMs, text: sentences.join(' ') };
  });
}

function speechOf(chunks: ReturnType<typeof chunkTranscript>): Map<string, string> {
  const lines: string[] = [];
  for (const chunk of chunks) {
    const rows = chunk.content.split('\n').slice(1);
    if (lines.length > 0 && rows[0] === lines.at(-1)) rows.shift();
    lines.push(...rows);
  }
  const speech = new Map<string, string>();
  for (const line of lines) {
    const match = /^(\[\d+:\d\d:\d\d\] [^:]+): (.*)$/.exec(line)!;
    const key = match[1]!;
    speech.set(key, speech.has(key) ? `${speech.get(key)} ${match[2]}` : match[2]!);
  }
  return speech;
}

describe('chunkTranscript properties', () => {
  it('keeps every word of every turn, in order, whatever the sizes', () => {
    const random = seededRandom(5);
    for (let run = 0; run < 200; run++) {
      const turns = randomTurns(random);

      const chunks = chunkTranscript(turns, {
        title: TITLE,
        heldOn: HELD_ON,
        maxTokens: 60 + Math.floor(random() * 240),
        maxGapMs: 5000 + Math.floor(random() * 200_000),
      });

      const speech = speechOf(chunks);
      expect([...speech.values()]).toEqual(turns.map((t) => t.text));
      expect([...speech.keys()]).toEqual(
        turns.map((t) => `[${formatTimestamp(t.startMs)}] ${t.speaker}`),
      );
    }
  });

  it('keeps chunks within the size limit and describes them truthfully', () => {
    const random = seededRandom(9);
    for (let run = 0; run < 200; run++) {
      const turns = randomTurns(random);
      const maxTokens = 60 + Math.floor(random() * 240);

      const chunks = chunkTranscript(turns, { title: TITLE, heldOn: HELD_ON, maxTokens });

      const known = new Set(turns.map((t) => t.speaker));
      let previousStart = -1;
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(maxTokens * 4);
        expect(chunk.content.startsWith(`Meeting: ${TITLE} (${HELD_ON})\n`)).toBe(true);
        expect(chunk.tokenCount).toBe(estimateTokens(chunk.content));
        expect(chunk.startMs).toBeLessThanOrEqual(chunk.endMs);
        expect(chunk.startMs).toBeGreaterThanOrEqual(previousStart);
        previousStart = chunk.startMs;
        expect(chunk.speakers.length).toBeGreaterThan(0);
        expect(new Set(chunk.speakers).size).toBe(chunk.speakers.length);
        for (const speaker of chunk.speakers) {
          expect(known.has(speaker)).toBe(true);
          expect(chunk.content).toContain(`] ${speaker}: `);
        }
      }
    }
  });

  it('puts every line of speech under the speaker who said it', () => {
    const random = seededRandom(13);
    const turns = randomTurns(random);
    const owner = new Map(turns.map((t) => [`[${formatTimestamp(t.startMs)}]`, t.speaker]));

    for (const chunk of chunkTranscript(turns, { maxTokens: 70 })) {
      for (const line of chunk.content.split('\n')) {
        const match = /^(\[[\d:]+\]) (.+?): /.exec(line)!;
        expect(owner.get(match[1]!)).toBe(match[2]);
      }
    }
  });

  it('handles a very long meeting quickly', () => {
    const random = seededRandom(21);
    const turns: Turn[] = Array.from({ length: 20_000 }, (_, i) => ({
      speaker: SPEAKERS[i % SPEAKERS.length]!,
      startMs: i * 4000,
      text: Array.from({ length: 25 }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' '),
    }));

    const startedAt = performance.now();
    const chunks = chunkTranscript(turns, { title: TITLE });

    expect(chunks.length).toBeGreaterThan(1000);
    expect(performance.now() - startedAt).toBeLessThan(2000);
  });
});
