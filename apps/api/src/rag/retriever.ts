import type { Logger } from 'pino';
import { EmbeddingError, type Embedder } from '../ai/embeddings.js';
import { fuseRankings, type RetrievedChunk } from './fusion.js';
import {
  appliedFilters,
  detectFilters,
  toMeetingFilter,
  type AppliedFilters,
} from '../meetings/question-filters.js';
import type { RetrievalCandidate, RetrievalStore, SearchScope } from './retrieval.js';

export const DEFAULT_CANDIDATES = 20;
export const DEFAULT_LIMIT = 6;

export type RetrievalMode = 'hybrid' | 'keyword-only';

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  mode: RetrievalMode;
  filters?: AppliedFilters;
}

export interface RetrieveOptions {
  candidates?: number;
  limit?: number;
  documentIds?: string[];
}

export interface Retriever {
  retrieve(userId: string, query: string, options?: RetrieveOptions): Promise<RetrievalResult>;
}

interface RetrieverDeps {
  store: RetrievalStore;
  embedder: Embedder;
  logger: Logger;
}

export function createRetriever({ store, embedder, logger }: RetrieverDeps): Retriever {
  return {
    async retrieve(userId, query, options = {}) {
      const { candidates = DEFAULT_CANDIDATES, limit = DEFAULT_LIMIT, documentIds } = options;
      const base: SearchScope = documentIds ? { documentIds } : {};
      if (query.trim().length === 0) return { chunks: [], mode: 'hybrid' };

      let queryEmbedding: Promise<number[] | null> | undefined;
      const embedQuery = () =>
        (queryEmbedding ??= embedder.embedQuery(query).catch((error: unknown) => {
          if (!(error instanceof EmbeddingError)) throw error;
          logger.warn({ err: error }, 'query embedding failed, using keyword search only');
          return null;
        }));

      const search = async (scope: SearchScope): Promise<RetrievalResult> => {
        const searchByVector = async (): Promise<RetrievalCandidate[] | null> => {
          const embedding = await embedQuery();
          return embedding === null
            ? null
            : store.vectorSearch(userId, embedding, candidates, scope);
        };
        const [vectorResults, keywordResults] = await Promise.all([
          searchByVector(),
          store.keywordSearch(userId, query, candidates, scope),
        ]);
        return {
          chunks: fuseRankings(vectorResults ?? [], keywordResults, { limit }),
          mode: vectorResults === null ? 'keyword-only' : 'hybrid',
        };
      };

      const facts = await store.meetingFacts(userId, base);
      const detected = detectFilters(query, facts);
      if (!detected) return search(base);

      const filtered = await search({ ...base, meeting: toMeetingFilter(detected, facts) });
      if (filtered.chunks.length > 0) {
        return { ...filtered, filters: appliedFilters(detected, false) };
      }
      return { ...(await search(base)), filters: appliedFilters(detected, true) };
    },
  };
}
