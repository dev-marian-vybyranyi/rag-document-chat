import type { RetrievalCandidate } from './retrieval.js';

export const RRF_K = 60;

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  filename: string;
  ordinal: number;
  page: number | null;
  content: string;
  score: number;
  vectorScore: number | null;
  vectorRank: number | null;
  keywordScore: number | null;
  keywordRank: number | null;
}

export function fuseRankings(
  vectorResults: RetrievalCandidate[],
  keywordResults: RetrievalCandidate[],
  options: { limit: number; k?: number },
): RetrievedChunk[] {
  const k = options.k ?? RRF_K;
  const byChunk = new Map<string, RetrievedChunk>();

  const addList = (results: RetrievalCandidate[], kind: 'vector' | 'keyword') => {
    results.forEach((candidate, index) => {
      const rank = index + 1;
      const existing = byChunk.get(candidate.chunkId) ?? {
        chunkId: candidate.chunkId,
        documentId: candidate.documentId,
        filename: candidate.filename,
        ordinal: candidate.ordinal,
        page: candidate.page,
        content: candidate.content,
        score: 0,
        vectorScore: null,
        vectorRank: null,
        keywordScore: null,
        keywordRank: null,
      };
      existing.score += 1 / (k + rank);
      if (kind === 'vector') {
        existing.vectorScore = candidate.score;
        existing.vectorRank = rank;
      } else {
        existing.keywordScore = candidate.score;
        existing.keywordRank = rank;
      }
      byChunk.set(candidate.chunkId, existing);
    });
  };

  addList(vectorResults, 'vector');
  addList(keywordResults, 'keyword');

  return [...byChunk.values()].sort(compareFused).slice(0, Math.max(0, options.limit));
}

function compareFused(a: RetrievedChunk, b: RetrievedChunk): number {
  return (
    b.score - a.score ||
    (b.vectorScore ?? -1) - (a.vectorScore ?? -1) ||
    (b.keywordScore ?? -1) - (a.keywordScore ?? -1) ||
    a.documentId.localeCompare(b.documentId) ||
    a.ordinal - b.ordinal
  );
}
