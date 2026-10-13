import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppliedFilters } from '../src/meetings/question-filters.js';
import {
  loadGoldenMeetings,
  parseGoldenMeetings,
  type MeetingAnswerable,
  type MeetingEvidence,
} from '../src/eval/golden-meetings.js';
import {
  checkFilters,
  evaluateMeetingRetrieval,
  isRelevantHit,
  type MeetingHit,
  type MeetingSearcher,
  type MeetingVariant,
} from '../src/eval/meeting-eval.js';
import { formatMeetingReport, formatNotesReport } from '../src/eval/meeting-report.js';
import { scoreNotes, summarizeNotes } from '../src/eval/notes-eval.js';

const hit = (file: string, startMs: number | null, endMs: number | null): MeetingHit => ({
  file,
  startMs,
  endMs,
  speakers: ['Alice'],
  content: 'x',
});

const spoken = (meeting: string, atMs: number): MeetingEvidence => ({
  meeting,
  speaker: 'Alice',
  atMs,
  quote: 'some words spoken aloud',
});
const notesOf = (meeting: string): MeetingEvidence => ({ meeting, notes: true });

describe('isRelevantHit', () => {
  it('accepts a passage of the right meeting that covers the moment', () => {
    expect(isRelevantHit(hit('a.txt', 60_000, 120_000), [spoken('a.txt', 90_000)])).toBe(true);
  });

  it('counts the first and last moment of the passage', () => {
    expect(isRelevantHit(hit('a.txt', 60_000, 120_000), [spoken('a.txt', 60_000)])).toBe(true);
    expect(isRelevantHit(hit('a.txt', 60_000, 120_000), [spoken('a.txt', 120_000)])).toBe(true);
  });

  it.each([
    ['before it', 59_999],
    ['after it', 120_001],
  ])('refuses a moment %s', (_label, atMs) => {
    expect(isRelevantHit(hit('a.txt', 60_000, 120_000), [spoken('a.txt', atMs)])).toBe(false);
  });

  it('refuses another meeting, even at the same moment', () => {
    expect(isRelevantHit(hit('b.txt', 60_000, 120_000), [spoken('a.txt', 90_000)])).toBe(false);
  });

  it('refuses the passage that carries the notes when a moment is wanted', () => {
    expect(isRelevantHit(hit('a.txt', null, null), [spoken('a.txt', 90_000)])).toBe(false);
  });

  it('accepts the notes of the right meeting when notes are wanted, and only them', () => {
    expect(isRelevantHit(hit('a.txt', null, null), [notesOf('a.txt')])).toBe(true);
    expect(isRelevantHit(hit('b.txt', null, null), [notesOf('a.txt')])).toBe(false);
    expect(isRelevantHit(hit('a.txt', 0, 60_000), [notesOf('a.txt')])).toBe(false);
  });

  it('accepts any of several places that answer the question', () => {
    const expected = [spoken('a.txt', 90_000), spoken('b.txt', 10_000), notesOf('c.txt')];

    expect(isRelevantHit(hit('b.txt', 0, 20_000), expected)).toBe(true);
    expect(isRelevantHit(hit('c.txt', null, null), expected)).toBe(true);
    expect(isRelevantHit(hit('a.txt', 0, 20_000), expected)).toBe(false);
  });
});

const golden = parseGoldenMeetings({
  version: 1,
  description: 'x',
  meetings: [
    { file: 'a.txt', title: 'A', heldOn: '2026-10-01' },
    { file: 'b.txt', title: 'B', heldOn: '2026-10-02' },
  ],
  notes: [],
  questions: [
    {
      id: 'fact',
      type: 'answerable',
      kind: 'fact',
      question: 'What happened first?',
      expected: [
        { meeting: 'a.txt', speaker: 'Alice', atMs: 10_000, quote: 'some words spoken aloud' },
      ],
      answer: 'x',
    },
    {
      id: 'person',
      type: 'answerable',
      kind: 'speaker',
      question: 'What did Alice say?',
      filters: { speakers: ['Alice'] },
      scope: ['a.txt'],
      expected: [
        { meeting: 'a.txt', speaker: 'Alice', atMs: 70_000, quote: 'some words spoken aloud' },
      ],
      answer: 'x',
    },
    {
      id: 'summary',
      type: 'answerable',
      kind: 'overview',
      question: 'Summarise the meeting',
      expected: [{ meeting: 'b.txt', notes: true }],
      answer: 'x',
    },
    {
      id: 'nothing',
      type: 'unanswerable',
      question: 'What is the weather?',
      note: 'n',
      absentTerms: ['weather'],
      hard: true,
    },
  ],
});

