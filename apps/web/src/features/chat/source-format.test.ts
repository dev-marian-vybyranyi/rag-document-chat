import { describe, expect, it } from 'vitest';
import {
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
