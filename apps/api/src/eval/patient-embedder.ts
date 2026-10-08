import { EmbeddingError, type Embedder } from '../ai/embeddings.js';
import { quotaInfoOf } from '../ai/quota.js';

export const DEFAULT_QUERY_PACING_MS = 700;
export const DEFAULT_RATE_LIMIT_RETRIES = 5;
export const DEFAULT_RATE_LIMIT_WAIT_MS = 35_000;

export interface PatienceOptions {
  queryPacingMs?: number;
  rateLimitRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  onWait?: (ms: number) => void;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createPatientEmbedder(embedder: Embedder, options: PatienceOptions = {}): Embedder {
  const {
    queryPacingMs = DEFAULT_QUERY_PACING_MS,
    rateLimitRetries = DEFAULT_RATE_LIMIT_RETRIES,
    sleep = realSleep,
    onWait,
  } = options;
  let lastRequestAt = 0;

  return {
    embedDocuments: (texts, requestOptions) => embedder.embedDocuments(texts, requestOptions),
    async embedQuery(text, requestOptions) {
      for (let attempt = 0; ; attempt++) {
        const sinceLast = Date.now() - lastRequestAt;
        if (sinceLast < queryPacingMs) await sleep(queryPacingMs - sinceLast);
        lastRequestAt = Date.now();
        try {
          return await embedder.embedQuery(text, requestOptions);
        } catch (error) {
          const limited = error instanceof EmbeddingError && error.kind === 'rate_limited';
          if (!limited || attempt >= rateLimitRetries) throw error;
          const wait = (quotaInfoOf(error).retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS) + 1000;
          onWait?.(wait);
          await sleep(wait);
        }
      }
    },
  };
}