function searching(
  results: (
    variant: MeetingVariant,
    query: string,
    scope?: string[],
  ) => ReturnType<MeetingSearcher['search']>,
): MeetingSearcher & { calls: Array<[MeetingVariant, string, string[] | undefined]> } {
  const calls: Array<[MeetingVariant, string, string[] | undefined]> = [];
  return {
    calls,
    search(variant, query, scope) {
      calls.push([variant, query, scope]);
      return results(variant, query, scope);
    },
  };
}

const outcome = (hits: MeetingHit[], bestScore: number | null = 0.5, filters?: AppliedFilters) => ({
  hits,
  bestScore,
  ...(filters && { filters }),
});

describe('checkFilters', () => {
  const question = (filters?: MeetingAnswerable['filters']) => ({ filters }) as MeetingAnswerable;

  it('agrees when the app picked out what the question names, in any order', () => {
    const check = checkFilters(question({ speakers: ['Bob', 'Alice'], time: 'first 2 minutes' }), {
      speakers: ['Alice', 'Bob'],
      time: 'first 2 minutes',
      relaxed: false,
    });

    expect(check.agrees).toBe(true);
    expect(check.expected).toEqual({ speakers: ['Alice', 'Bob'], time: 'first 2 minutes' });
  });

  it.each([
    ['the wrong person', { speakers: ['Bob'], time: null, relaxed: false }],
    ['the wrong time', { speakers: ['Alice'], time: 'last 2 minutes', relaxed: false }],
    ['nothing at all', undefined],
  ])('disagrees when the app picked out %s', (_label, applied) => {
    expect(
      checkFilters(question({ speakers: ['Alice'], time: 'first 2 minutes' }), applied).agrees,
    ).toBe(false);
  });

  it('agrees about a question that names nothing only if nothing was picked out', () => {
    expect(checkFilters(question(), undefined).agrees).toBe(true);
    expect(
      checkFilters(question(), { speakers: ['Alice'], time: null, relaxed: false }).agrees,
    ).toBe(false);
  });
});

describe('evaluateMeetingRetrieval', () => {
  it('asks each variant, with the scope of the question, and ranks the first right passage', async () => {
    const right = (variant: MeetingVariant) =>
      variant === 'vector' ? hit('a.txt', 0, 5000) : hit('a.txt', 0, 20_000);
    const searcher = searching(async (variant, query) => {
      if (query === 'What happened first?') {
        return outcome([hit('b.txt', 0, 5000), right(variant)]);
      }
      if (query === 'What did Alice say?') {
        return outcome([hit('a.txt', 60_000, 90_000)], 0.6, {
          speakers: ['Alice'],
          time: null,
          relaxed: false,
        });
      }
      return outcome([hit('b.txt', null, null)], 0.7);
    });

    const report = await evaluateMeetingRetrieval({ golden, searcher });

    const byId = Object.fromEntries(report.rows.map((row) => [row.id, row]));
    expect(byId['fact']!.ranks).toEqual({ hybrid: 2, unfiltered: 2, vector: null, keyword: 2 });
    expect(byId['person']!.ranks.hybrid).toBe(1);
    expect(byId['summary']!.ranks.hybrid).toBe(1);
    expect(
      searcher.calls.filter(([, q]) => q === 'What did Alice say?').map(([v, , s]) => [v, s]),
    ).toEqual([
      ['hybrid', ['a.txt']],
      ['unfiltered', ['a.txt']],
      ['vector', ['a.txt']],
      ['keyword', ['a.txt']],
    ]);
    expect(searcher.calls.find(([, q]) => q === 'What happened first?')![2]).toBeUndefined();
  });

  it('only searches once for a question that cannot be answered', async () => {
    const searcher = searching(async () => outcome([], 0.3));

    await evaluateMeetingRetrieval({ golden, searcher });

    expect(searcher.calls.filter(([, q]) => q === 'What is the weather?')).toHaveLength(1);
    expect(searcher.calls).toHaveLength(3 * 4 + 1);
  });

  it('summarises all questions and each kind', async () => {
    const searcher = searching(async (_variant, query) =>
      query === 'What happened first?'
        ? outcome([hit('a.txt', 0, 20_000)])
        : outcome([hit('b.txt', 0, 10)]),
    );

    const report = await evaluateMeetingRetrieval({ golden, searcher, ks: [1, 6] });

    expect(report.summary.all.hybrid).toMatchObject({
      questions: 3,
      hitAt: { 1: 1 / 3, 6: 1 / 3 },
    });
    expect(report.summary.byKind.fact.hybrid.hitAt[1]).toBe(1);
    expect(report.summary.byKind.speaker.hybrid.hitAt[1]).toBe(0);
    expect(report.summary.byKind.time.hybrid.questions).toBe(0);
  });

  it('only looks at the top of the list', async () => {
    const searcher = searching(async () =>
      outcome([hit('b.txt', 0, 10), hit('b.txt', 0, 10), hit('a.txt', 0, 20_000)]),
    );

    const near = await evaluateMeetingRetrieval({ golden, searcher, cutoff: 3 });
    const far = await evaluateMeetingRetrieval({ golden, searcher, cutoff: 2 });

    expect(near.rows.find((r) => r.id === 'fact')!.ranks.hybrid).toBe(3);
    expect(far.rows.find((r) => r.id === 'fact')!.ranks.hybrid).toBeNull();
  });

  it('counts how well the app picked out the speaker and time, and what it did not ask for', async () => {
    const searcher = searching(async (_variant, query) =>
      query === 'What did Alice say?'
        ? outcome([], 0.5, { speakers: ['Alice'], time: null, relaxed: true })
        : query === 'What happened first?'
          ? outcome([], 0.5, { speakers: ['Alice'], time: null, relaxed: false })
          : outcome([]),
    );

    const report = await evaluateMeetingRetrieval({ golden, searcher });

    expect(report.filters).toEqual({ named: 1, recognised: 1, unexpected: 1, relaxed: 1 });
  });

  it('sweeps the relevance threshold over the best scores of both groups', async () => {
    const searcher = searching(async (_variant, query) =>
      outcome([], query === 'What is the weather?' ? 0.3 : 0.6),
    );

    const report = await evaluateMeetingRetrieval({
      golden,
      searcher,
      thresholds: [0.2, 0.5, 0.7],
    });

    expect(report.thresholds).toEqual([
      { threshold: 0.2, answered: 1, refused: 0 },
      { threshold: 0.5, answered: 1, refused: 1 },
      { threshold: 0.7, answered: 0, refused: 1 },
    ]);
    expect(report.unanswerable).toEqual([
      { id: 'nothing', question: 'What is the weather?', hard: true, bestScore: 0.3 },
    ]);
  });

  it('reports progress', async () => {
    const seen: string[] = [];

    await evaluateMeetingRetrieval({
      golden,
      searcher: searching(async () => outcome([])),
      onProgress: (done, total, id) => seen.push(`${done}/${total} ${id}`),
    });

    expect(seen).toEqual(['1/4 fact', '2/4 person', '3/4 summary', '4/4 nothing']);
  });
});

