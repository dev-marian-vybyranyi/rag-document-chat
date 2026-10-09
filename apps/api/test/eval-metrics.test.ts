import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { chunkSegments } from '../src/documents/chunker.js';
import { extractText } from '../src/documents/extract.js';
import { detectFileType } from '../src/documents/file-types.js';
import { listSampleFiles } from '../src/eval/corpus.js';
import { loadGoldenSet, parseGoldenSet } from '../src/eval/golden.js';
import {
  firstRelevantRank,
  recommendThreshold,
  summarizeRanks,
  sweepThresholds,
} from '../src/eval/metrics.js';
import { formatRetrievalReport } from '../src/eval/report.js';
import {
  evaluateRetrieval,
  findUncoveredQuotes,
  isRelevant,
  type EvalHit,
  type Searcher,
  type Variant,
} from '../src/eval/retrieval-eval.js';

describe('firstRelevantRank', () => {
  it.each([
    [[true, false], 1],
    [[false, false, true, true], 3],
    [[false, false], null],
    [[], null],
  ])('finds the rank in %j', (flags, rank) => {
    expect(firstRelevantRank(flags)).toBe(rank);
  });
});

describe('summarizeRanks', () => {
  it('counts hits within each cutoff and averages the reciprocal rank', () => {
    const summary = summarizeRanks([1, 2, 4, null], [1, 3, 6]);

    expect(summary.questions).toBe(4);
    expect(summary.hitAt).toEqual({ 1: 0.25, 3: 0.5, 6: 0.75 });
    expect(summary.mrr).toBeCloseTo((1 + 1 / 2 + 1 / 4 + 0) / 4);
  });

  it('is all zeros for no questions rather than not-a-number', () => {
    expect(summarizeRanks([], [1, 6])).toEqual({ questions: 0, hitAt: { 1: 0, 6: 0 }, mrr: 0 });
  });

  it('gives a perfect score only when every first hit is at rank one', () => {
    expect(summarizeRanks([1, 1, 1], [1]).mrr).toBe(1);
    expect(summarizeRanks([1, 1, 2], [1]).mrr).toBeLessThan(1);
  });
});

describe('sweepThresholds', () => {
  it('shows how many answerable questions pass and how many unanswerable ones are refused', () => {
    const points = sweepThresholds(
      [0.9, 0.7, 0.6, null],
      [0.5, 0.65, 0.8, null],
      [0.55, 0.65, 0.75],
    );

    expect(points).toEqual([
      { threshold: 0.55, answered: 0.75, refused: 0.5 },
      { threshold: 0.65, answered: 0.5, refused: 0.5 },
      { threshold: 0.75, answered: 0.25, refused: 0.75 },
    ]);
  });

  it('counts a score exactly at the threshold as passing, like the application does', () => {
    const [point] = sweepThresholds([0.65], [0.65], [0.65]);

    expect(point).toEqual({ threshold: 0.65, answered: 1, refused: 0 });
  });
});

describe('isRelevant', () => {
  const expected = [{ file: 'a.txt', quote: 'the quick brown fox' }];
  const hit = (overrides: Partial<EvalHit> = {}): EvalHit => ({
    filename: 'a.txt',
    page: null,
    content: 'Once, the quick   brown\nfox jumped.',
    ...overrides,
  });

  it('needs the quote in a passage of the right file, ignoring line breaks and spacing', () => {
    expect(isRelevant(hit(), expected)).toBe(true);
    expect(isRelevant(hit({ filename: 'b.txt' }), expected)).toBe(false);
    expect(isRelevant(hit({ content: 'the slow brown fox' }), expected)).toBe(false);
  });

  it('accepts any of several expected places', () => {
    const several = [...expected, { file: 'c.txt', quote: 'jumped over the dog' }];

    expect(isRelevant(hit({ filename: 'c.txt', content: 'it jumped over the dog' }), several)).toBe(
      true,
    );
  });
});

