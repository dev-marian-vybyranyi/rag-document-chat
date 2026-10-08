import { describe, expect, it, vi } from 'vitest';
import { NO_ANSWER_PREFIX } from '../src/rag/prompt.js';
import {
  classify,
  evaluateFaithfulness,
  summarizeFaithfulness,
  type AskedAnswer,
  type Asker,
} from '../src/eval/faithfulness-eval.js';
import { formatFaithfulnessReport } from '../src/eval/faithfulness-report.js';
import { parseGoldenSet } from '../src/eval/golden.js';
import type { Judge, JudgeVerdict } from '../src/eval/judge.js';

const golden = parseGoldenSet({
  version: 1,
  description: 't',
  questions: [
    {
      id: 'good',
      type: 'answerable',
      question: 'Which roles exist?',
      expected: [{ file: 'a.txt', quote: 'a quote long enough' }],
      answer: 'Four.',
    },
    {
      id: 'shaky',
      type: 'answerable',
      question: 'What about the second?',
      expected: [{ file: 'a.txt', quote: 'another quote long enough' }],
      answer: 'Two.',
    },
    {
      id: 'wrongly-refused',
      type: 'answerable',
      question: 'Where is the third one?',
      expected: [{ file: 'a.txt', quote: 'yet another quote enough' }],
      answer: 'There.',
    },
    {
      id: 'broken',
      type: 'answerable',
      question: 'Does this one fail?',
      expected: [{ file: 'a.txt', quote: 'a fourth quote long enough' }],
      answer: 'Yes.',
    },
    {
      id: 'off-topic',
      type: 'unanswerable',
      question: 'What is the capital of Peru?',
      note: 'n',
      absentTerms: ['Lima'],
    },
    {
      id: 'invented',
      type: 'unanswerable',
      question: 'How many votes did it get?',
      note: 'n',
      absentTerms: ['votes'],
      hard: true,
    },
    {
      id: 'refused-politely',
      type: 'unanswerable',
      question: 'How much does it cost?',
      note: 'n',
      absentTerms: ['cost'],
      hard: true,
    },
  ],
});

const source = { id: 1, filename: 'a.txt', page: null, content: 'text' };
const answered = (text: string): AskedAnswer => ({
  text,
  sources: [source],
  declined: false,
  error: null,
});

const verdicts: Record<string, JudgeVerdict> = {
  good: {
    claims: [
      { claim: 'a', supported: true, citationCorrect: true },
      { claim: 'b', supported: true, citationCorrect: true },
    ],
    correctness: 'correct',
    notes: 'ok',
  },
  shaky: {
    claims: [
      { claim: 'a', supported: true, citationCorrect: false },
      { claim: 'b', supported: false, citationCorrect: null },
    ],
    correctness: 'partial',
    notes: 'second claim invented',
  },
  invented: {
    claims: [{ claim: 'a vote count', supported: false, citationCorrect: false }],
    correctness: 'incorrect',
    notes: 'made up',
  },
};

function fakes(overrides: { judgeFails?: string[] } = {}) {
  const answers: Record<string, AskedAnswer> = {
    good: answered('Four [1].'),
    shaky: answered('Two [1].'),
    'wrongly-refused': { text: 'Not found.', sources: [], declined: true, error: null },
    broken: { text: '', sources: [], declined: false, error: 'The AI model is overloaded.' },
    'off-topic': { text: 'x', sources: [], declined: true, error: null },
    invented: answered('It got 12 votes [1].'),
    'refused-politely': answered(`${NO_ANSWER_PREFIX} Try rephrasing.`),
  };
  const asker: Asker = { ask: vi.fn(async (question) => answers[question.id]!) };
  const judge: Judge = {
    judge: vi.fn(async (input) => {
      const id = golden.questions.find((q) => q.question === input.question)!.id;
      if (overrides.judgeFails?.includes(id)) throw new Error('judge unavailable');
      return verdicts[id]!;
    }),
  };
  return { asker, judge };
}

describe('classify', () => {
  it.each([
    [answered('Four [1].'), 'answered'],
    [{ ...answered(''), declined: true }, 'declined'],
    [answered(`  ${NO_ANSWER_PREFIX} Try again.`), 'refused'],
    [{ ...answered('x'), error: 'busy' }, 'failed'],
  ] as const)('sorts %j into %s', (asked, outcome) => {
    expect(classify(asked)).toBe(outcome);
  });

  it('calls a failure a failure even when some text arrived', () => {
    expect(classify({ ...answered('half an ans'), error: 'cut off' })).toBe('failed');
  });
});

