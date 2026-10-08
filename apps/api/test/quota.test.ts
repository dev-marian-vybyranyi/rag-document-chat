import { APICallError, RetryError } from 'ai';
import { describe, expect, it } from 'vitest';
import { MockEmbeddingModelV4 } from 'ai/test';
import { createCooldown } from '../src/ai/cooldown.js';
import { createEmbedder, EmbeddingError } from '../src/ai/embeddings.js';
import { quotaInfoOf } from '../src/ai/quota.js';
import { classifyChatFailure, describeChatFailure } from '../src/chat/errors.js';
import { CHAT_FAILURE_MESSAGES } from '../src/chat/errors.js';

function geminiError(
  details: unknown[],
  options: { message?: string; headers?: Record<string, string>; status?: number } = {},
) {
  return new APICallError({
    message: options.message ?? 'You exceeded your current quota.',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/x:streamGenerateContent',
    requestBodyValues: {},
    statusCode: options.status ?? 429,
    responseHeaders: options.headers,
    responseBody: JSON.stringify({
      error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', details },
    }),
    isRetryable: false,
  });
}

const retryInfo = (retryDelay: string) => ({
  '@type': 'type.googleapis.com/google.rpc.RetryInfo',
  retryDelay,
});
const quotaFailure = (quotaId: string) => ({
  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
  violations: [{ quotaMetric: 'generate_content_free_tier_requests', quotaId }],
});

describe('quotaInfoOf', () => {
  it('reads how long Google asks to wait', () => {
    expect(quotaInfoOf(geminiError([retryInfo('34s')]))).toEqual({
      daily: false,
      retryAfterMs: 34_000,
    });
    expect(quotaInfoOf(geminiError([retryInfo('12.3s')])).retryAfterMs).toBe(12_300);
  });

  it('recognises a per-day quota from the violated quota id', () => {
    const error = geminiError([
      quotaFailure('GenerateRequestsPerDayPerProjectPerModel-FreeTier'),
      retryInfo('40s'),
    ]);

    expect(quotaInfoOf(error)).toEqual({ daily: true, retryAfterMs: 40_000 });
  });

  it('does not take a per-minute quota for a daily one', () => {
    const error = geminiError([
      quotaFailure('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'),
    ]);

    expect(quotaInfoOf(error).daily).toBe(false);
  });

  it('falls back to the retry hint in the message and then to the Retry-After header', () => {
    const inMessage = geminiError([], { message: 'Quota exceeded. Please retry in 7.5s.' });
    const inHeader = geminiError([], { headers: { 'retry-after': '20' } });

    expect(quotaInfoOf(inMessage).retryAfterMs).toBe(7_500);
    expect(quotaInfoOf(inHeader).retryAfterMs).toBe(20_000);
  });

  it('recognises a daily quota named only in the message', () => {
    const error = geminiError([], { message: 'Quota exceeded for requests per day' });

    expect(quotaInfoOf(error).daily).toBe(true);
  });

  it('looks inside the wrappers the SDK and the embedder put around the error', () => {
    const inner = geminiError([retryInfo('9s')]);
    const retried = new RetryError({
      message: 'Failed after 3 attempts',
      reason: 'maxRetriesExceeded',
      errors: [inner],
    });

    expect(quotaInfoOf(retried).retryAfterMs).toBe(9_000);
    expect(quotaInfoOf(new EmbeddingError('rate_limited', { cause: inner })).retryAfterMs).toBe(
      9_000,
    );
  });

  it.each([
    [
      'a body that is not JSON',
      new APICallError({
        message: 'x',
        url: 'u',
        requestBodyValues: {},
        statusCode: 429,
        responseBody: '<html>',
        isRetryable: false,
      }),
    ],
    ['an error from somewhere else', new Error('boom')],
    ['something that is not an error', 'text'],
  ])('knows nothing about %s', (_name, error) => {
    expect(quotaInfoOf(error)).toEqual({ daily: false, retryAfterMs: null });
  });

  it.each(['-5s', 'soon', 'NaNs'])('ignores a nonsense delay %j', (retryDelay) => {
    expect(quotaInfoOf(geminiError([retryInfo(retryDelay)])).retryAfterMs).toBeNull();
  });

  it('never asks for more than a day', () => {
    expect(quotaInfoOf(geminiError([retryInfo('9999999s')])).retryAfterMs).toBe(86_400_000);
  });
});

