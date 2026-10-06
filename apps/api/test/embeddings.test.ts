import { APICallError } from 'ai';
import { MockEmbeddingModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmbedderFromEnv } from '../src/ai/index.js';
import {
  createEmbedder,
  createUnconfiguredEmbedder,
  EmbeddingError,
  type EmbedderOptions,
} from '../src/ai/embeddings.js';
import { EMBEDDING_DIMENSIONS } from '../src/db/schema.js';

const DIMENSIONS = 4;

const vectorFor = (text: string) => Array.from({ length: DIMENSIONS }, (_, i) => text.length + i);

type DoEmbed = Extract<
  NonNullable<ConstructorParameters<typeof MockEmbeddingModelV4>[0]>['doEmbed'],
  (...args: never[]) => unknown
>;

const succeed: DoEmbed = async ({ values }) => ({
  embeddings: values.map(vectorFor),
  warnings: [],
});

function apiError(statusCode: number, message = 'provider says no') {
  return new APICallError({
    message,
    url: 'https://example.test/embed',
    requestBodyValues: {},
    statusCode,
  });
}

function setup(
  doEmbed: DoEmbed = succeed,
  options: { maxEmbeddingsPerCall?: number } & Partial<EmbedderOptions> = {},
) {
  const { maxEmbeddingsPerCall = 2, ...embedderOptions } = options;
  const model = new MockEmbeddingModelV4({
    maxEmbeddingsPerCall,
    supportsParallelCalls: true,
    doEmbed,
  });
  const embedder = createEmbedder({ model, dimensions: DIMENSIONS, ...embedderOptions });
  return { model, embedder };
}

const failureOf = async (action: Promise<unknown>) =>
  action.then(
    () => undefined,
    (e: unknown) => e,
  );

afterEach(() => {
  vi.useRealTimers();
});

describe('embedDocuments', () => {
  it('returns one vector per text, in the order given', async () => {
    const { embedder } = setup();

    const vectors = await embedder.embedDocuments(['a', 'bb', 'ccc']);

    expect(vectors).toEqual([vectorFor('a'), vectorFor('bb'), vectorFor('ccc')]);
  });

  it('splits a large input into batches the model can take and keeps the order across them', async () => {
    const { embedder, model } = setup(succeed, { maxEmbeddingsPerCall: 2 });
    const texts = ['a', 'bb', 'ccc', 'dddd', 'eeeee'];

    const vectors = await embedder.embedDocuments(texts);

    expect(model.doEmbedCalls.map((call) => call.values.length).sort()).toEqual([1, 2, 2]);
    expect(vectors).toEqual(texts.map(vectorFor));
  });

  it('asks for passage-style vectors of the size the database expects', async () => {
    const { embedder, model } = setup();

    await embedder.embedDocuments(['a']);

    expect(model.doEmbedCalls[0]?.providerOptions).toEqual({
      google: { outputDimensionality: DIMENSIONS, taskType: 'RETRIEVAL_DOCUMENT' },
    });
  });

  it('makes no request for an empty list', async () => {
    const { embedder, model } = setup();

    expect(await embedder.embedDocuments([])).toEqual([]);
    expect(model.doEmbedCalls).toHaveLength(0);
  });

  it('refuses empty text before spending a request on it', async () => {
    const { embedder, model } = setup();

    const error = await failureOf(embedder.embedDocuments(['fine', '   ']));

    expect(error).toMatchObject({ name: 'EmbeddingError', kind: 'invalid_input' });
    expect(model.doEmbedCalls).toHaveLength(0);
  });

  it('keeps the number of requests in flight below the configured limit', async () => {
    let active = 0;
    let peak = 0;
    const slow: DoEmbed = async ({ values }) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return { embeddings: values.map(vectorFor), warnings: [] };
    };
    const { embedder } = setup(slow, { maxEmbeddingsPerCall: 1, maxParallelCalls: 2 });

    await embedder.embedDocuments(['a', 'b', 'c', 'd', 'e', 'f']);

    expect(peak).toBe(2);
  });

  describe('when the model misbehaves', () => {
    it('rejects vectors of the wrong size instead of passing them to the database', async () => {
      const wrongSize: DoEmbed = async ({ values }) => ({
        embeddings: values.map(() => [0.1, 0.2]),
        warnings: [],
      });
      const { embedder } = setup(wrongSize);

      const error = await failureOf(embedder.embedDocuments(['a']));

      expect(error).toMatchObject({ kind: 'unexpected' });
      expect(String((error as EmbeddingError).cause)).toContain('4 dimensions');
    });
  });

  describe('retries', () => {
    it('tries again after a rate-limit response and then succeeds', async () => {
      vi.useFakeTimers();
      const doEmbed = vi.fn<DoEmbed>();
      doEmbed.mockRejectedValueOnce(apiError(429)).mockImplementation(succeed);
      const { embedder } = setup(doEmbed, { maxRetries: 2 });

      const result = embedder.embedDocuments(['a']);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(await result).toEqual([vectorFor('a')]);
      expect(doEmbed).toHaveBeenCalledTimes(2);
    });

    it('gives up after the allowed retries and reports the rate limit', async () => {
      vi.useFakeTimers();
      const doEmbed = vi.fn<DoEmbed>().mockRejectedValue(apiError(429));
      const { embedder } = setup(doEmbed, { maxRetries: 2 });

      const result = failureOf(embedder.embedDocuments(['a']));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(await result).toMatchObject({ kind: 'rate_limited' });
      expect(doEmbed).toHaveBeenCalledTimes(3);
    });

    it('retries server errors too and reports the service as unavailable', async () => {
      vi.useFakeTimers();
      const doEmbed = vi.fn<DoEmbed>().mockRejectedValue(apiError(503));
      const { embedder } = setup(doEmbed, { maxRetries: 1 });

      const result = failureOf(embedder.embedDocuments(['a']));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(await result).toMatchObject({ kind: 'unavailable' });
      expect(doEmbed).toHaveBeenCalledTimes(2);
    });

    it.each([401, 403])('does not retry a %i, which a retry cannot fix', async (status) => {
      const doEmbed = vi.fn<DoEmbed>().mockRejectedValue(apiError(status));
      const { embedder } = setup(doEmbed, { maxRetries: 3 });

      const error = await failureOf(embedder.embedDocuments(['a']));

      expect(error).toMatchObject({ kind: 'misconfigured' });
      expect(doEmbed).toHaveBeenCalledTimes(1);
    });

    it('recognises the 400 that Google sends for an invalid API key as a configuration problem', async () => {
      const doEmbed = vi
        .fn<DoEmbed>()
        .mockRejectedValue(apiError(400, 'API key not valid. Please pass a valid API key.'));
      const { embedder } = setup(doEmbed, { maxRetries: 3 });

      const error = await failureOf(embedder.embedDocuments(['a']));

      expect(error).toMatchObject({ kind: 'misconfigured' });
      expect(doEmbed).toHaveBeenCalledTimes(1);
    });

    it('does not retry a request the API says is invalid', async () => {
      const doEmbed = vi.fn<DoEmbed>().mockRejectedValue(apiError(400));
      const { embedder } = setup(doEmbed, { maxRetries: 3 });

      const error = await failureOf(embedder.embedDocuments(['a']));

      expect(error).toMatchObject({ kind: 'invalid_input' });
      expect(doEmbed).toHaveBeenCalledTimes(1);
    });
  });

  describe('time and cancellation', () => {
    const neverAnswers: DoEmbed = ({ abortSignal }) =>
      new Promise((_, reject) => {
        if (abortSignal?.aborted) reject(abortSignal.reason);
        abortSignal?.addEventListener('abort', () => reject(abortSignal.reason));
      });

    it('stops waiting after the time limit', async () => {
      const { embedder } = setup(neverAnswers, { timeoutMs: 30 });

      const error = await failureOf(embedder.embedDocuments(['a']));

      expect(error).toMatchObject({ kind: 'timeout' });
    });

    it('stops when the caller cancels and says it was cancelled, not slow', async () => {
      const { embedder, model } = setup(neverAnswers);
      const controller = new AbortController();

      const result = failureOf(embedder.embedDocuments(['a'], { signal: controller.signal }));
      await vi.waitFor(() => expect(model.doEmbedCalls).toHaveLength(1));
      controller.abort();

      expect(await result).toMatchObject({ kind: 'cancelled' });
    });
  });

  describe('error messages', () => {
    it('never repeat what the provider said, but keep it as the cause for the logs', async () => {
      const doEmbed = vi
        .fn<NonNullable<DoEmbed>>()
        .mockRejectedValue(apiError(403, 'API key AIza-SECRET is invalid'));
      const { embedder } = setup(doEmbed);

      const error = (await failureOf(embedder.embedDocuments(['a']))) as EmbeddingError;

      expect(error.message).not.toContain('AIza-SECRET');
      expect(String(error.cause)).toContain('AIza-SECRET');
    });

    it('are written for the user, one per kind', async () => {
      const kinds = [
        'rate_limited',
        'misconfigured',
        'unavailable',
        'timeout',
        'invalid_input',
        'unexpected',
      ] as const;

      const messages = kinds.map((kind) => new EmbeddingError(kind).message);

      expect(new Set(messages).size).toBe(kinds.length);
      for (const message of messages) expect(message).toMatch(/^The /);
    });
  });
});

