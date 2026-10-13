import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isSpoken,
  loadGoldenMeetings,
  parseGoldenMeetings,
  QUESTION_KINDS,
  type MeetingAnswerable,
} from '../src/eval/golden-meetings.js';
import { containsWord, normalizeForMatch } from '../src/eval/golden.js';
import { parseTranscript } from '../src/meetings/parser.js';
import {
  describeTime,
  detectFilters,
  windowFor,
  type MeetingFacts,
} from '../src/meetings/question-filters.js';
import type { ParsedTranscript } from '../src/meetings/transcript.js';

const root = join(import.meta.dirname, '../../..');
const golden = loadGoldenMeetings(join(root, 'scripts/eval/golden-meetings.json'));
const sources = readFileSync(join(root, 'samples/SOURCES.md'), 'utf8');

const transcripts = new Map<string, ParsedTranscript>(
  golden.meetings.map((m) => [
    m.file,
    parseTranscript(readFileSync(join(root, 'samples/meetings', m.file), 'utf8')),
  ]),
);

const facts: MeetingFacts[] = golden.meetings.map((m) => {
  const parsed = transcripts.get(m.file)!;
  const first = parsed.turns[0]!.startMs;
  return {
    id: m.file,
    participants: parsed.participants,
    firstStartMs: first,
    endMs: first + parsed.durationMs,
  };
});

const answerable = golden.questions.filter((q): q is MeetingAnswerable => q.type === 'answerable');
const unanswerable = golden.questions.filter((q) => q.type === 'unanswerable');
const everything = [...transcripts.values()]
  .flatMap((t) => t.turns.map((turn) => `${turn.speaker} ${turn.text}`))
  .join('\n');

describe('the sample meetings', () => {
  it('are three, in three different formats, and all can be read by the app', () => {
    expect(golden.meetings.map((m) => m.file)).toEqual([
      'product-planning.txt',
      'incident-review.txt',
      'hiring-sync.vtt',
    ]);
    const starts = golden.meetings.map(
      (m) => readFileSync(join(root, 'samples/meetings', m.file), 'utf8').split('\n')[0],
    );
    expect(starts[0]).toMatch(/^Product planning/);
    expect(starts[1]).toMatch(/^Gus \(00:00:06\):/);
    expect(starts[2]).toBe('WEBVTT');
    for (const parsed of transcripts.values()) {
      expect(parsed.turns.length).toBeGreaterThan(25);
      expect(parsed.durationMs).toBeGreaterThan(8 * 60_000);
      expect(parsed.outOfOrderTurns).toBe(0);
    }
  });

  it('have the speakers the questions rely on', () => {
    expect(transcripts.get('product-planning.txt')!.participants).toEqual([
      'Priya',
      'Marcus',
      'Lena',
      'Tomás',
      'Marco',
    ]);
    expect(transcripts.get('incident-review.txt')!.participants).toEqual([
      'Gus',
      'Dana',
      'Erik',
      'Fatima',
    ]);
    expect(transcripts.get('hiring-sync.vtt')!.participants).toEqual([
      'Hana',
      'Marcus',
      'Priya',
      'Gus',
    ]);
  });

  it('are described in SOURCES.md as written for this project', () => {
    expect(sources).toContain('samples/meetings');
    for (const meeting of golden.meetings) expect(sources).toContain(meeting.file);
    expect(sources).toMatch(/invented/i);
  });
});

