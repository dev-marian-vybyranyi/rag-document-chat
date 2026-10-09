import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { containsQuote, loadGoldenSet, type AnswerableQuestion } from '../src/eval/golden.js';
import {
  isReferenceFile,
  REFERENCE_ADDRESS,
  REFERENCE_REPOSITORY,
  selectReferenceFiles,
} from '../src/eval/reference-repository.js';

const root = join(import.meta.dirname, '../../..');
const sources = readFileSync(join(root, 'samples/SOURCES.md'), 'utf8');
const golden = loadGoldenSet(join(root, 'scripts/eval/golden-code.json'));

const answerable = golden.questions.filter((q): q is AnswerableQuestion => q.type === 'answerable');
const unanswerable = golden.questions.filter((q) => q.type === 'unanswerable');

describe('the reference repository', () => {
  it('is pinned to a full commit, never a branch', () => {
    expect(REFERENCE_REPOSITORY.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(REFERENCE_ADDRESS).toBe(
      `https://github.com/koajs/koa/tree/${REFERENCE_REPOSITORY.commit}`,
    );
  });

  it('is described in SOURCES.md with the same commit and its licence', () => {
    expect(sources).toContain(REFERENCE_REPOSITORY.commit);
    expect(sources).toContain('https://github.com/koajs/koa');
    expect(sources).toMatch(/MIT/);
  });

  it('is cut down to the files that questions are about', () => {
    const files = [
      'LICENSE',
      'Readme.md',
      'package.json',
      'History.md',
      'AUTHORS',
      'lib/application.js',
      'lib/context.js',
      'lib/nested/deep.js',
      'lib/readme.txt',
      'docs/guide.md',
      'docs/error-handling.md',
      'docs/faq.md',
      'docs/api/context.md',
      '__tests__/application/use.test.js',
      'test-helpers/context.js',
      'package-lock.json',
    ].map((path) => ({ path }));

    expect(selectReferenceFiles(files).map((f) => f.path)).toEqual([
      'LICENSE',
      'Readme.md',
      'package.json',
      'lib/application.js',
      'lib/context.js',
      'docs/guide.md',
      'docs/error-handling.md',
    ]);
  });

  it('keeps every library file, and nothing from the tests', () => {
    expect(isReferenceFile('lib/search-params.js')).toBe(true);
    expect(isReferenceFile('lib/is-stream.js')).toBe(true);
    expect(isReferenceFile('__tests__/lib/response.js')).toBe(false);
    expect(isReferenceFile('lib/../package.json')).toBe(false);
  });
});

describe('the golden question set for code', () => {
  it('has enough questions of each kind', () => {
    expect(answerable.length).toBeGreaterThanOrEqual(30);
    expect(unanswerable.length).toBeGreaterThanOrEqual(5);
    expect(answerable.filter((q) => q.history).length).toBeGreaterThanOrEqual(2);
    expect(unanswerable.filter((q) => q.type === 'unanswerable' && q.hard).length).toBeGreaterThan(
      0,
    );
  });

  it('asks several questions about every part of the library that carries logic', () => {
    for (const file of [
      'lib/application.js',
      'lib/context.js',
      'lib/request.js',
      'lib/response.js',
    ]) {
      const asked = answerable.filter((q) => q.expected.some((e) => e.file === file));
      expect(asked.length, file).toBeGreaterThanOrEqual(4);
    }
    for (const file of ['docs/guide.md', 'docs/error-handling.md', 'package.json']) {
      expect(
        answerable.some((q) => q.expected.some((e) => e.file === file)),
        file,
      ).toBe(true);
    }
  });

  it('does not ask the same question twice', () => {
    const questions = golden.questions.map((q) => q.question.toLowerCase());

    expect(new Set(questions).size).toBe(questions.length);
  });

  describe.each(answerable.map((q) => [q.id, q] as const))('%s', (_id, question) => {
    it('points at a file that the evaluation indexes, by its path in the repository', () => {
      for (const expected of question.expected) {
        expect(isReferenceFile(expected.file), expected.file).toBe(true);
        expect(expected.page, 'code has no pages').toBeUndefined();
      }
    });

    it('does not give away the answer in the question', () => {
      for (const expected of question.expected) {
        expect(containsQuote(question.question, expected.quote)).toBe(false);
      }
    });
  });
});
