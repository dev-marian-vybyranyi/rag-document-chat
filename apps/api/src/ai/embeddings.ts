import { quotaInfoOf } from './quota.js';
import { APICallError, embed, embedMany, RetryError, type EmbeddingModel } from 'ai';

export type EmbeddingErrorKind =
  | 'rate_limited'
  | 'quota_exhausted'
  | 'misconfigured'
  | 'unavailable'
  | 'timeout'
  | 'cancelled'
  | 'invalid_input'
  | 'unexpected';

const USER_MESSAGES: Record<EmbeddingErrorKind, string> = {
  rate_limited:
    'The embedding service is busy (rate limit reached). Please try again in a few minutes.',
  quota_exhausted:
    'The daily quota of the embedding service is used up. Please try again tomorrow.',
  misconfigured: 'The embedding service is not configured correctly.',
  unavailable: 'The embedding service is temporarily unavailable. Please try again later.',
  timeout: 'The embedding service took too long to respond. Please try again.',
  cancelled: 'The embedding request was cancelled.',
  invalid_input: 'The document contains text that the embedding service rejected.',
  unexpected: 'The embedding service returned an unexpected result.',
};

export class EmbeddingError extends Error {
  constructor(
    readonly kind: EmbeddingErrorKind,
    options?: { cause?: unknown },
  ) {
    super(USER_MESSAGES[kind], options);
    this.name = 'EmbeddingError';
  }
}