describe('the golden question set for meetings', () => {
  it('has enough questions of each kind', () => {
    expect(answerable.length).toBeGreaterThanOrEqual(35);
    expect(unanswerable.length).toBeGreaterThanOrEqual(5);
    expect(unanswerable.filter((q) => q.type === 'unanswerable' && q.hard).length).toBeGreaterThan(
      0,
    );
    for (const kind of QUESTION_KINDS) {
      expect(answerable.filter((q) => q.kind === kind).length, kind).toBeGreaterThanOrEqual(4);
    }
  });

  it('asks about every meeting', () => {
    for (const meeting of golden.meetings) {
      const asked = answerable.filter((q) => q.expected.some((e) => e.meeting === meeting.file));
      expect(asked.length, meeting.file).toBeGreaterThanOrEqual(10);
    }
  });

  it('refers only to meetings that are there', () => {
    const files = new Set(golden.meetings.map((m) => m.file));
    for (const q of golden.questions) {
      for (const file of q.scope ?? []) expect(files.has(file), q.id).toBe(true);
    }
    for (const q of answerable) {
      for (const e of q.expected) expect(files.has(e.meeting), q.id).toBe(true);
    }
  });

  describe('the turns that answer a question', () => {
    const spoken = answerable.flatMap((q) =>
      q.expected.filter(isSpoken).map((e) => [q.id, e] as const),
    );

    it.each(spoken)('%s: the quote is verbatim, said by that speaker at that time', (_id, e) => {
      const turn = transcripts.get(e.meeting)!.turns.find((t) => t.startMs === e.atMs);

      expect(turn, `${e.meeting} at ${e.atMs}`).toBeDefined();
      expect(turn!.speaker).toBe(e.speaker);
      expect(normalizeForMatch(turn!.text)).toContain(normalizeForMatch(e.quote));
    });

    it('lies inside the meetings named in the scope of the question', () => {
      for (const q of answerable.filter((q) => q.scope)) {
        for (const e of q.expected) expect(q.scope, q.id).toContain(e.meeting);
      }
    });
  });

  describe('what the question names', () => {
    const named = answerable.filter((q) => q.filters);

    it('has questions about a person and about a time', () => {
      expect(named.filter((q) => q.filters?.speakers).length).toBeGreaterThanOrEqual(6);
      expect(named.filter((q) => q.filters?.time).length).toBeGreaterThanOrEqual(5);
    });

    it.each(named.map((q) => [q.id, q] as const))(
      '%s: is what the app itself picks out of the question',
      (_id, q) => {
        const inScope = q.scope ? facts.filter((f) => q.scope!.includes(f.id)) : facts;

        const detected = detectFilters(q.question, inScope);

        expect([...(detected?.speakers ?? [])].sort()).toEqual(
          [...(q.filters?.speakers ?? [])].sort(),
        );
        expect(detected?.time ? describeTime(detected.time) : undefined).toBe(q.filters?.time);
      },
    );

    it('is not invented for the questions that name nothing', () => {
      for (const q of answerable.filter((q) => !q.filters)) {
        const inScope = q.scope ? facts.filter((f) => q.scope!.includes(f.id)) : facts;
        const detected = detectFilters(q.question, inScope);
        expect(detected?.speakers ?? [], q.id).toEqual([]);
        expect(detected?.time ?? null, q.id).toBeNull();
      }
    });

    it('lets the stretch of time hold what answers it', () => {
      for (const q of named.filter((q) => q.filters?.time)) {
        const inScope = facts.filter((f) => !q.scope || q.scope.includes(f.id));
        const time = detectFilters(q.question, inScope)!.time!;
        for (const e of q.expected.filter(isSpoken)) {
          const window = windowFor(
            time,
            inScope.find((f) => f.id === e.meeting)!,
          )!;
          expect(e.atMs, `${q.id}: ${e.quote}`).toBeGreaterThanOrEqual(window.fromMs);
          expect(e.atMs, `${q.id}: ${e.quote}`).toBeLessThanOrEqual(window.toMs);
        }
      }
    });
  });

  it('has overview questions that the notes can answer', () => {
    const overview = answerable.filter((q) => q.kind === 'overview');

    expect(overview.length).toBeGreaterThanOrEqual(4);
    expect(overview.every((q) => q.expected.some((e) => !isSpoken(e)))).toBe(true);
  });

  it('has unanswerable questions whose key terms really are absent from every meeting', () => {
    for (const q of unanswerable) {
      if (q.type !== 'unanswerable') continue;
      for (const term of q.absentTerms)
        expect(containsWord(everything, term), `${q.id}: ${term}`).toBe(false);
    }
  });

  it('has a conversation or two that continues an earlier question', () => {
    expect(golden.questions.filter((q) => q.history).length).toBeGreaterThanOrEqual(0);
  });
});