describe('embedQuery', () => {
  it('returns the vector of the query', async () => {
    const { embedder } = setup();

    expect(await embedder.embedQuery('what is hnsw?')).toEqual(vectorFor('what is hnsw?'));
  });

  it('asks for a query-style vector, which differs from a passage-style one', async () => {
    const { embedder, model } = setup();

    await embedder.embedQuery('what is hnsw?');

    expect(model.doEmbedCalls[0]?.providerOptions).toEqual({
      google: { outputDimensionality: DIMENSIONS, taskType: 'RETRIEVAL_QUERY' },
    });
  });

  it('refuses an empty query', async () => {
    const { embedder, model } = setup();

    const error = await failureOf(embedder.embedQuery('  '));

    expect(error).toMatchObject({ kind: 'invalid_input' });
    expect(model.doEmbedCalls).toHaveLength(0);
  });

  it('maps failures the same way as documents do', async () => {
    const doEmbed = vi.fn<DoEmbed>().mockRejectedValue(apiError(401));
    const { embedder } = setup(doEmbed);

    expect(await failureOf(embedder.embedQuery('q'))).toMatchObject({ kind: 'misconfigured' });
  });
});

describe('without an API key', () => {
  it('reports the missing configuration for documents and queries alike', async () => {
    const embedder = createUnconfiguredEmbedder();

    expect(await failureOf(embedder.embedDocuments(['a']))).toMatchObject({
      kind: 'misconfigured',
    });
    expect(await failureOf(embedder.embedQuery('a'))).toMatchObject({ kind: 'misconfigured' });
  });

  it('is what the app falls back to when GOOGLE_GENERATIVE_AI_API_KEY is not set', async () => {
    const embedder = createEmbedderFromEnv({
      GOOGLE_GENERATIVE_AI_API_KEY: undefined,
      EMBEDDING_MODEL: 'gemini-embedding-001',
    });

    expect(await failureOf(embedder.embedQuery('a'))).toMatchObject({ kind: 'misconfigured' });
  });

  it('asks the model for vectors that fit the database column', () => {
    expect(EMBEDDING_DIMENSIONS).toBe(768);
  });
});
