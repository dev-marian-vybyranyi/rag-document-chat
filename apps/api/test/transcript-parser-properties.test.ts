import { describe, expect, it } from 'vitest';
import { parseTranscript } from '../src/meetings/parser.js';
import { formatTimestamp } from '../src/meetings/timestamp.js';
import { TranscriptParseError, type Turn } from '../src/meetings/transcript.js';
import { seededRandom } from './helpers/chunk-invariants.js';

const SPEAKERS = ['Alice', 'Bob', 'Carol Jones', 'Dr. Smith', 'Speaker 1', 'Оксана'];
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
];
const LINE_WORDS = 8;

type Renderer = (turn: Turn) => string[];

const clock = (turn: Turn) => formatTimestamp(turn.startMs);
const wrap = (text: string) => {
  const words = text.split(' ');
  const rows: string[] = [];
  for (let i = 0; i < words.length; i += LINE_WORDS)
    rows.push(words.slice(i, i + LINE_WORDS).join(' '));
  return rows;
};

const RENDERERS: Record<string, Renderer> = {
  'bracket-inline': (t) => [`[${clock(t)}] ${t.speaker}: ${t.text}`],
  'suffix-inline': (t) => [`${t.speaker} (${clock(t)}): ${t.text}`],
  'prefix-inline': (t) => [`${clock(t)} ${t.speaker}: ${t.text}`],
  'bracket-header': (t) => [`[${clock(t)}] ${t.speaker}`, ...wrap(t.text)],
  'suffix-header': (t) => [`${t.speaker} ${clock(t)}`, ...wrap(t.text)],
  'prefix-header': (t) => [`${clock(t)} ${t.speaker}`, ...wrap(t.text)],
  'name-bracket-header': (t) => [`[${t.speaker}] ${clock(t)}`, ...wrap(t.text)],
};

function randomTurns(random: () => number): Turn[] {
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;
  const count = 2 + Math.floor(random() * 30);
  let startMs = Math.floor(random() * 5) * 1000;
  return Array.from({ length: count }, () => {
    startMs += (1 + Math.floor(random() * 120)) * 1000;
    const length = 1 + Math.floor(random() * 40);
    return {
      speaker: pick(SPEAKERS),
      startMs,
      text: Array.from({ length }, () => pick(WORDS)).join(' '),
    };
  });
}

describe('parseTranscript properties', () => {
  for (const [format, render] of Object.entries(RENDERERS)) {
    it(`reads back every turn it was written with, in the ${format} format`, () => {
      const random = seededRandom(7);
      for (let run = 0; run < 150; run++) {
        const turns = randomTurns(random);
        const separator = run % 2 === 0 ? '\n' : '\n\n';
        const text = turns.map((turn) => render(turn).join('\n')).join(separator);

        const parsed = parseTranscript(text);

        expect(parsed.turns).toEqual(turns);
        expect(parsed.participants).toEqual([...new Set(turns.map((t) => t.speaker))]);
        expect(parsed.durationMs).toBe(turns.at(-1)!.startMs - turns[0]!.startMs);
        expect(parsed.outOfOrderTurns).toBe(0);
      }
    });
  }

  it('returns well-formed turns or refuses with its own error, whatever the input', () => {
    const random = seededRandom(11);
    const pieces = [
      '[',
      ']',
      '(',
      ')',
      ':',
      ' ',
      '\n',
      '\r',
      '-',
      '--> ',
      '.',
      ',',
      '<v ',
      '>',
      '</v>',
      '&amp;',
      '0',
      '1',
      '12:30',
      '00:00:05',
      'a',
      'Bob',
      'WEBVTT',
      '​',
    ];
    for (let run = 0; run < 3000; run++) {
      const length = Math.floor(random() * 120);
      const text = Array.from({ length }, () => pieces[Math.floor(random() * pieces.length)]!).join(
        '',
      );
      const input = run % 4 === 0 ? `WEBVTT\n\n${text}` : text;

      let parsed;
      try {
        parsed = parseTranscript(input);
      } catch (error) {
        expect(error).toBeInstanceOf(TranscriptParseError);
        continue;
      }

      expect(parsed.turns.length).toBeGreaterThanOrEqual(2);
      expect(new Set(parsed.participants).size).toBe(parsed.participants.length);
      for (const turn of parsed.turns) {
        expect(parsed.participants).toContain(turn.speaker);
        expect(turn.text.trim()).not.toBe('');
        expect(turn.text).toBe(turn.text.replace(/\s+/g, ' ').trim());
        expect(Number.isFinite(turn.startMs)).toBe(true);
        expect(turn.startMs).toBeGreaterThanOrEqual(0);
      }
      expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('stays fast on input built to make a pattern backtrack', () => {
    const hostile = [
      `${'a'.repeat(300_000)}:`,
      `${' '.repeat(200_000)}[00:00] x`,
      '['.repeat(100_000),
      '(00:00)'.repeat(30_000),
      `${'00:00 '.repeat(30_000)}a`,
      `${'a ('.repeat(50_000)}00:00): x`,
      `[00:00] ${'a:'.repeat(100_000)}`,
      `${'x 00:00 '.repeat(30_000)}`,
      `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${'<v '.repeat(50_000)}`,
    ];
    for (const input of hostile) {
      const startedAt = performance.now();
      try {
        parseTranscript(input);
      } catch (error) {
        expect(error).toBeInstanceOf(TranscriptParseError);
      }
      expect(performance.now() - startedAt).toBeLessThan(1500);
    }
  });
});
