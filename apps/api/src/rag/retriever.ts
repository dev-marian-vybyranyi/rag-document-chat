import type { Logger } from 'pino';
import { EmbeddingError, type Embedder } from '../ai/embeddings.js';
import { fuseRankings, type RetrievedChunk } from './fusion.js';
import type { RetrievalCandidate, RetrievalStore } from './retrieval.js';

export const DEFAULT_CANDIDATES = 20;
export const DEFAULT_LIMIT = 6;

export type RetrievalMode = 'hybrid' | 'keyword-only';

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  mode: RetrievalMode;
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
      const scope = documentIds ? { documentIds } : {};
      if (query.trim().length === 0) return { chunks: [], mode: 'hybrid' };

      const searchByVector = async (): Promise<RetrievalCandidate[] | null> => {
        try {
          const queryEmbedding = await embedder.embedQuery(query);
          return await store.vectorSearch(userId, queryEmbedding, candidates, scope);
        } catch (error) {
          if (!(error instanceof EmbeddingError)) throw error;
          logger.warn({ err: error }, 'query embedding failed, using keyword search only');
          return null;
        }
      };

      const [vectorResults, keywordResults] = await Promise.all([
        searchByVector(),
        store.keywordSearch(userId, query, candidates, scope),
      ]);

      return {
        chunks: fuseRankings(vectorResults ?? [], keywordResults, { limit }),
        mode: vectorResults === null ? 'keyword-only' : 'hybrid',
      };
    },
  };
}
