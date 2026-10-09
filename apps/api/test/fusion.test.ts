import { describe, expect, it } from 'vitest';
import { fuseRankings, RRF_K } from '../src/rag/fusion.js';
import type { RetrievalCandidate } from '../src/rag/retrieval.js';

function candidate(id: string, overrides: Partial<RetrievalCandidate> = {}): RetrievalCandidate {
  return {
    chunkId: id,
    documentId: 'doc-1',
    filename: 'notes.txt',
    ordinal: Number(id.replace(/\D/g, '')) || 0,
    page: null,
    content: `content of ${id}`,
    score: 0.5,
    ...overrides,
  };
}

const ids = (chunks: Array<{ chunkId: string }>) => chunks.map((c) => c.chunkId);

describe('fuseRankings', () => {
  it('scores a chunk by the reciprocal of its rank plus a constant, summed over the lists', () => {
    const fused = fuseRankings([candidate('a')], [candidate('a')], { limit: 5 });

    expect(fused[0]!.score).toBeCloseTo(2 / (RRF_K + 1), 10);
  });

  it('uses 1-based ranks', () => {
    const fused = fuseRankings([candidate('a'), candidate('b'), candidate('c')], [], { limit: 5 });

    expect(fused.map((c) => c.score)).toEqual([1 / 61, 1 / 62, 1 / 63]);
    expect(fused.map((c) => c.vectorRank)).toEqual([1, 2, 3]);
  });

  it('puts a chunk both methods found above one that only a single method found', () => {
    const vector = [candidate('only-vector'), candidate('both')];
    const keyword = [candidate('only-keyword'), candidate('both')];

    expect(ids(fuseRankings(vector, keyword, { limit: 5 }))).toEqual([
      'both',
      'only-vector',
      'only-keyword',
    ]);
  });

  it('lets a chunk ranked first by one method beat one that sits beyond rank 62 in both', () => {
    const filler = (prefix: string) =>
      Array.from({ length: 70 }, (_, i) => candidate(`${prefix}${i + 10}`));
    const vector = [candidate('top'), ...filler('v'), candidate('deep')];
    const keyword = [...filler('k'), candidate('deep')];

    const fused = fuseRankings(vector, keyword, { limit: 200 });

    expect(fused.findIndex((c) => c.chunkId === 'top')).toBeLessThan(
      fused.findIndex((c) => c.chunkId === 'deep'),
    );
  });

  it('adds up evidence: a chunk in the middle of both lists beats one that is first in only one', () => {
    const filler = (prefix: string) =>
      Array.from({ length: 30 }, (_, i) => candidate(`${prefix}${i + 10}`));
    const vector = [candidate('top'), ...filler('v'), candidate('middle')];
    const keyword = [...filler('k'), candidate('middle')];

    const fused = fuseRankings(vector, keyword, { limit: 100 });

    expect(fused.findIndex((c) => c.chunkId === 'middle')).toBeLessThan(
      fused.findIndex((c) => c.chunkId === 'top'),
    );
  });

  it('keeps the order of a single list when the other is empty', () => {
    const list = [candidate('a'), candidate('b'), candidate('c')];

    expect(ids(fuseRankings([], list, { limit: 5 }))).toEqual(['a', 'b', 'c']);
    expect(ids(fuseRankings(list, [], { limit: 5 }))).toEqual(['a', 'b', 'c']);
  });

  it('does not depend on the incomparable scales of the two methods', () => {
    const vector = [candidate('a', { score: 0.99 }), candidate('b', { score: 0.98 })];
    const keyword = [candidate('b', { score: 0.001 }), candidate('a', { score: 0.0005 })];

    const reversed = [candidate('b', { score: 500 }), candidate('a', { score: 400 })];

    expect(ids(fuseRankings(vector, keyword, { limit: 5 }))).toEqual(
      ids(fuseRankings(vector, reversed, { limit: 5 })),
    );
  });

  it('lists each chunk once and remembers what every method said about it', () => {
    const vector = [candidate('a', { score: 0.91 })];
    const keyword = [candidate('x'), candidate('a', { score: 0.4 })];

    const fused = fuseRankings(vector, keyword, { limit: 5 });

    expect(fused.filter((c) => c.chunkId === 'a')).toHaveLength(1);
    expect(fused.find((c) => c.chunkId === 'a')).toMatchObject({
      vectorScore: 0.91,
      vectorRank: 1,
      keywordScore: 0.4,
      keywordRank: 2,
    });
  });

  it('leaves the signal of a method that did not find the chunk empty', () => {
    const fused = fuseRankings([candidate('a')], [], { limit: 5 });

    expect(fused[0]).toMatchObject({ keywordScore: null, keywordRank: null });
  });

  it('keeps everything needed to cite the chunk', () => {
    const fused = fuseRankings(
      [
        candidate('a', {
          documentId: 'd9',
          filename: 'paper.pdf',
          ordinal: 7,
          page: 12,
          content: 'text',
        }),
      ],
      [],
      { limit: 1 },
    );

    expect(fused[0]).toMatchObject({
      documentId: 'd9',
      filename: 'paper.pdf',
      ordinal: 7,
      page: 12,
      content: 'text',
    });
  });

  it('returns at most the limit, and everything when there are fewer', () => {
    const list = Array.from({ length: 10 }, (_, i) => candidate(`c${i}`));

    expect(fuseRankings(list, [], { limit: 3 })).toHaveLength(3);
    expect(fuseRankings(list, [], { limit: 50 })).toHaveLength(10);
    expect(fuseRankings(list, [], { limit: 0 })).toEqual([]);
  });

  it('returns nothing when nothing was found', () => {
    expect(fuseRankings([], [], { limit: 5 })).toEqual([]);
  });

  describe('ties', () => {
    it('go to the chunk with the higher vector similarity', () => {
      const vector = [candidate('a', { score: 0.9 })];
      const keyword = [candidate('b', { score: 0.2 })];
      const vectorB = [candidate('x'), candidate('b', { score: 0.3 })];

      expect(ids(fuseRankings(vector, keyword, { limit: 5 }))).toEqual(['a', 'b']);
      expect(fuseRankings(vectorB, [], { limit: 5 }).map((c) => c.vectorScore)).toEqual([0.5, 0.3]);
    });

    it('fall back to document and position so the order is always the same', () => {
      const vector = [candidate('a', { documentId: 'd2', ordinal: 0, score: 0.5 })];
      const keyword = [candidate('b', { documentId: 'd1', ordinal: 3, score: 0.5 })];

      const first = fuseRankings(vector, keyword, { limit: 5 });
      const second = fuseRankings(vector, keyword, { limit: 5 });

      expect(ids(first)).toEqual(ids(second));
    });
  });

  it('can weight the top ranks more or less through k', () => {
    const vector = [candidate('a'), candidate('b')];

    const [sharp] = fuseRankings(vector, [], { limit: 2, k: 1 });
    const [flat] = fuseRankings(vector, [], { limit: 2, k: 1000 });

    expect(sharp!.score).toBeCloseTo(1 / 2, 10);
    expect(flat!.score).toBeCloseTo(1 / 1001, 10);
  });

  describe('code location', () => {
    const location = {
      path: 'src/a.ts',
      language: 'typescript',
      startLine: 3,
      endLine: 9,
      symbol: 'login',
    };

    it('travels with the chunk through the fusion', () => {
      const fused = fuseRankings([candidate('a', { code: location })], [], { limit: 5 });

      expect(fused[0]!.code).toEqual(location);
    });

    it('is absent for a document passage', () => {
      const fused = fuseRankings([candidate('a')], [], { limit: 5 });

      expect(fused[0]).not.toHaveProperty('code');
    });
  });
});