describe('evaluateRetrieval', () => {
  const golden = parseGoldenSet({
    version: 1,
    description: 'test',
    questions: [
      {
        id: 'direct',
        type: 'answerable',
        question: 'Where is the fox?',
        expected: [{ file: 'a.txt', quote: 'the fox lives here' }],
        answer: 'Here.',
      },
      {
        id: 'late',
        type: 'answerable',
        question: 'Where is the dog?',
        expected: [{ file: 'a.txt', quote: 'the dog sleeps here' }],
        answer: 'Here.',
      },
      {
        id: 'follow',
        type: 'answerable',
        question: 'And where does it sleep?',
        history: [
          { role: 'user', content: 'Tell me about the dog.' },
          { role: 'assistant', content: 'It is a dog.' },
        ],
        expected: [{ file: 'a.txt', quote: 'the dog sleeps here' }],
        answer: 'Here.',
      },
      {
        id: 'none',
        type: 'unanswerable',
        question: 'What is the capital of Peru?',
        note: 'off topic',
        absentTerms: ['Lima'],
        hard: true,
      },
    ],
  });

  const hit = (content: string): EvalHit => ({ filename: 'a.txt', page: null, content });
  const filler = (n: number) => Array.from({ length: n }, (_, i) => hit(`filler ${i}`));

  function fakeSearcher(rewriteTo = 'where does the dog sleep') {
    const rewrite = vi.fn(async () => ({ query: rewriteTo, rewritten: true }));
    const calls: Array<[Variant, string]> = [];
    const searcher: Searcher = {
      rewrite,
      async search(variant, query) {
        calls.push([variant, query]);
        const bestScore = variant === 'hybrid' ? (query.includes('Peru') ? 0.55 : 0.8) : null;
        if (query.includes('fox'))
          return { hits: [hit('the fox lives here'), ...filler(5)], bestScore };
        if (query.includes('dog') && variant === 'vector') return { hits: filler(6), bestScore };
        if (query.includes('dog'))
          return { hits: [...filler(3), hit('the dog sleeps here')], bestScore };
        return { hits: filler(6), bestScore };
      },
    };
    return { searcher, rewrite, calls };
  }

  it('ranks the first relevant passage per variant and counts only what is inside the cutoff', async () => {
    const { searcher } = fakeSearcher();

    const report = await evaluateRetrieval({ golden, searcher });

    const byId = Object.fromEntries(report.rows.map((row) => [row.id, row]));
    expect(byId.direct!.ranks).toEqual({ hybrid: 1, vector: 1, keyword: 1 });
    expect(byId.late!.ranks).toEqual({ hybrid: 4, vector: null, keyword: 4 });
  });

  it('ignores relevant passages beyond the cutoff', async () => {
    const { searcher } = fakeSearcher();

    const report = await evaluateRetrieval({ golden, searcher, cutoff: 3 });

    expect(report.rows.find((row) => row.id === 'late')!.ranks.hybrid).toBeNull();
  });

  it('rewrites follow-ups only, and searches with the rewritten query', async () => {
    const { searcher, rewrite, calls } = fakeSearcher();

    const report = await evaluateRetrieval({ golden, searcher });

    expect(rewrite).toHaveBeenCalledTimes(1);
    expect(rewrite).toHaveBeenCalledWith(golden.questions[2]!.history, 'And where does it sleep?');
    const follow = report.rows.find((row) => row.id === 'follow')!;
    expect(follow).toMatchObject({
      followUp: true,
      rewritten: true,
      query: 'where does the dog sleep',
    });
    expect(calls.some(([, query]) => query === 'And where does it sleep?')).toBe(false);
  });

  it('searches follow-ups as written when rewriting is switched off', async () => {
    const { searcher, rewrite } = fakeSearcher();

    const report = await evaluateRetrieval({ golden, searcher, rewrite: false });

    expect(rewrite).not.toHaveBeenCalled();
    expect(report.rows.find((row) => row.id === 'follow')!.query).toBe('And where does it sleep?');
    expect(report.rewrite).toBe(false);
  });

  it('summarises all questions, standalone ones and follow-ups separately', async () => {
    const { searcher } = fakeSearcher();

    const { summary } = await evaluateRetrieval({ golden, searcher });

    expect(summary.all.hybrid.questions).toBe(3);
    expect(summary.standalone.hybrid.questions).toBe(2);
    expect(summary.followUps.hybrid.questions).toBe(1);
    expect(summary.all.vector.hitAt[6]).toBeCloseTo(1 / 3);
  });

  it('keeps the unanswerable questions out of the retrieval figures and scores them for the threshold', async () => {
    const { searcher } = fakeSearcher();

    const report = await evaluateRetrieval({ golden, searcher, thresholds: [0.65] });

    expect(report.unanswerable).toEqual([
      {
        id: 'none',
        question: 'What is the capital of Peru?',
        query: 'What is the capital of Peru?',
        hard: true,
        bestScore: 0.55,
      },
    ]);
    expect(report.thresholds).toEqual([{ threshold: 0.65, answered: 1, refused: 1 }]);
  });

  it('reports progress after every question', async () => {
    const { searcher } = fakeSearcher();
    const progress: Array<[number, number, string]> = [];

    await evaluateRetrieval({
      golden,
      searcher,
      onProgress: (d, t, id) => progress.push([d, t, id]),
    });

    expect(progress.map(([done]) => done)).toEqual([1, 2, 3, 4]);
    expect(progress.at(-1)).toEqual([4, 4, 'none']);
  });

  describe('as text', () => {
    it('lists the misses, the threshold table with the current one marked, and the closest refusals', async () => {
      const { searcher } = fakeSearcher();
      const report = await evaluateRetrieval({ golden, searcher, cutoff: 3 });

      const text = formatRetrievalReport(report, 0.65);

      expect(text).toContain('top 3 passages, with query rewriting');
      expect(text).toContain('Hybrid misses (2)');
      expect(text).toContain('late: "Where is the dog?"');
      expect(text).toMatch(/0\.650 .*<- current/);
      expect(text).toContain('0.550  none (hard)');
      expect(text).toContain('all answerable (3)');
      expect(text).toContain('follow-ups (1)');
    });
  });
});

