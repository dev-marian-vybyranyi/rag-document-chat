import { describe, expect, it } from 'vitest';
import type { RetrievedChunk } from '../src/rag/fusion.js';
import {
  assessRelevance,
  DEFAULT_RELEVANCE_THRESHOLD,
  relevanceThresholds,
} from '../src/rag/relevance.js';

function chunk(vectorScore: number | null): RetrievedChunk {
  return { chunkId: 'c', vectorScore, score: 0.03 } as RetrievedChunk;
}

describe('assessRelevance', () => {
  it('declines when nothing was found', () => {
    expect(assessRelevance([], 'hybrid')).toEqual({
      relevant: false,
      bestScore: null,
      threshold: 0.65,
    });
    expect(assessRelevance([], 'keyword-only')).toEqual({
      relevant: false,
      bestScore: null,
      threshold: 0.65,
    });
  });

  it('accepts when the best passage reaches the threshold', () => {
    expect(assessRelevance([chunk(0.5), chunk(0.7)], 'hybrid', 0.65)).toEqual({
      relevant: true,
      bestScore: 0.7,
      threshold: 0.65,
    });
  });

  it('accepts a score exactly at the threshold', () => {
    expect(assessRelevance([chunk(0.65)], 'hybrid', 0.65).relevant).toBe(true);
  });

  it('declines when even the best passage is below the threshold', () => {
    expect(assessRelevance([chunk(0.5), chunk(0.64)], 'hybrid', 0.65)).toEqual({
      relevant: false,
      bestScore: 0.64,
      threshold: 0.65,
    });
  });

  it('ignores passages that only keyword search found', () => {
    expect(assessRelevance([chunk(null), chunk(0.7)], 'hybrid', 0.65).bestScore).toBe(0.7);
  });

  it('declines in hybrid mode when no passage has a similarity at all', () => {
    expect(assessRelevance([chunk(null)], 'hybrid')).toEqual({
      relevant: false,
      bestScore: null,
      threshold: 0.65,
    });
  });

  it('cannot judge by similarity in keyword-only mode and lets the model decide', () => {
    expect(assessRelevance([chunk(null)], 'keyword-only', 0.99)).toEqual({
      relevant: true,
      bestScore: null,
      threshold: 0.99,
    });
  });

  it('uses 0.65 unless told otherwise', () => {
    expect(DEFAULT_RELEVANCE_THRESHOLD).toBe(0.65);
    expect(assessRelevance([chunk(0.66)], 'hybrid').relevant).toBe(true);
    expect(assessRelevance([chunk(0.64)], 'hybrid').relevant).toBe(false);
  });
});

describe('assessRelevance with a threshold for each kind of source', () => {
  const thresholds = { document: 0.65, code: 0.5 };
  const file = (vectorScore: number | null) =>
    ({
      chunkId: 'f',
      vectorScore,
      score: 0.03,
      code: { path: 'a.ts', language: 'typescript', startLine: 1, endLine: 2, symbol: null },
    }) as RetrievedChunk;

  it('judges a file passage by the code threshold', () => {
    expect(assessRelevance([file(0.55)], 'hybrid', thresholds)).toEqual({
      relevant: true,
      bestScore: 0.55,
      threshold: 0.5,
    });
    expect(assessRelevance([file(0.45)], 'hybrid', thresholds)).toEqual({
      relevant: false,
      bestScore: 0.45,
      threshold: 0.5,
    });
  });

  it('judges a document passage by the document threshold', () => {
    expect(assessRelevance([chunk(0.55)], 'hybrid', thresholds)).toEqual({
      relevant: false,
      bestScore: 0.55,
      threshold: 0.65,
    });
  });

  it('accepts when either kind passes its own threshold', () => {
    expect(assessRelevance([chunk(0.6), file(0.52)], 'hybrid', thresholds).relevant).toBe(true);
    expect(assessRelevance([chunk(0.7), file(0.4)], 'hybrid', thresholds).relevant).toBe(true);
  });

  it('declines when neither kind passes', () => {
    expect(assessRelevance([chunk(0.6), file(0.45)], 'hybrid', thresholds).relevant).toBe(false);
  });

  it('reports the score and threshold of the passage that came closest to passing', () => {
    expect(assessRelevance([chunk(0.7), file(0.62)], 'hybrid', thresholds)).toMatchObject({
      bestScore: 0.62,
      threshold: 0.5,
    });
    expect(assessRelevance([chunk(0.6), file(0.45)], 'hybrid', thresholds)).toMatchObject({
      bestScore: 0.45,
      threshold: 0.5,
    });
  });

  it('treats a single number as the threshold for both kinds', () => {
    expect(assessRelevance([file(0.6)], 'hybrid', 0.7).relevant).toBe(false);
    expect(assessRelevance([file(0.7)], 'hybrid', 0.7).relevant).toBe(true);
  });

  it('still lets the model decide in keyword-only mode', () => {
    expect(assessRelevance([file(null)], 'keyword-only', thresholds).relevant).toBe(true);
  });
});

describe('relevanceThresholds', () => {
  it('uses the document threshold for code until a code threshold is set', () => {
    expect(relevanceThresholds({ RELEVANCE_THRESHOLD: 0.3 })).toEqual({ document: 0.3, code: 0.3 });
  });

  it('uses the code threshold when one is set, even a low one', () => {
    expect(relevanceThresholds({ RELEVANCE_THRESHOLD: 0.65, CODE_RELEVANCE_THRESHOLD: 0 })).toEqual(
      {
        document: 0.65,
        code: 0,
      },
    );
  });
});
