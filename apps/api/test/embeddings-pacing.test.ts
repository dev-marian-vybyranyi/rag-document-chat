import { MockEmbeddingModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import {
  createEmbedder,
  estimateTokens,
  type Clock,
  type EmbedderOptions,
} from '../src/ai/embeddings.js';

const DIMENSIONS = 4;
const vectorFor = (text: string) => Array.from({ length: DIMENSIONS }, (_, i) => text.length + i);

function fakeClock() {
  let time = 1_000_000;
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => time,
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      sleeps.push(ms);
      time += ms;
    },
  };
  return { clock, sleeps, now: () => time };
}

function setup(options: Partial<EmbedderOptions> = {}) {
  const time = fakeClock();
  const calls: Array<{ at: number; values: string[] }> = [];
  const model = new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: 100,
    supportsParallelCalls: true,
    doEmbed: async ({ values }) => {
      calls.push({ at: time.now(), values: [...values] });
      return { embeddings: values.map(vectorFor), warnings: [] };
    },
  });
  const embedder = createEmbedder({
    model,
    dimensions: DIMENSIONS,
    clock: time.clock,
    maxRetries: 0,
    ...options,
  });
  return { embedder, calls, time };
}

const passage = (n: number, tokens = 350) => `${n}`.padEnd(Math.ceil(tokens * 3.5), 'x');

describe('embedding documents within the tokens-per-minute quota', () => {
  it('estimates a token as three and a half characters, rounding up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('x'.repeat(35))).toBe(10);
  });

  it('sends small inputs in one request without waiting', async () => {
    const { embedder, calls, time } = setup();

    const vectors = await embedder.embedDocuments(['a', 'bb', 'ccc']);

    expect(vectors).toEqual([vectorFor('a'), vectorFor('bb'), vectorFor('ccc')]);
    expect(calls).toHaveLength(1);
    expect(time.sleeps).toEqual([]);
  });

  it('splits a large input into requests of limited size, keeping the order', async () => {
    const { embedder, calls } = setup({ maxTokensPerRequest: 1_000, tokensPerMinute: 1_000_000 });
    const texts = Array.from({ length: 10 }, (_, i) => passage(i));

    const vectors = await embedder.embedDocuments(texts);

    expect(calls.length).toBeGreaterThan(3);
    for (const call of calls) {
      const tokens = call.values.reduce((sum, text) => sum + estimateTokens(text), 0);
      expect(tokens).toBeLessThanOrEqual(1_000 + 350);
    }
    expect(calls.flatMap((call) => call.values)).toEqual(texts);
    expect(vectors).toEqual(texts.map(vectorFor));
  });

  it('waits for the minute to pass instead of exceeding the quota', async () => {
    const { embedder, calls, time } = setup({ tokensPerMinute: 2_000, maxTokensPerRequest: 1_000 });
    const texts = Array.from({ length: 12 }, (_, i) => passage(i));

    await embedder.embedDocuments(texts);

    const start = calls[0]!.at;
    for (const call of calls) {
      const sentInTheMinuteBefore = calls
        .filter((other) => other.at <= call.at && other.at > call.at - 60_000)
        .flatMap((other) => other.values)
        .reduce((sum, text) => sum + estimateTokens(text), 0);
      expect(sentInTheMinuteBefore).toBeLessThanOrEqual(2_000 + 1_000);
    }
    expect(time.sleeps.length).toBeGreaterThan(0);
    expect(calls.at(-1)!.at - start).toBeGreaterThanOrEqual(60_000);
  });

  it('shares the quota between callers of the same embedder', async () => {
    const { embedder, calls, time } = setup({ tokensPerMinute: 1_000, maxTokensPerRequest: 1_000 });
    const batch = (offset: number) => Array.from({ length: 2 }, (_, i) => passage(offset + i));

    const [first, second] = await Promise.all([
      embedder.embedDocuments(batch(0)),
      embedder.embedDocuments(batch(10)),
    ]);

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(time.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(59_000);
  });

  it('lets a single oversized request through rather than waiting for ever', async () => {
    const { embedder, calls } = setup({ tokensPerMinute: 100, maxTokensPerRequest: 1_000_000 });

    const vectors = await embedder.embedDocuments([passage(1, 500)]);

    expect(vectors).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('stops waiting when the caller cancels, and says it was cancelled', async () => {
    const controller = new AbortController();
    const time = fakeClock();
    time.clock.sleep = async (_ms, signal) => {
      controller.abort();
      signal?.throwIfAborted();
    };
    const model = new MockEmbeddingModelV4({
      maxEmbeddingsPerCall: 100,
      doEmbed: async ({ values }) => ({ embeddings: values.map(vectorFor), warnings: [] }),
    });
    const embedder = createEmbedder({
      model,
      dimensions: DIMENSIONS,
      clock: time.clock,
      tokensPerMinute: 400,
      maxTokensPerRequest: 400,
    });

    const failure = await embedder
      .embedDocuments([passage(1), passage(2), passage(3)], { signal: controller.signal })
      .catch((e: unknown) => e);

    expect(failure).toMatchObject({ kind: 'cancelled' });
  });

  it('does not count its waiting against the time limit of a request', async () => {
    const { embedder } = setup({
      tokensPerMinute: 400,
      maxTokensPerRequest: 400,
      timeoutMs: 1_000,
    });

    const vectors = await embedder.embedDocuments([passage(1), passage(2), passage(3)]);

    expect(vectors).toHaveLength(3);
  });
});

describe('EMBEDDING_TOKENS_PER_MINUTE', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

  it('defaults to a value under the 30,000 the free tier allows', () => {
    expect(loadEnv(base).EMBEDDING_TOKENS_PER_MINUTE).toBe(25_000);
  });

  it('can be raised for a paid plan', () => {
    expect(
      loadEnv({ ...base, EMBEDDING_TOKENS_PER_MINUTE: '1000000' }).EMBEDDING_TOKENS_PER_MINUTE,
    ).toBe(1_000_000);
  });

  it.each(['0', '-5', 'many'])('rejects %s', (value) => {
    expect(() => loadEnv({ ...base, EMBEDDING_TOKENS_PER_MINUTE: value })).toThrow(
      /EMBEDDING_TOKENS_PER_MINUTE/,
    );
  });
});
