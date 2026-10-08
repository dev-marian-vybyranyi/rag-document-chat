import { createGoogle } from '@ai-sdk/google';
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

export interface EmbedderOptions {
  model: EmbeddingModel;
  dimensions: number;
  maxRetries?: number;
  queryMaxRetries?: number;
  maxParallelCalls?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_QUERY_MAX_RETRIES = 1;
const DEFAULT_MAX_PARALLEL_CALLS = 2;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

export function createEmbedder(options: EmbedderOptions): Embedder {
  const {
    model,
    dimensions,
    maxRetries = DEFAULT_MAX_RETRIES,
    queryMaxRetries = DEFAULT_QUERY_MAX_RETRIES,
    maxParallelCalls = DEFAULT_MAX_PARALLEL_CALLS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const withLimits = (signal?: AbortSignal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  };
  const providerOptions = (taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY') => ({
    google: { outputDimensionality: dimensions, taskType },
  });

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
        const { embeddings } = await embedMany({
          model,
          values: texts,
          maxRetries,
          maxParallelCalls,
          abortSignal: withLimits(signal),
          providerOptions: providerOptions('RETRIEVAL_DOCUMENT'),
        });
        checkVectors(embeddings, texts.length);
        return embeddings;
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
          providerOptions: providerOptions('RETRIEVAL_QUERY'),
        });
        checkVectors([embedding], 1);
        return embedding;
      } catch (error) {
        throw toEmbeddingError(error);
      }
    },
  };
}

export function createGeminiEmbedder(options: {
  apiKey: string;
  modelId: string;
  dimensions: number;
}): Embedder {
  const google = createGoogle({ apiKey: options.apiKey });
  return createEmbedder({
    model: google.embedding(options.modelId),
    dimensions: options.dimensions,
  });
}

export function createUnconfiguredEmbedder(): Embedder {
  const fail = (): never => {
    throw new EmbeddingError('misconfigured', {
      cause: new Error('GOOGLE_GENERATIVE_AI_API_KEY is not set'),
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