export interface Embedder {
  embedDocuments(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
  embedQuery(text: string, options?: { signal?: AbortSignal }): Promise<number[]>;
}

export type EmbeddingTask = 'document' | 'query';
export type EmbeddingProviderOptions = NonNullable<Parameters<typeof embed>[0]['providerOptions']>;

export interface EmbedderOptions {
  model: EmbeddingModel;
  dimensions: number;
  providerOptions?: (task: EmbeddingTask) => EmbeddingProviderOptions;
  maxRetries?: number;
  queryMaxRetries?: number;
  maxParallelCalls?: number;
  timeoutMs?: number;
  tokensPerMinute?: number;
  maxTokensPerRequest?: number;
  clock?: Clock;
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

const CHARS_PER_TOKEN_ESTIMATE = 3.5;
const WINDOW_MS = 60 * 1000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

function createTokenWindow(limit: number, clock: Clock) {
  const entries: Array<{ at: number; tokens: number }> = [];

  return {
    async acquire(tokens: number, signal?: AbortSignal): Promise<void> {
      const need = Math.min(tokens, limit);
      for (;;) {
        const now = clock.now();
        while (entries.length > 0 && entries[0]!.at <= now - WINDOW_MS) entries.shift();
        const used = entries.reduce((sum, entry) => sum + entry.tokens, 0);
        if (used + need <= limit) {
          entries.push({ at: now, tokens: need });
          return;
        }
        let freed = 0;
        let freeAt = now;
        for (const entry of entries) {
          freed += entry.tokens;
          freeAt = entry.at + WINDOW_MS;
          if (used - freed + need <= limit) break;
        }
        await clock.sleep(Math.max(freeAt - now, 0) + 5, signal);
      }
    },
  };
}

function groupByTokens(texts: string[], maxTokens: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let tokens = 0;
  for (const text of texts) {
    const size = estimateTokens(text);
    if (current.length > 0 && tokens + size > maxTokens) {
      groups.push(current);
      current = [];
      tokens = 0;
    }
    current.push(text);
    tokens += size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_QUERY_MAX_RETRIES = 1;
const DEFAULT_MAX_PARALLEL_CALLS = 2;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
export const DEFAULT_TOKENS_PER_MINUTE = 25_000;
export const DEFAULT_MAX_TOKENS_PER_REQUEST = 10_000;

export function createEmbedder(options: EmbedderOptions): Embedder {
  const {
    model,
    dimensions,
    providerOptions,
    maxRetries = DEFAULT_MAX_RETRIES,
    queryMaxRetries = DEFAULT_QUERY_MAX_RETRIES,
    maxParallelCalls = DEFAULT_MAX_PARALLEL_CALLS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    tokensPerMinute = DEFAULT_TOKENS_PER_MINUTE,
    maxTokensPerRequest = DEFAULT_MAX_TOKENS_PER_REQUEST,
    clock = realClock,
  } = options;
  const tokenWindow = createTokenWindow(tokensPerMinute, clock);

  const withLimits = (signal?: AbortSignal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  };

  const checkVectors = (vectors: number[][], expectedCount: number) => {
    if (vectors.length !== expectedCount || vectors.some((v) => v.length !== dimensions)) {
      throw new EmbeddingError('unexpected', {
        cause: new Error(
          `Expected ${expectedCount} vectors of ${dimensions} dimensions, got ${vectors.length} ` +
            `(sizes: ${[...new Set(vectors.map((v) => v.length))].join(', ')})`,
        ),
      });
    }
  };

  return {
    async embedDocuments(texts, { signal } = {}) {
      if (texts.length === 0) return [];
      requireText(texts);
      try {
        const vectors: number[][] = [];
        for (const group of groupByTokens(texts, maxTokensPerRequest)) {
          await tokenWindow.acquire(
            group.reduce((sum, text) => sum + estimateTokens(text), 0),
            signal,
          );
          const { embeddings } = await embedMany({
            model,
            values: group,
            maxRetries,
            maxParallelCalls,
            abortSignal: withLimits(signal),
            providerOptions: providerOptions?.('document'),
          });
          vectors.push(...embeddings);
        }
        checkVectors(vectors, texts.length);
        return vectors;
      } catch (error) {
        throw toEmbeddingError(error);
      }
    },

    async embedQuery(text, { signal } = {}) {
      requireText([text]);
      try {
        const { embedding } = await embed({
          model,
          value: text,
          maxRetries: queryMaxRetries,
          abortSignal: withLimits(signal),
          providerOptions: providerOptions?.('query'),
        });
        checkVectors([embedding], 1);
        return embedding;
      } catch (error) {
        throw toEmbeddingError(error);
      }
    },
  };
}

export function createUnconfiguredEmbedder(keyVariable: string): Embedder {
  const fail = (): never => {
    throw new EmbeddingError('misconfigured', {
      cause: new Error(`${keyVariable} is not set`),
    });
  };
  return { embedDocuments: async () => fail(), embedQuery: async () => fail() };
}

function requireText(texts: string[]) {
  if (texts.some((text) => text.trim().length === 0)) {
    throw new EmbeddingError('invalid_input', { cause: new Error('Cannot embed empty text') });
  }
}

function isInvalidKeyResponse(error: APICallError): boolean {
  return /API key not valid|API_KEY_INVALID|API key expired/i.test(
    `${error.message} ${error.responseBody ?? ''}`,
  );
}

function toEmbeddingError(error: unknown): EmbeddingError {
  if (error instanceof EmbeddingError) return error;

  const cause = RetryError.isInstance(error) ? error.lastError : error;

  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode;
    if (status === 429) {
      return new EmbeddingError(quotaInfoOf(cause).daily ? 'quota_exhausted' : 'rate_limited', {
        cause,
      });
    }
    if (status === 401 || status === 403 || isInvalidKeyResponse(cause)) {
      return new EmbeddingError('misconfigured', { cause });
    }
    if (status === 400 || status === 413) return new EmbeddingError('invalid_input', { cause });
    return new EmbeddingError('unavailable', { cause });
  }
  if (cause instanceof Error && cause.name === 'TimeoutError') {
    return new EmbeddingError('timeout', { cause });
  }
  if (cause instanceof Error && cause.name === 'AbortError') {
    return new EmbeddingError('cancelled', { cause });
  }
  if (cause instanceof TypeError) return new EmbeddingError('unavailable', { cause });
  return new EmbeddingError('unexpected', { cause });
}
