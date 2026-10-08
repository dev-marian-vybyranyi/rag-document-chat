import { APICallError } from 'ai';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { EmbeddingError, type Embedder } from '../src/ai/embeddings.js';
import { createRetrievalSearcher } from '../src/eval/retrieval-eval.js';
import type { RetrievalCandidate, RetrievalStore } from '../src/rag/retrieval.js';
import { createPassthroughRewriter } from '../src/rag/rewrite.js';

const candidate = (n: number): RetrievalCandidate => ({
  chunkId: `c${n}`,
  documentId: 'd1',
  filename: 'a.txt',
  ordinal: n,
  page: null,
  content: `passage ${n}`,
  score: 0.9 - n / 100,
});

const store: RetrievalStore = {
  vectorSearch: async () => [candidate(1), candidate(2)],
  keywordSearch: async () => [candidate(2), candidate(3)],
};

function rateLimited(message = 'Please retry in 12.2s.') {
  return new EmbeddingError('rate_limited', {
    cause: new APICallError({
      message,
      url: 'https://example.test',
      requestBodyValues: {},
      statusCode: 429,
      isRetryable: false,
    }),
  });
}

function setup(
  embedQuery: Embedder['embedQuery'],
  options: { pacing?: number; retries?: number } = {},
) {
  const embedder: Embedder = { embedDocuments: async () => [], embedQuery: vi.fn(embedQuery) };
  const waits: number[] = [];
  const noted: number[] = [];
  const searcher = createRetrievalSearcher({
    userId: 'u1',
    store,
    embedder,
    rewriter: createPassthroughRewriter(),
    logger: pino({ level: 'silent' }),
    queryPacingMs: options.pacing ?? 0,
    rateLimitRetries: options.retries,
    sleep: async (ms) => void waits.push(ms),
    onWait: (ms) => noted.push(ms),
  });
  return { searcher, embedder, waits, noted };
}

describe('the retrieval searcher of the evaluation', () => {
  it('embeds a query once although hybrid and vector search both need it', async () => {
    const { searcher, embedder } = setup(async () => [1, 2, 3]);

    await searcher.search('hybrid', 'what is it');
    await searcher.search('vector', 'what is it');
    await searcher.search('keyword', 'what is it');

    expect(embedder.embedQuery).toHaveBeenCalledTimes(1);
  });

  it('returns the passages of each variant with the best score of the hybrid result', async () => {
    const { searcher } = setup(async () => [1, 2, 3]);

    const hybrid = await searcher.search('hybrid', 'q');
    const vector = await searcher.search('vector', 'q');
    const keyword = await searcher.search('keyword', 'q');

    expect(vector.hits.map((hit) => hit.content)).toEqual(['passage 1', 'passage 2']);
    expect(keyword.hits.map((hit) => hit.content)).toEqual(['passage 2', 'passage 3']);
    expect(hybrid.hits.length).toBe(3);
    expect(hybrid.bestScore).toBeCloseTo(0.89);
    expect(vector.bestScore).toBeCloseTo(0.89);
    expect(keyword.bestScore).toBeNull();
  });

  describe('when the embedding quota is reached', () => {
    it('waits as long as Google says, plus a second, and tries again', async () => {
      let calls = 0;
      const { searcher, waits, noted } = setup(async () => {
        if (++calls <= 2) throw rateLimited();
        return [1, 2, 3];
      });

      const result = await searcher.search('vector', 'q');

      expect(result.hits).toHaveLength(2);
      expect(waits).toEqual([13_200, 13_200]);
      expect(noted).toEqual([13_200, 13_200]);
    });

    it('waits 36 seconds when it is not told how long', async () => {
      let calls = 0;
      const { searcher, waits } = setup(async () => {
        if (++calls === 1) throw rateLimited('You exceeded your current quota.');
        return [1];
      });

      await searcher.search('vector', 'q');

      expect(waits).toEqual([36_000]);
    });

    it('gives up after the allowed number of retries', async () => {
      const { searcher, embedder } = setup(
        async () => {
          throw rateLimited();
        },
        { retries: 2 },
      );

      await expect(searcher.search('vector', 'q')).rejects.toMatchObject({ kind: 'rate_limited' });

      expect(embedder.embedQuery).toHaveBeenCalledTimes(3);
    });

    it('does not retry a failure that waiting cannot fix', async () => {
      const { searcher, embedder, waits } = setup(async () => {
        throw new EmbeddingError('misconfigured');
      });

      await expect(searcher.search('vector', 'q')).rejects.toMatchObject({ kind: 'misconfigured' });

      expect(embedder.embedQuery).toHaveBeenCalledTimes(1);
      expect(waits).toEqual([]);
    });

    it('tries again later for a query that failed, instead of remembering the failure', async () => {
      let calls = 0;
      const { searcher } = setup(async () => {
        if (++calls === 1) throw new EmbeddingError('unavailable');
        return [1];
      });

      await expect(searcher.search('vector', 'q')).rejects.toBeInstanceOf(EmbeddingError);
      const second = await searcher.search('vector', 'q');

      expect(second.hits).toHaveLength(2);
    });
  });

  it('refuses a hybrid result that fell back to keyword search, so a figure never hides it', async () => {
    const { searcher } = setup(async () => {
      throw new EmbeddingError('unavailable');
    });

    await expect(searcher.search('hybrid', 'q')).rejects.toThrow('keyword search only');
  });

  it('keeps a pause between embedding requests to stay under the per-minute request limit', async () => {
    const { searcher, waits } = setup(async () => [1], { pacing: 700 });

    await searcher.search('vector', 'first question');
    await searcher.search('vector', 'second question');

    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThan(0);
    expect(waits[0]).toBeLessThanOrEqual(700);
  });
});