describe('findUncoveredQuotes', () => {
  const set = parseGoldenSet({
    version: 1,
    description: 't',
    questions: [
      {
        id: 'whole',
        type: 'answerable',
        question: 'Where is the fox?',
        expected: [{ file: 'a.txt', quote: 'the fox lives here' }],
        answer: 'x',
      },
      {
        id: 'cut',
        type: 'answerable',
        question: 'Where is the dog?',
        expected: [{ file: 'a.txt', quote: 'the dog sleeps right here' }],
        answer: 'x',
      },
      {
        id: 'other-place',
        type: 'answerable',
        question: 'Where is the cat?',
        expected: [
          { file: 'a.txt', quote: 'the cat is missing' },
          { file: 'b.txt', quote: 'the cat sits there' },
        ],
        answer: 'x',
      },
      {
        id: 'none',
        type: 'unanswerable',
        question: 'What about Peru?',
        note: 'n',
        absentTerms: ['Lima'],
      },
    ],
  });

  it('lists the questions whose quote is cut by a chunk boundary, and only those', () => {
    const passages = new Map([
      ['a.txt', ['intro the fox lives here', 'the dog sleeps', 'right here today']],
      ['b.txt', ['and the cat sits  there']],
    ]);

    expect(findUncoveredQuotes(set, passages)).toEqual([
      { id: 'cut', file: 'a.txt', quote: 'the dog sleeps right here' },
    ]);
  });

  it('counts a document that was not indexed as uncovered', () => {
    expect(findUncoveredQuotes(set, new Map()).map((item) => item.id)).toEqual([
      'whole',
      'cut',
      'other-place',
    ]);
  });

  it('holds for the real corpus and the real chunker: every golden quote is whole inside one passage', async () => {
    const root = join(import.meta.dirname, '../../..');
    const samples = join(root, 'samples');
    const passages = new Map<string, string[]>();
    for (const file of listSampleFiles(samples)) {
      const extracted = await extractText(detectFileType(file)!, readFileSync(join(samples, file)));
      passages.set(
        file,
        chunkSegments(extracted.segments).map((chunk) => chunk.content),
      );
    }

    const golden = loadGoldenSet(join(root, 'scripts/eval/golden.json'));

    expect(findUncoveredQuotes(golden, passages)).toEqual([]);
  });
});

describe('recommendThreshold', () => {
  const point = (threshold: number, answered: number, refused: number) => ({
    threshold,
    answered,
    refused,
  });

  it('is nothing without points', () => {
    expect(recommendThreshold([])).toBeNull();
  });

  it('picks the strictest cut-off that still answers nearly every answerable question', () => {
    const result = recommendThreshold([
      point(0.3, 1, 0),
      point(0.4, 1, 0.5),
      point(0.5, 0.96, 0.9),
      point(0.6, 0.5, 1),
      point(0.7, 0, 1),
    ]);

    expect(result).toEqual({ threshold: 0.5, answered: 0.96, refused: 0.9 });
  });

  it('does not trade answerable questions for refusals, even when that scores well', () => {
    const result = recommendThreshold([
      point(0.6, 1, 0),
      point(0.65, 0.92, 0),
      point(0.7, 0.47, 1),
    ]);

    expect(result).toEqual({ threshold: 0.6, answered: 1, refused: 0 });
  });

  it('takes the highest cut-off when several refuse equally many', () => {
    const result = recommendThreshold([point(0.3, 1, 0.2), point(0.4, 1, 0.2), point(0.5, 1, 0.2)]);

    expect(result?.threshold).toBe(0.5);
  });

  it('falls back to the cut-offs that answer the most when none reaches the share', () => {
    const result = recommendThreshold([
      point(0.5, 0.9, 0.1),
      point(0.6, 0.9, 0.4),
      point(0.7, 0.3, 1),
    ]);

    expect(result).toEqual({ threshold: 0.6, answered: 0.9, refused: 0.4 });
  });

  it('accepts another share to protect', () => {
    const points = [point(0.3, 1, 0), point(0.5, 0.8, 0.7), point(0.7, 0.2, 1)];

    expect(recommendThreshold(points)?.threshold).toBe(0.3);
    expect(recommendThreshold(points, 0.8)?.threshold).toBe(0.5);
  });

  it('works on a real sweep', () => {
    const points = sweepThresholds(
      [0.8, 0.7, 0.65, 0.55],
      [0.4, 0.35, 0.5],
      [0.3, 0.45, 0.6, 0.75],
    );

    expect(recommendThreshold(points)).toMatchObject({ threshold: 0.45, answered: 1 });
    expect(recommendThreshold(points)!.refused).toBeCloseTo(2 / 3);
  });
});