describe('evaluateFaithfulness', () => {
  it('judges only the answers that were given, with the reference only for answerable questions', async () => {
    const { asker, judge } = fakes();

    const rows = await evaluateFaithfulness({ golden, asker, judge });

    expect(rows.map((row) => [row.id, row.outcome])).toEqual([
      ['good', 'answered'],
      ['shaky', 'answered'],
      ['wrongly-refused', 'declined'],
      ['broken', 'failed'],
      ['off-topic', 'declined'],
      ['invented', 'answered'],
      ['refused-politely', 'refused'],
    ]);
    expect(judge.judge).toHaveBeenCalledTimes(3);
    const references = vi.mocked(judge.judge).mock.calls.map(([input]) => input.reference);
    expect(references).toEqual(['Four.', 'Two.', null]);
  });

  it('gives the judge the sources that the system had, numbered as in the answer', async () => {
    const { asker, judge } = fakes();

    await evaluateFaithfulness({ golden, asker, judge });

    expect(vi.mocked(judge.judge).mock.calls[0]![0]).toMatchObject({
      question: 'Which roles exist?',
      answer: 'Four [1].',
      sources: [source],
    });
  });

  it('keeps going when the judge fails, and records why', async () => {
    const { asker, judge } = fakes({ judgeFails: ['shaky'] });

    const rows = await evaluateFaithfulness({ golden, asker, judge });

    const shaky = rows.find((row) => row.id === 'shaky')!;
    expect(shaky).toMatchObject({
      outcome: 'answered',
      verdict: null,
      judgeError: 'judge unavailable',
    });
    expect(rows.find((row) => row.id === 'invented')!.verdict).not.toBeNull();
  });

  it('can be limited to some questions and reports progress', async () => {
    const { asker, judge } = fakes();
    const seen: string[] = [];

    const rows = await evaluateFaithfulness({
      golden,
      asker,
      judge,
      only: (question) => question.type === 'unanswerable',
      onProgress: ({ done, total, id }) => seen.push(`${done}/${total} ${id}`),
    });

    expect(rows).toHaveLength(3);
    expect(seen).toEqual(['1/3 off-topic', '2/3 invented', '3/3 refused-politely']);
  });

  it('marks the hard unanswerable questions', async () => {
    const { asker, judge } = fakes();

    const rows = await evaluateFaithfulness({ golden, asker, judge });

    expect(rows.filter((row) => row.hard).map((row) => row.id)).toEqual([
      'invented',
      'refused-politely',
    ]);
  });
});

describe('summarizeFaithfulness', () => {
  async function summary(overrides?: Parameters<typeof fakes>[0]) {
    const { asker, judge } = fakes(overrides);
    const rows = await evaluateFaithfulness({ golden, asker, judge });
    return { rows, summary: summarizeFaithfulness(rows) };
  }

  it('counts what happened to the answerable questions', async () => {
    const { summary: s } = await summary();

    expect(s.answerable).toMatchObject({
      questions: 4,
      answered: 2,
      declinedByThreshold: 1,
      refusedByModel: 0,
      failed: 1,
      unjudged: 0,
    });
  });

  it('pools claims across answers: supported over all claims, not an average of averages', async () => {
    const { summary: s } = await summary();

    expect(s.answerable.claims).toBe(4);
    expect(s.answerable.supportedClaims).toBe(3);
    expect(s.answerable.faithfulness).toBeCloseTo(0.75);
    expect(s.answerable.fullyFaithful).toBe(1);
  });

  it('measures how often a citation really supports its claim', async () => {
    const { summary: s } = await summary();

    expect(s.answerable.citedClaims).toBe(3);
    expect(s.answerable.correctCitations).toBe(2);
    expect(s.answerable.citationAccuracy).toBeCloseTo(2 / 3);
  });

  it('counts the grades against the reference', async () => {
    const { summary: s } = await summary();

    expect([s.answerable.correct, s.answerable.partial, s.answerable.incorrect]).toEqual([1, 1, 0]);
  });

  it('separates the unanswerable questions that were refused from those that were answered', async () => {
    const { summary: s } = await summary();

    expect(s.unanswerable).toEqual({
      questions: 3,
      declinedByThreshold: 1,
      refusedByModel: 1,
      answered: 1,
      answeredWithUnsupportedClaims: 1,
      failed: 0,
      hardQuestions: 2,
      hardRefused: 1,
    });
  });

  it('reports a missing judgement instead of counting the answer as faithful', async () => {
    const { summary: s } = await summary({ judgeFails: ['good'] });

    expect(s.answerable.unjudged).toBe(1);
    expect(s.answerable.claims).toBe(2);
  });

  it('has no faithfulness figure when nothing was judged', () => {
    const s = summarizeFaithfulness([]);

    expect(s.answerable.faithfulness).toBeNull();
    expect(s.answerable.citationAccuracy).toBeNull();
  });
});

describe('formatFaithfulnessReport', () => {
  it('shows the figures and lists the questions that need a look', async () => {
    const { asker, judge } = fakes();
    const rows = await evaluateFaithfulness({ golden, asker, judge });

    const text = formatFaithfulnessReport(summarizeFaithfulness(rows), rows);

    expect(text).toContain('Answerable questions (4)');
    expect(text).toMatch(/faithfulness .* 75%/);
    expect(text).toMatch(/citation accuracy .* 67%/);
    expect(text).toContain('Unanswerable questions (3)');
    expect(text).toContain('hard ones refused             1/2');
    expect(text).toContain('shaky [answerable] partial; 1 unsupported; second claim invented');
    expect(text).toContain('wrongly-refused [answerable] declined');
    expect(text).toContain('broken [answerable] failed: The AI model is overloaded.');
    expect(text).toContain('invented [unanswerable] incorrect; 1 unsupported; made up');
    expect(text).not.toContain('good [answerable]');
    expect(text).not.toContain('off-topic [unanswerable]');
  });
});
