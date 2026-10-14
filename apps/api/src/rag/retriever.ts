import type { Logger } from 'pino';
import { EmbeddingError, type Embedder } from '../ai/embeddings.js';
import { describeJob, detectJobs } from '../career/question-jobs.js';
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
export const BALANCE_PASSAGES = 2;

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
  balanceSides?: boolean;
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
      const {
        candidates = DEFAULT_CANDIDATES,
        limit = DEFAULT_LIMIT,
        documentIds,
        balanceSides = true,
      } = options;
      const base: SearchScope = documentIds ? { documentIds } : {};
      if (query.trim().length === 0) return { chunks: [], mode: 'hybrid' };

      let queryEmbedding: Promise<number[] | null> | undefined;
      const embedQuery = () =>
        (queryEmbedding ??= embedder.embedQuery(query).catch((error: unknown) => {
          if (!(error instanceof EmbeddingError)) throw error;
          logger.warn({ err: error }, 'query embedding failed, using keyword search only');
          return null;
        }));

      const search = async (scope: SearchScope, take = limit): Promise<RetrievalResult> => {
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
          chunks: fuseRankings(vectorResults ?? [], keywordResults, { limit: take }),
          mode: vectorResults === null ? 'keyword-only' : 'hybrid',
        };
      };

      const [facts, jobFacts, resumeId] = await Promise.all([
        store.meetingFacts(userId, base),
        store.jobFacts(userId, base),
        store.resumeId(userId, base),
      ]);
      const everyJobId = jobFacts.map((job) => job.id);

      const withBothSides = async (
        result: RetrievalResult,
        jobIds: string[],
      ): Promise<RetrievalResult> => {
        if (!balanceSides || resumeId === null || jobIds.length === 0) return result;
        const sides = new Set(
          result.chunks.flatMap((chunk) => (chunk.career ? [chunk.career.role] : [])),
        );
        if (sides.size !== 1) return result;
        const missing = sides.has('resume') ? jobIds : [resumeId];
        const extra = await search({ ...base, documentIds: missing }, BALANCE_PASSAGES);
        return { ...result, chunks: [...result.chunks, ...extra.chunks] };
      };

      const detected = detectFilters(query, facts);
      const jobs = detectJobs(query, jobFacts);
      if (!detected && jobs.length === 0) return withBothSides(await search(base), everyJobId);

      const labels = jobs.map(describeJob);
      const filtered = await search({
        ...base,
        ...(detected && { meeting: toMeetingFilter(detected, facts) }),
        ...(jobs.length > 0 && { jobs: jobs.map((job) => job.id) }),
      });
      if (filtered.chunks.length > 0) {
        const named = jobs.length > 0 ? jobs.map((job) => job.id) : everyJobId;
        return {
          ...(await withBothSides(filtered, named)),
          filters: appliedFilters(detected, false, labels),
        };
      }
      const widened = await withBothSides(await search(base), everyJobId);
      return { ...widened, filters: appliedFilters(detected, true, labels) };
    },
  };
}
