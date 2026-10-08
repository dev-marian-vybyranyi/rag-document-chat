import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractText, type ExtractedText } from '../src/documents/extract.js';
import { detectFileType } from '../src/documents/file-types.js';
import {
  containsQuote,
  containsWord,
  loadGoldenSet,
  parseGoldenSet,
  type AnswerableQuestion,
} from '../src/eval/golden.js';

const root = join(import.meta.dirname, '../../..');
const samplesDir = join(root, 'samples');
const golden = loadGoldenSet(join(root, 'scripts/eval/golden.json'));

const sampleFiles = readdirSync(samplesDir).filter(
  (name) => statSync(join(samplesDir, name)).isFile() && name !== 'SOURCES.md',
);

const extracted = new Map<string, ExtractedText>();
async function textOf(file: string): Promise<ExtractedText> {
  const cached = extracted.get(file);
  if (cached) return cached;
  const result = await extractText(detectFileType(file)!, readFileSync(join(samplesDir, file)));
  extracted.set(file, result);
  return result;
}

const answerable = golden.questions.filter((q): q is AnswerableQuestion => q.type === 'answerable');
const unanswerable = golden.questions.filter((q) => q.type === 'unanswerable');

describe('the golden question set', () => {
  it('has enough questions of each kind', () => {
    expect(answerable.length).toBeGreaterThanOrEqual(40);
    expect(unanswerable.length).toBeGreaterThanOrEqual(8);
    expect(answerable.filter((q) => q.history).length).toBeGreaterThanOrEqual(4);
    expect(unanswerable.filter((q) => q.type === 'unanswerable' && q.hard).length).toBeGreaterThan(
      0,
    );
  });

  it('asks at least five questions about every document in the corpus', () => {
    for (const file of sampleFiles) {
      const asked = answerable.filter((q) => q.expected.some((e) => e.file === file));
      expect(asked.length, file).toBeGreaterThanOrEqual(5);
    }
  });

  it('does not ask the same question twice', () => {
    const questions = golden.questions.map((q) => q.question.toLowerCase());

    expect(new Set(questions).size).toBe(questions.length);
  });

  describe.each(answerable.map((q) => [q.id, q] as const))('%s', (_id, question) => {
    it('points at passages that are really in the document, on the page it names', async () => {
      for (const expected of question.expected) {
        expect(sampleFiles, expected.file).toContain(expected.file);
        const { segments, pageCount } = await textOf(expected.file);
        const where = segments.filter((segment) => containsQuote(segment.text, expected.quote));

        expect(where.length, `"${expected.quote}" in ${expected.file}`).toBeGreaterThan(0);
        if (pageCount === null) {
          expect(expected.page, 'a text file has no pages').toBeUndefined();
        } else {
          expect(expected.page, 'a PDF quote needs its page').toBeDefined();
          expect(where.map((segment) => segment.page)).toContain(expected.page);
        }
      }
    });

    it('does not give away the answer in the question', () => {
      for (const expected of question.expected) {
        expect(containsQuote(question.question, expected.quote)).toBe(false);
      }
    });
  });

  describe.each(unanswerable.map((q) => [q.id, q] as const))('%s', (_id, question) => {
    it('is about something the corpus does not contain', async () => {
      if (question.type !== 'unanswerable') return;
      for (const file of sampleFiles) {
        const { segments } = await textOf(file);
        const text = segments.map((segment) => segment.text).join('\n');
        for (const term of question.absentTerms) {
          expect(containsWord(text, term), `"${term}" in ${file}`).toBe(false);
        }
      }
    });
  });
});

describe('parseGoldenSet', () => {
  const valid = {
    version: 1,
    description: 'd',
    questions: [
      {
        id: 'q-one',
        type: 'answerable',
        question: 'What is it?',
        expected: [{ file: 'a.txt', quote: 'a long enough quote here' }],
        answer: 'It is.',
      },
    ],
  };

  it('accepts a well-formed set', () => {
    expect(parseGoldenSet(valid).questions).toHaveLength(1);
  });

  it.each([
    ['a duplicate id', { ...valid, questions: [valid.questions[0], valid.questions[0]] }],
    [
      'an answerable question without a source',
      {
        ...valid,
        questions: [{ ...valid.questions[0], expected: [] }],
      },
    ],
    [
      'a quote too short to mean anything',
      {
        ...valid,
        questions: [{ ...valid.questions[0], expected: [{ file: 'a.txt', quote: 'short' }] }],
      },
    ],
    [
      'an id that is not a slug',
      { ...valid, questions: [{ ...valid.questions[0], id: 'Not A Slug' }] },
    ],
    ['an unknown type', { ...valid, questions: [{ ...valid.questions[0], type: 'maybe' }] }],
    [
      'an unanswerable question without terms to check',
      {
        ...valid,
        questions: [
          { id: 'u-one', type: 'unanswerable', question: 'Who knows?', note: 'n', absentTerms: [] },
        ],
      },
    ],
    ['a wrong version', { ...valid, version: 2 }],
  ])('rejects %s', (_name, json) => {
    expect(() => parseGoldenSet(json)).toThrow('Invalid golden set');
  });
});

describe('containsWord', () => {
  it('matches whole words only, ignoring case', () => {
    expect(containsWord('We compare things', 'pari')).toBe(false);
    expect(containsWord('Visit Paris today', 'paris')).toBe(true);
    expect(containsWord('async/await works', 'async')).toBe(true);
  });
});