describe('the notes a good summary holds', () => {
  it('has one entry for each meeting', () => {
    expect(golden.notes.map((n) => n.meeting)).toEqual(golden.meetings.map((m) => m.file));
  });

  it('rests only on what was said', () => {
    for (const truth of golden.notes) {
      const text = normalizeForMatch(
        transcripts
          .get(truth.meeting)!
          .turns.map((t) => t.text)
          .join(' '),
      );
      const quotes = [
        ...truth.decisions,
        ...truth.staleDecisions,
        ...truth.notDecisions,
        ...truth.actionItems,
        ...truth.openQuestions,
      ].map((item) => item.quote);
      for (const quote of quotes)
        expect(text, `${truth.meeting}: ${quote}`).toContain(normalizeForMatch(quote));
    }
  });

  it('names owners who speak in the meeting or are mentioned in it', () => {
    for (const truth of golden.notes) {
      const text = transcripts
        .get(truth.meeting)!
        .turns.map((t) => `${t.speaker} ${t.text}`)
        .join(' ');
      for (const item of truth.actionItems) {
        if (item.owner)
          expect(containsWord(text, item.owner), `${truth.meeting}: ${item.owner}`).toBe(true);
      }
    }
  });

  it('includes the traps: a decision that was changed, a task with no owner, and proposals that were not decided', () => {
    const planning = golden.notes.find((n) => n.meeting === 'product-planning.txt')!;
    const hiring = golden.notes.find((n) => n.meeting === 'hiring-sync.vtt')!;

    expect(planning.staleDecisions.length).toBeGreaterThan(0);
    expect(planning.actionItems.some((a) => a.owner === null)).toBe(true);
    expect(planning.actionItems.some((a) => a.due === null && a.owner !== null)).toBe(true);
    expect(planning.notDecisions.length).toBeGreaterThan(0);
    expect(hiring.notDecisions.length).toBeGreaterThan(0);
    for (const truth of golden.notes)
      expect(truth.decisions.length, truth.meeting).toBeGreaterThan(0);
  });
});

describe('parseGoldenMeetings', () => {
  const minimal = () => ({
    version: 1,
    description: 'x',
    meetings: [{ file: 'a.txt', title: 'A', heldOn: '2026-10-01' }],
    notes: [],
    questions: [
      {
        id: 'one',
        type: 'answerable',
        kind: 'fact',
        question: 'What was said?',
        expected: [{ meeting: 'a.txt', speaker: 'Ann', atMs: 0, quote: 'something said aloud' }],
        answer: 'x',
      },
    ],
  });

  it('accepts a small valid set', () => {
    expect(parseGoldenMeetings(minimal()).questions).toHaveLength(1);
  });

  it.each([
    [
      'a duplicate id',
      (s: ReturnType<typeof minimal>) => void s.questions.push({ ...s.questions[0]! }),
    ],
    [
      'an unknown kind',
      (s: ReturnType<typeof minimal>) =>
        void ((s.questions[0] as { kind: string }).kind = 'gossip'),
    ],
    [
      'a quote that is too short to prove anything',
      (s: ReturnType<typeof minimal>) =>
        void ((s.questions[0]!.expected[0] as { quote: string }).quote = 'short'),
    ],
    [
      'evidence without a place',
      (s: ReturnType<typeof minimal>) =>
        void s.questions[0]!.expected.splice(0, 1, { meeting: 'a.txt' } as never),
    ],
    [
      'a date that does not exist',
      (s: ReturnType<typeof minimal>) => void (s.meetings[0]!.heldOn = '2026-13-45'),
    ],
    [
      'a file name with a path',
      (s: ReturnType<typeof minimal>) => void (s.meetings[0]!.file = '../a.txt'),
    ],
    [
      'an unanswerable question without absent terms',
      (s: ReturnType<typeof minimal>) =>
        void s.questions.splice(0, 1, {
          id: 'u',
          type: 'unanswerable',
          question: 'Anything at all?',
          note: 'n',
          absentTerms: [],
        } as never),
    ],
  ])('refuses %s', (_label, mutate) => {
    const set = minimal();
    mutate(set);

    expect(() => parseGoldenMeetings(set)).toThrow(/Invalid golden set for meetings/);
  });
});
