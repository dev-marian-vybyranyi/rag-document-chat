import { describe, expect, it } from 'vitest';
import {
  describeLines,
  describeLocation,
  describeMatch,
  describeSource,
  formatDuration,
  formatPercent,
  formatScoreAgainst,
} from './source-format';
import type { ChatSource } from './types';

const source = (page: number | null): ChatSource => ({
  id: 1,
  chunkId: 'k1',
  documentId: 'd1',
  filename: 'handbook.pdf',
  page,
  ordinal: 0,
  excerpt: '',
  score: null,
});

describe('describeSource', () => {
  it('names the page only when there is one', () => {
    expect(describeSource(source(4))).toBe('handbook.pdf, page 4');
    expect(describeSource(source(null))).toBe('handbook.pdf');
  });
});

describe('describeMatch', () => {
  it.each([
    [0.784, 'Similarity 78%'],
    [1, 'Similarity 100%'],
    [0, 'Similarity 0%'],
    [null, 'Found by keyword match'],
  ])('describes %s as %s', (score, text) => {
    expect(describeMatch(score)).toBe(text);
  });
});

describe('formatPercent', () => {
  it.each([
    [0.784, '78%'],
    [0.785, '79%'],
    [0.995, '100%'],
    [0, '0%'],
  ])('writes %s as %s', (score, text) => {
    expect(formatPercent(score)).toBe(text);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0 ms'],
    [0.4, '0 ms'],
    [142.4, '142 ms'],
    [999.4, '999 ms'],
    [999.6, '1.0 s'],
    [1000, '1.0 s'],
    [1234, '1.2 s'],
    [12_500, '12.5 s'],
  ])('writes %s ms as %s, never as 1000 ms', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('formatScoreAgainst', () => {
  it('uses whole percents when they tell the two numbers apart', () => {
    expect(formatScoreAgainst(0.78, 0.65)).toEqual(['78%', '65%']);
    expect(formatScoreAgainst(0.5, 0.65)).toEqual(['50%', '65%']);
  });

  it('shows a decimal when rounding would make a miss look like a tie', () => {
    expect(formatScoreAgainst(0.649, 0.65)).toEqual(['64.9%', '65.0%']);
    expect(formatScoreAgainst(0.654, 0.65)).toEqual(['65.4%', '65.0%']);
  });

  it('keeps whole percents when the numbers really are equal', () => {
    expect(formatScoreAgainst(0.65, 0.65)).toEqual(['65%', '65%']);
  });
});

describe('describing a file passage', () => {
  const code = (overrides = {}) => ({
    path: 'src/auth/login.ts',
    language: 'typescript',
    startLine: 12,
    endLine: 18,
    symbol: 'login',
    ...overrides,
  });
  const withCode = (overrides = {}): ChatSource => ({ ...source(null), code: code(overrides) });

  it('gives the path and the lines of a file', () => {
    expect(describeSource(withCode())).toBe('src/auth/login.ts:12-18');
  });

  it('gives one line once, and no lines when they are not known', () => {
    expect(describeSource(withCode({ startLine: 5, endLine: 5 }))).toBe('src/auth/login.ts:5');
    expect(describeSource(withCode({ startLine: null, endLine: null }))).toBe('src/auth/login.ts');
  });

  it('calls the generated summary an overview of the repository', () => {
    const overview = {
      ...source(null),
      filename: 'acme/shop',
      code: code({ path: 'REPOSITORY_OVERVIEW' }),
    };

    expect(describeSource(overview)).toBe('Overview of acme/shop');
  });

  it('still names a document by its page', () => {
    expect(describeLocation({ filename: 'a.pdf', page: 3 })).toBe('a.pdf, page 3');
    expect(describeLocation({ filename: 'a.txt', page: null })).toBe('a.txt');
  });

  it('describes lines on their own', () => {
    expect(describeLines(code())).toBe('12-18');
    expect(describeLines(code({ startLine: 3, endLine: 3 }))).toBe('3');
    expect(describeLines(code({ startLine: null }))).toBeNull();
  });
});
