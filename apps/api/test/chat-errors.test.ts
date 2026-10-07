import { APICallError, RetryError } from 'ai';
import { describe, expect, it } from 'vitest';
import { EmbeddingError } from '../src/ai/embeddings.js';
import {
  CHAT_FAILURE_MESSAGES,
  chatFailureMessage,
  classifyChatFailure,
} from '../src/chat/errors.js';

function apiError(statusCode: number | undefined, message = 'upstream failure', body?: string) {
  return new APICallError({
    message,
    url: 'https://example.test/v1',
    requestBodyValues: {},
    statusCode,
    responseBody: body,
    isRetryable: false,
  });
}

function namedError(name: string) {
  const error = new Error(name);
  error.name = name;
  return error;
}

describe('classifyChatFailure', () => {
  it.each([
    [429, 'rate_limited'],
    [503, 'overloaded'],
    [500, 'overloaded'],
    [401, 'misconfigured'],
    [403, 'misconfigured'],
    [400, 'unexpected'],
    [undefined, 'unexpected'],
  ] as const)('maps an API status of %s to %s', (status, kind) => {
    expect(classifyChatFailure(apiError(status))).toBe(kind);
  });

  it('recognises the invalid-key response Google sends as HTTP 400', () => {
    const error = apiError(400, 'Bad Request', '{"error":{"message":"API key not valid."}}');

    expect(classifyChatFailure(error)).toBe('misconfigured');
  });

  it('looks through the wrapper the SDK puts around retried calls', () => {
    const retried = new RetryError({
      message: 'Failed after 3 attempts',
      reason: 'maxRetriesExceeded',
      errors: [apiError(503), apiError(429)],
    });

    expect(classifyChatFailure(retried)).toBe('rate_limited');
  });

  it('separates timeouts and cancellations from other failures', () => {
    expect(classifyChatFailure(namedError('TimeoutError'))).toBe('timeout');
    expect(classifyChatFailure(namedError('AbortError'))).toBe('cancelled');
  });

  it.each([
    ['rate_limited', 'rate_limited'],
    ['misconfigured', 'misconfigured'],
    ['timeout', 'timeout'],
    ['unavailable', 'unexpected'],
  ] as const)('maps an embedding failure of kind %s to %s', (embeddingKind, kind) => {
    expect(classifyChatFailure(new EmbeddingError(embeddingKind))).toBe(kind);
  });

  it('falls back to unexpected for anything else', () => {
    expect(classifyChatFailure(new Error('boom'))).toBe('unexpected');
    expect(classifyChatFailure('a string')).toBe('unexpected');
    expect(classifyChatFailure(undefined)).toBe('unexpected');
  });
});

describe('chatFailureMessage', () => {
  it('never contains details of the original error', () => {
    const error = apiError(429, 'quota exceeded for key AIzaSECRET', '{"detail":"AIzaSECRET"}');

    const message = chatFailureMessage(error);

    expect(message).toBe(CHAT_FAILURE_MESSAGES.rate_limited);
    expect(message).not.toContain('AIza');
  });
});