describe('the report', () => {
  const real = loadGoldenMeetings(
    join(import.meta.dirname, '../../../scripts/eval/golden-meetings.json'),
  );

  async function report() {
    const searcher = searching(async (variant, query) =>
      outcome(
        variant === 'vector' ? [] : [hit('product-planning.txt', 0, 1000)],
        query.startsWith('What is the budget') ? 0.3 : 0.55,
      ),
    );
    return evaluateMeetingRetrieval({ golden: real, searcher });
  }

  it('shows the quality of every kind of question and every variant', async () => {
    const text = formatMeetingReport(await report(), 0.3);

    expect(text).toContain('all answerable (46)');
    for (const kind of ['fact', 'decision', 'action', 'speaker', 'time', 'overview']) {
      expect(text).toMatch(new RegExp(`^${kind} \\(\\d+\\)`, 'm'));
    }
    for (const variant of ['hybrid', 'unfiltered', 'vector', 'keyword'])
      expect(text).toContain(`  ${variant}`);
    expect(text).toContain('hit@1');
    expect(text).toContain('MRR');
  });

  it('lists the questions that were missed and where the search looked instead', async () => {
    const text = formatMeetingReport(await report(), 0.3);

    expect(text).toMatch(/Hybrid misses \(\d+\)/);
    expect(text).toContain('got: product-planning.txt@0s');
  });

  it('shows the threshold table with the current value marked', async () => {
    const text = formatMeetingReport(await report(), 0.3);

    expect(text).toMatch(/0\.300 .*<- current/);
    expect(text).toContain('best scores, answerable:   0.550 to 0.550');
    expect(text).toContain('best scores, unanswerable: 0.300 to 0.550');
    expect(text).toContain('closest unanswerable questions:');
  });

  it('says how well the filters were recognised and which were not', async () => {
    const text = formatMeetingReport(await report(), 0.3);

    expect(text).toMatch(
      /picked out the right speaker and time for 0 of \d+ questions that name one/,
    );
    expect(text).toContain('planning-marco-testing: expected');
  });

  it('shows the notes and what is missing from them', () => {
    const scores = real.notes.map((truth, i) =>
      scoreNotes(
        truth,
        i === 0
          ? null
          : { summary: '', topics: [], decisions: [], actionItems: [], openQuestions: [] },
      ),
    );

    const text = formatNotesReport(scores, summarizeNotes(scores));

    expect(text).toContain('Meeting notes (2 of 3 meetings have notes)');
    expect(text).toContain('product-planning.txt: no notes were written');
    expect(text).toContain('missed decision:');
    expect(text).toContain('missed action item:');
    expect(text).toMatch(/decisions found\s+0%/);
    expect(text).toMatch(/decisions supported\s+n\/a/);
  });
});
