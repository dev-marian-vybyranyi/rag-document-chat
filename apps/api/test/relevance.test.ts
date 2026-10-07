import { describe, expect, it } from 'vitest';
import type { RetrievedChunk } from '../src/rag/fusion.js';
import { assessRelevance, DEFAULT_RELEVANCE_THRESHOLD } from '../src/rag/relevance.js';

function chunk(vectorScore: number | null): RetrievedChunk {
  return { chunkId: 'c', vectorScore, score: 0.03 } as RetrievedChunk;
}

describe('assessRelevance', () => {
  it('declines when nothing was found', () => {
    expect(assessRelevance([], 'hybrid')).toEqual({ relevant: false, bestScore: null });
    expect(assessRelevance([], 'keyword-only')).toEqual({ relevant: false, bestScore: null });
  });

  it('accepts when the best passage reaches the threshold', () => {
    expect(assessRelevance([chunk(0.5), chunk(0.7)], 'hybrid', 0.65)).toEqual({
      relevant: true,
      bestScore: 0.7,
    });
  });

  it('accepts a score exactly at the threshold', () => {
    expect(assessRelevance([chunk(0.65)], 'hybrid', 0.65).relevant).toBe(true);
  });

  it('declines when even the best passage is below the threshold', () => {
    expect(assessRelevance([chunk(0.5), chunk(0.64)], 'hybrid', 0.65)).toEqual({
      relevant: false,
      bestScore: 0.64,
    });
  });

  it('ignores passages that only keyword search found', () => {
    expect(assessRelevance([chunk(null), chunk(0.7)], 'hybrid', 0.65).bestScore).toBe(0.7);
  });

  it('declines in hybrid mode when no passage has a similarity at all', () => {
    expect(assessRelevance([chunk(null)], 'hybrid')).toEqual({ relevant: false, bestScore: null });
  });

  it('cannot judge by similarity in keyword-only mode and lets the model decide', () => {
    expect(assessRelevance([chunk(null)], 'keyword-only', 0.99)).toEqual({
      relevant: true,
      bestScore: null,
    });
  });

  it('uses 0.65 unless told otherwise', () => {
    expect(DEFAULT_RELEVANCE_THRESHOLD).toBe(0.65);
    expect(assessRelevance([chunk(0.66)], 'hybrid').relevant).toBe(true);
    expect(assessRelevance([chunk(0.64)], 'hybrid').relevant).toBe(false);
  });
});