describe('failures caused by the quota', () => {
  const daily = geminiError([quotaFailure('GenerateRequestsPerDayPerProjectPerModel-FreeTier')]);

  it('are told apart from short rate limits', () => {
    expect(classifyChatFailure(daily)).toBe('quota_exhausted');
    expect(classifyChatFailure(geminiError([retryInfo('5s')]))).toBe('rate_limited');
    expect(classifyChatFailure(new EmbeddingError('quota_exhausted'))).toBe('quota_exhausted');
  });

  it('tell the user how long to wait when Google says so', () => {
    const failure = describeChatFailure(geminiError([retryInfo('34s')]));

    expect(failure).toEqual({
      kind: 'rate_limited',
      message: 'The AI service is busy (rate limit reached). Please try again in 34 seconds.',
      retryAfterMs: 34_000,
    });
  });

  it('use the general message when no wait is known, and for a daily quota', () => {
    expect(describeChatFailure(geminiError([])).message).toBe(CHAT_FAILURE_MESSAGES.rate_limited);
    expect(describeChatFailure(daily)).toMatchObject({
      kind: 'quota_exhausted',
      message: CHAT_FAILURE_MESSAGES.quota_exhausted,
      retryAfterMs: null,
    });
  });

  it('never show the provider text to the user', () => {
    const error = geminiError([retryInfo('3s')], { message: 'key AIzaSECRET over quota' });

    expect(describeChatFailure(error).message).not.toContain('AIza');
  });
});

describe('cooldown', () => {
  const clock = () => {
    let time = 1_000;
    return { now: () => time, advance: (ms: number) => void (time += ms) };
  };

  it('is idle until tripped', () => {
    expect(createCooldown(clock().now).state()).toBeNull();
  });

  it('reports the time left and the reason, then ends by itself', () => {
    const time = clock();
    const cooldown = createCooldown(time.now);

    cooldown.trip(10_000, 'rate_limited');
    time.advance(4_000);
    expect(cooldown.state()).toEqual({ reason: 'rate_limited', remainingMs: 6_000 });

    time.advance(6_000);
    expect(cooldown.state()).toBeNull();
  });

  it('keeps the longer of two overlapping waits and its reason', () => {
    const time = clock();
    const cooldown = createCooldown(time.now);

    cooldown.trip(600_000, 'quota_exhausted');
    cooldown.trip(15_000, 'rate_limited');

    expect(cooldown.state()).toEqual({ reason: 'quota_exhausted', remainingMs: 600_000 });
  });
});

describe('embedding failures caused by the quota', () => {
  const embedderFailing = (error: APICallError) =>
    createEmbedder({
      model: new MockEmbeddingModelV4({
        maxEmbeddingsPerCall: 2,
        doEmbed: async () => {
          throw error;
        },
      }),
      dimensions: 4,
      maxRetries: 0,
      queryMaxRetries: 0,
    });

  it('become a daily-quota error with its own message', async () => {
    const error = geminiError([
      quotaFailure('EmbedContentRequestsPerDayPerProjectPerModel-FreeTier'),
    ]);

    const failure = await embedderFailing(error)
      .embedQuery('a')
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(EmbeddingError);
    expect(failure).toMatchObject({ kind: 'quota_exhausted' });
    expect((failure as Error).message).toContain('daily quota');
  });

  it('stay a plain rate limit when the quota is per minute', async () => {
    const failure = await embedderFailing(geminiError([retryInfo('5s')]))
      .embedDocuments(['a'])
      .catch((e: unknown) => e);

    expect(failure).toMatchObject({ kind: 'rate_limited' });
  });
});
